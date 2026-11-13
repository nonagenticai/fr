// src/services/streams/provisioner.ts
//
// Idempotent provisioning of the Planka resources backing an improvement
// stream (spec §4 Plan 3):
//
//   * One umbrella project per (tenant, kind), e.g. "Continuous Workflow
//     Improvement". Recorded in `tenant_improvement_projects` so a second
//     stream of the same kind reuses the same project.
//   * One board per stream, whose lists are the OWNING tenant's
//     requirements_management `default` board template (a stream has no
//     project type) — services/catalogue/board-template.ts boardSpecFor, the
//     same source the project intake flow uses.
//
// The provisioner takes the minimal subset of `PlankaClient` it calls.

import { boardSpecFor } from '../catalogue/board-template';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { AppError } from '../../utils/errors';
import {
  ensureConveyorMembership,
  type ConveyorMembershipAgent,
} from '../planka/conveyor-membership';
import { ensureWebhookSubscription, type WebhookSubscriptionAgent } from '../planka/webhook-subscription';
import {
  createStream,
  getStreamBySlug,
  getTenantImprovementProject,
  listStreamsByKind,
  upsertTenantImprovementProject,
  type StreamKind,
  type StreamRow,
} from './repository';

// ----- Planka surface -------------------------------------------------------
//
// `PlankaClient` from src/services/planka/index.ts has many resources we
// don't need here. Narrow the contract to what the provisioner actually
// uses.
//
// The shapes mirror the resource methods: `projects.create`, `boards.create`,
// `lists.create`. Return types are intentionally `{ id: string }` — we only
// care about the ids, never the full Planka payload.

interface ProvisionerProjectsApi {
  create(input: {
    name: string;
    description?: string;
    type?: 'private' | 'shared';
  }): Promise<{ id: string }>;
}

interface ProvisionerBoardsApi {
  create(input: {
    projectId: string;
    name: string;
    position?: number;
  }): Promise<{ id: string }>;
  delete(id: string): Promise<void>;
}

interface ProvisionerListsApi {
  create(input: {
    boardId: string;
    name: string;
    position?: number;
  }): Promise<{ id: string }>;
}

interface ProvisionerPlankaClient {
  projects: ProvisionerProjectsApi;
  boards: ProvisionerBoardsApi;
  lists: ProvisionerListsApi;
  members: ConveyorMembershipAgent['members'];
  webhooks: WebhookSubscriptionAgent['webhooks'];
}

// ----- Umbrella projects ---------------------------------------------------

const UMBRELLA_PROJECT_NAMES: Record<StreamKind, string> = {
  workflow: 'Continuous Workflow Improvement',
  prompt: 'Continuous Prompt Improvement',
  // Plan 7 Stage 0a — per-tenant umbrella projects for asset authoring.
  // Names are picked up by ensureUmbrellaProject when getOrCreateAssetStream
  // first hits a (tenant, kind) pair.
  principle: 'Principle Development',
  requirement: 'Requirement Development',
  decision: 'Decision Development',
};

/**
 * Single-kind variant — used by the create-stream route, which only needs
 * the umbrella for the kind it's creating, not both. Avoids issuing two
 * SELECTs and a wasted Planka call for first-time creators.
 *
 * ⚠️ A missing `tenant_improvement_projects` row is NOT proof that no umbrella
 * exists. Migration 038 truncated that table while the streams (and their
 * Planka projects) survived, so a TIP miss used to mint a second, empty
 * "Continuous * Improvement" project beside the live one — the duplicate
 * boards migration 139 repoints away from. On a miss we therefore consult the
 * tenant's active streams of this kind first:
 *   * exactly one distinct planka_project_id → adopt it (record the TIP row,
 *     no Planka call);
 *   * zero → create, as before;
 *   * two or more → ambiguous; do not guess. Create as before and warn, so the
 *     split is visible rather than silently resolved.
 */
export async function ensureUmbrellaProject(
  tenantId: string,
  kind: StreamKind,
  agent: ProvisionerPlankaClient,
): Promise<string> {
  const existing = await getTenantImprovementProject(tenantId, kind);
  if (existing) return existing.planka_project_id;

  const streamProjectIds = new Set(
    (await listStreamsByKind(tenantId, kind))
      .map((s) => s.planka_project_id)
      .filter((id): id is string => id != null),
  );
  if (streamProjectIds.size === 1) {
    const [adopted] = streamProjectIds;
    const row = await upsertTenantImprovementProject(
      tenantId,
      kind,
      adopted!,
    );
    return row.planka_project_id;
  }
  if (streamProjectIds.size > 1) {
    console.warn(
      `[streams.provisioner] tenant=${tenantId} kind=${kind} has no tenant_improvement_projects row and ${streamProjectIds.size} distinct stream planka_project_ids; not adopting any, creating a new umbrella project`,
    );
  }

  const project = await agent.projects.create({
    name: UMBRELLA_PROJECT_NAMES[kind],
    type: 'private',
  });
  const row = await upsertTenantImprovementProject(
    tenantId,
    kind,
    project.id,
  );
  return row.planka_project_id;
}

// ----- Per-stream boards ---------------------------------------------------

interface CreateStreamBoardResult {
  boardId: string;
  /** list name → id, for every list of the tenant's board template. */
  listIds: Record<string, string>;
}

/**
 * Create one Planka board under the given umbrella project, with the lists of
 * the owning tenant's RM `default` board template. Returns the board id and a
 * map of list-name → list-id. No tenant ⇒ no template ⇒ refused before any
 * Planka write (409, fail closed).
 *
 * NOT transactional with respect to Planka — if list creation fails halfway
 * the board exists but is incomplete. Callers (the create-stream route)
 * surface that as a 500 and don't persist a `streams` row, so retrying
 * either creates a fresh board (orphaning the partial one) or, with a
 * caller-side rollback path, deletes it. Wave-1 accepts the orphan; the
 * spec doesn't require atomicity here.
 *
 * Position 65536 mirrors `services/planka/intake.ts` so a board created
 * here sorts identically to one created via the intake flow.
 */
export async function createStreamBoard(
  _streamId: string,
  _kind: StreamKind,
  name: string,
  agent: ProvisionerPlankaClient,
  projectId: string,
  /** Tenant that OWNS the stream board. Only a platform tenant's board gets
   *  the n8n conveyor's Planka user as editor; omitted ⇒ fail closed. */
  tenantId?: string,
): Promise<CreateStreamBoardResult> {
  if (!tenantId) {
    throw new AppError(409, 'a stream board needs its owning tenant to read the board template').withCode(
      'project_tenant_unknown',
    );
  }
  const spec = await boardSpecFor(tenantId, null);
  const board = await agent.boards.create({
    projectId,
    name,
    position: 65536,
  });
  // Never throws; a skip/failure is logged inside (deployment#4397).
  await ensureConveyorMembership(agent, { boardId: board.id, tenantId });
  // Throws: a board no webhook serves never runs a flow (planka/webhook-subscription.ts).
  // The unsubscribed board is torn down first, so a retry does not pile up orphans
  // (the umbrella project is shared per (tenant, kind) and stays).
  try {
    await ensureWebhookSubscription(agent, { boardId: board.id, tenantId });
  } catch (err) {
    try {
      await agent.boards.delete(board.id);
    } catch (undoErr) {
      reportSwallowedFailure(undoErr, {
        service: 'planka',
        method: 'DELETE',
        path: `/api/boards/${board.id}`,
        degradedTo: 'orphan stream board left after a failed webhook subscription',
      });
    }
    throw err;
  }

  const listIds: CreateStreamBoardResult['listIds'] = {};
  for (let i = 0; i < spec.lists.length; i++) {
    const listName = spec.lists[i]!.name;
    const list = await agent.lists.create({
      boardId: board.id,
      name: listName,
      position: (i + 1) * 65536,
    });
    listIds[listName] = list.id;
  }

  return { boardId: board.id, listIds };
}

// ----- Lazy asset-stream provisioning (Plan 7 Stage 0a) -------------------

const ASSET_STREAM_KINDS = ['principle', 'requirement', 'decision'] as const;
type AssetStreamKind = (typeof ASSET_STREAM_KINDS)[number];

const ASSET_STREAM_NAMES: Record<AssetStreamKind, string> = {
  principle: 'Asset Authoring — Principles',
  requirement: 'Asset Authoring — Requirements',
  decision: 'Asset Authoring — Decisions',
};

/**
 * Which pre-existing stream should `getOrCreateAssetStream` ADOPT instead of
 * minting a second one? Pure, so the decision is testable without a database.
 *
 * ⚠️ WHY THIS IS NEEDED AT ALL: a slug miss is NOT proof of absence, because
 * the slug embeds the tenant uuid (`asset-authoring-{kind}-{tenantId}`) and a
 * tenant uuid can be re-keyed under it. Migration 062 moved `streams.tenant_id`
 * from 00000000-…0001 to 0195f48b-…0002 and left every slug alone, so the
 * by-slug lookup missed rows THIS FUNCTION had created and minted a second
 * stream beside each. Measured live 2026-09-11: tenant 0195f48b-…0002 owns two
 * active streams for EACH of decision / principle / requirement — same kind,
 * same tenant, distinct slugs.
 *
 * ⚠️ It is NOT slug duplication: `GROUP BY slug HAVING count(*) > 1` returns
 * ZERO rows. A slug dedupe would find nothing and fix nothing.
 *
 * Two deliberate narrowings:
 *   * `slug` must carry the `asset-authoring-{kind}-` prefix, i.e. only a
 *     stream this function itself could have created is adopted. A stream an
 *     operator created through `POST /api/assets/streams` with its own slug is
 *     left alone, so a tenant deliberately running a second same-kind stream
 *     keeps it.
 *   * oldest wins — `siblings` arrives `created_at ASC` from
 *     `listStreamsByKind`, so the incumbent is adopted rather than whichever
 *     row the planner happened to return first.
 *
 * This stops the duplication RECURRING. It does not remove the three extra rows
 * that already exist — that is a live-data decision, not a code one.
 */
export function pickAdoptableAssetStream(
  siblings: readonly StreamRow[],
  kind: AssetStreamKind,
): StreamRow | undefined {
  const prefix = `asset-authoring-${kind}-`;
  return siblings.find((s) => s.slug?.startsWith(prefix));
}

/**
 * Resolve the asset-authoring stream for `(tenant, kind)`, creating it on
 * first call. Idempotent: re-calls return the existing row without
 * touching Planka.
 *
 * Slug is deterministic — `asset-authoring-{kind}-{tenantId}`. The full
 * tenant UUID is included so two tenants whose UUIDs share a prefix can't
 * collide on slug. Slug uniqueness is anchored by the
 * `streams_slug_unique_per_tenant` index added in migration 050.
 *
 * Steps on a miss:
 *   1. ensureUmbrellaProject — get or create the per-tenant umbrella Planka
 *      project (recorded in `tenant_improvement_projects`)
 *   2. createStreamBoard — board + 6 standard lists
 *   3. createStream — DB row + auto-provision the 8 AA-spec
 *      customFieldGroups (via the inline hook in repository.ts)
 *
 * The customFieldGroup provisioning hook (repository.ts) uses a fresh
 * `PlankaClient.fromConfig()`, independent of the `agent` argument here.
 */

export async function getOrCreateAssetStream(
  tenantId: string,
  kind: AssetStreamKind,
  agent: ProvisionerPlankaClient,
): Promise<StreamRow> {
  const slug = `asset-authoring-${kind}-${tenantId}`;
  const existing = await getStreamBySlug(tenantId, slug);
  if (existing) return existing;

  // A slug MISS is not proof of absence — see pickAdoptableAssetStream.
  const siblings = await listStreamsByKind(tenantId, kind);
  const adoptable = pickAdoptableAssetStream(siblings, kind);
  if (adoptable) return adoptable;

  const projectId = await ensureUmbrellaProject(tenantId, kind, agent);
  const board = await createStreamBoard(
    slug,
    kind,
    ASSET_STREAM_NAMES[kind],
    agent,
    projectId,
    tenantId,
  );

  return createStream(
    {
      tenantId,
      kind,
      name: ASSET_STREAM_NAMES[kind],
      slug,
      plankaProjectId: projectId,
      plankaBoardId: board.boardId,
      thresholdRules: {},
    },
  );
}
