// src/routes/decomposition-commit.ts
//
// C1-58 PR 1 — the PM execution-card minter's two fr routes.
//
//   GET  /api/projects/:id/deliverables   the project's APPROVED scope, machine-readable
//   POST /api/decompositions/commit       validate + record + mint one TODO card per deliverable
//
// "APPROVED" HAS NO STATUS COLUMN. A `project_deliverables` row exists only when
// promote ran from an approved `project_outline.approval` (buildApprovedScopeRows
// in routes/project-requests.ts). Row presence IS approval, so an empty list means
// "nothing approved", not "approved and empty".
//
// AUTH / TENANCY — deliberately the POST /api/cards/project path, NOT the
// family-writer gate of routes/decompositions.ts (`requireFamilyWriter` demands a
// workspace-admin or super_admin and would refuse the n8n machine caller that
// drives this): `validateAuth` + `ctxTenantId` + `resolveCardRouteProject` (404 for
// an invisible project, never a leak) + `cardRouteTenantRefusal` (the EXEC pin,
// with the aa-orchestrator cross-tenant exception).
//
// MINTING reuses `createProjectCardFor` — the in-process body of POST
// /api/cards/project — so every card gets the same suppression read, asset_id
// dedupe, create lease, stamps, parent/requires links and rollback. No HTTP
// self-call.
//
// ⛔ NO TRANSACTION OR ADVISORY XACT LOCK IS HELD ACROSS A PLANKA CALL (the fr#1314
// deadlock class: a 2+1 pool where an inner query needs a second connection).
// Order is: ONE short tx {lock project, conflict checks, insert decomposition +
// contracts + deps ON CONFLICT DO NOTHING} → commit → mint each card (each
// idempotent on its `deliv:<deliverable_id>` asset id) → UPDATE card_id. A re-run
// after a partial failure walks the same steps and converges: the tx inserts
// nothing new and every already-minted card comes back from the dedupe.

import { z } from 'zod';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';

import { db } from '../db/client';
import {
  cardContracts,
  contractDependencies,
  decompositions,
  projectDeliverables,
} from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { AppError, NotFoundError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { isUuidShape } from '../lib/uuid-shape';
import { criteriaFromAcceptance, deliverableCoversLink } from '../lib/deliverable-covers';
import type { User } from '../types/api';
import {
  FINDING_FINGERPRINT_PATTERN,
  MAX_REQUIRES_CARD_IDS,
  cardRouteTenantRefusal,
  cardTypeCatalogueRefusal,
  createProjectCardFor,
  resolveCardRouteProject,
} from './cards/project';
import { DELIVERABLE_ASSET_PREFIX } from '../services/improvement-cards/dedup';
import { CardPrioritySchema } from '../services/improvement-cards/request-schema';
import { findPriorityLevel, legacyPriorityText } from '../services/catalogue/priority-levels';
import {
  priorities as catalogueProjectPriorities,
  projectCatalogueTenant,
} from '../services/catalogue/tenant-catalogue';
import {
  VERSION_STAMP_MAX_BYTES,
  versionStampSerialisedBytes,
} from '../services/improvement-cards/version-stamp';

/** Ruling 1 (C1-58): 3..7 customer deliverables, no grouping or splitting. */
export const MIN_DELIVERABLES = 3;
export const MAX_DELIVERABLES = 7;

/** The card asset id AND the contract child_key of one deliverable. */
export function deliverableKey(deliverableId: string): string {
  return `${DELIVERABLE_ASSET_PREFIX}${deliverableId}`;
}

// card_contracts.criteria + covers: ONE shape, lib/deliverable-covers.ts (also
// POST /api/cards/project `deliverable_id`).
export { criteriaFromAcceptance } from '../lib/deliverable-covers';

/**
 * C1-58 D14 — the deterministic Gherkin scenario SKELETON of a minted card:
 * one entry per distinct criterion, 1:1 and in the same order, `scenario_id` =
 * `scn_` + the criterion's own 8 hex. So the id is a pure function of the AC
 * text — identical on every replay and across cards that share a criterion —
 * and R3b keys `ac_coverage.scenario_id` on it. `gherkin: null` /
 * `status: 'pending'`: the scenario TEXT is authored at READY (R4), never here.
 *
 * ⛔ STRUCTURED, NOT card_templates' `validation.gherkin_scenarios` (a string[]
 * of scenario text in the TEMPLATE schema) and not the `Validation.scenario_titles`
 * custom field: this lives at the TOP level of the card's description JSON
 * (= hydration's `card_inputs`), next to `acceptance_criteria`, so neither
 * existing string[] shape is touched.
 */
export interface ScenarioSkeleton {
  scenario_id: string;
  criterion_id: string;
  title: string;
  gherkin: null;
  status: 'pending';
}
export function scenarioSkeleton(
  criteria: ReadonlyArray<{ id: string; text: string }>,
): ScenarioSkeleton[] {
  // One entry per DISTINCT criterion (first occurrence): a repeated AC text is
  // the same crit_ id, and a repeated scn_ id is refused by the strict
  // gherkin_scenarios schema (services/gherkin-scenarios.ts) and by
  // canonical-scenarios-hash v1 ("duplicate scenario_id ⇒ ERROR, never hash"),
  // so mirroring the duplicate would make fr refuse its own mint.
  const seen = new Set<string>();
  const distinct = criteria.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  return distinct.map((c) => ({
    scenario_id: `scn_${c.id.slice('crit_'.length)}`,
    criterion_id: c.id,
    title: c.text,
    gherkin: null,
    status: 'pending' as const,
  }));
}

/**
 * The minted card's description: a raw JSON object, which n8n's
 * activity-card-hydration ("Hydrate Card Fields") parses whole into
 * `card_inputs`. PURE and exported so the exact shape is unit-pinned.
 *
 * `repository_url` is written ONLY when the commit named a `repo` for this
 * child (fr#1332) — it is the `card_inputs.repository_url` scalar hydration's
 * Derive Workspace reads as the card's own repository. Absent ⇒ the key is
 * absent, which is byte-identical to the pre-#1332 description (bar D14's
 * `gherkin_scenarios`), so hydration falls back to the project record as today.
 */
export function mintedCardDescription(input: {
  decompositionId: string;
  deliverable: Pick<DeliverableRow, 'id' | 'kind' | 'title' | 'description' | 'acceptance_criteria'>;
  repositoryUrl?: string;
}): string {
  const d = input.deliverable;
  return JSON.stringify({
    decomposition_id: input.decompositionId,
    deliverable_id: d.id,
    kind: d.kind,
    title: d.title,
    description: d.description,
    acceptance_criteria: d.acceptance_criteria,
    gherkin_scenarios: scenarioSkeleton(criteriaFromAcceptance(d.acceptance_criteria)),
    ...(input.repositoryUrl !== undefined ? { repository_url: input.repositoryUrl } : {}),
  });
}

/** The comparison form for repo membership — the same normalisation hydration's `_canonRepo` applies. */
export function canonRepo(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
}

type DeliverableRow = typeof projectDeliverables.$inferSelect;

async function loadDeliverables(projectId: string): Promise<DeliverableRow[]> {
  return await db
    .select()
    .from(projectDeliverables)
    .where(eq(projectDeliverables.project_id, projectId))
    .orderBy(asc(projectDeliverables.position));
}

/** The machine code of a 404 from either route (`project_not_found`). */
export const PROJECT_NOT_FOUND_CODE = 'project_not_found';

/**
 * Every refusal these two routes RETURN goes out through here, so its machine
 * code is ALSO a top-level `code` — the AppError.withCode convention
 * (utils/errors.ts), which is what a caller branches on (the n8n Fr node's
 * errorUpstreamCode reads `error_code`/`code`/`error.code`, never `error`).
 * Purely additive: `error` and every other field are emitted unchanged.
 * Thrown refusals (the 404) carry it through `withCode` + handleError instead.
 */
export function refusalResponse(
  body: Record<string, unknown> & { error: string },
  status: number,
): Response {
  return jsonResponse({ ...body, code: body.error }, status);
}

/**
 * Shared front door: auth, project visibility (404), EXEC pin (403). Also the
 * front door of POST /api/decompositions/split (routes/decomposition-split.ts).
 */
export async function resolveProjectForCaller(
  user: User,
  activeTenantId: string,
  projectId: string,
): Promise<
  | { project: NonNullable<Awaited<ReturnType<typeof resolveCardRouteProject>>> }
  | { refusal: Response }
> {
  // A non-uuid id would reach Postgres as a uuid cast error (500); it names no
  // project, so it is the same 404 an invisible project gets.
  if (!isUuidShape(projectId)) {
    throw new NotFoundError('Project not found').withCode(PROJECT_NOT_FOUND_CODE);
  }
  const project = await resolveCardRouteProject(user, activeTenantId, projectId);
  if (!project) throw new NotFoundError('Project not found').withCode(PROJECT_NOT_FOUND_CODE);
  // The pin is shared with POST /api/cards/project, whose body stays
  // `{error}`-only; only THIS route's copy gains the top-level `code`.
  const pinned = cardRouteTenantRefusal(user, activeTenantId);
  if (pinned) {
    const pinnedBody = (await pinned.json()) as Record<string, unknown> & { error: string };
    return { refusal: refusalResponse(pinnedBody, pinned.status) };
  }
  return { project };
}

// ── GET /api/projects/:id/deliverables ───────────────────────────────────────

/**
 * 200 {items: [{id, position, kind, title, description, acceptance_criteria,
 *               source_outline_id, repos}], total} — ordered by position.
 *     `repos` (fr#1332): the outline's per-deliverable repo attribution, carried
 *     at promote; null = not attributed.
 * 404 — project absent or not visible under the caller's active tenant
 *       (`code: project_not_found`).
 * 403 — `project_cards_only_on_exec_tenant` (same pin as POST /api/cards/project;
 *       here the body also carries it as `code`).
 */
export async function handleGetProjectDeliverables(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);
  const r = await resolveProjectForCaller(user, activeTenantId, projectId);
  if ('refusal' in r) return r.refusal;

  const rows = await loadDeliverables(r.project.id);
  const items = rows.map((d) => ({
    id: d.id,
    position: d.position,
    kind: d.kind,
    title: d.title,
    description: d.description,
    acceptance_criteria: d.acceptance_criteria,
    source_outline_id: d.source_outline_id,
    // fr#1332 / migration 151: null = not attributed (never `[]`).
    repos: d.repos ?? null,
    // U-PS-COMMIT (migration 169): emitted only on a DEFERRED row, so today's
    // (all-fixed) responses are unchanged. The minters read these.
    ...(d.deferred
      ? { deferred: true, minter: d.minter, minted_at: d.minted_at, minted_count: d.minted_count }
      : {}),
  }));
  return jsonResponse({ items, total: items.length }, 200);
}

// ── POST /api/decompositions/commit ──────────────────────────────────────────

export const CommitDecompositionBody = z.object({
  decomposition_id: z.string().uuid(),
  project_id: z.string().uuid(),
  // The intake card: parent of every minted card and the family's parent.
  parent_card_id: z
    .string()
    .regex(new RegExp(FINDING_FINGERPRINT_PATTERN), 'parent_card_id must be 1..200 printable ASCII'),
  children: z
    .array(
      z.object({
        deliverable_id: z.string().uuid(),
        // Checked against the PROJECT tenant's RM card types AFTER parsing
        // (cardTypeCatalogueRefusal) so a wrong type is a 422
        // card_type_not_in_catalogue with the tenant's list, not a bare zod 400.
        card_type: z.string().min(1).max(200),
        // fr#1332 — OPTIONAL: the ONE repository this child's card works in.
        // Must be one of the deliverable's attributed `repos` (GET
        // /deliverables), else 422 `repo_not_attributed` with nothing
        // recorded. Written as the card's `repository_url` input (description
        // JSON = hydration's card_inputs). Absent ⇒ today's behaviour. Like
        // version_stamp it is per-card data written only on a NEW card, not
        // part of the decomposition identity: a replay never rewrites it.
        repo: z.string().min(1).max(2048).optional(),
        // fr#1397 — OPTIONAL: this child card's Metadata.priority (a tenant RM level, the
        // shared CardPrioritySchema). PER-CHILD, beside card_type and repo,
        // because a priority describes one card, not the whole family. Passed
        // to the in-process minter, which validates and stamps it exactly as
        // POST /api/cards/project does (fr#1394). An invalid value is a 400
        // validation_failed naming `children.<i>.priority` with NOTHING
        // recorded — never stripped (this object is non-strict, so without
        // this key it WAS stripped: a 201 with no priority). Absent ⇒ no
        // priority written. Like repo, it is per-card data written only on a
        // NEW card, not part of the decomposition identity.
        priority: CardPrioritySchema.optional(),
      }),
    )
    .min(1)
    .max(200),
  // B13 (no card is minted without a version stamp) — OPTIONAL, and the SAME
  // field POST /api/cards/project accepts (C1-46): identical zod shape, passed
  // through UNCHANGED to every card this commit mints, where the minter stores
  // it in `card_version_stamps` and points `Metadata.version_stamp` at it.
  // Absent ⇒ nothing is passed and behaviour is identical to before.
  //
  // NOT part of the decomposition's identity: the stamp is per-CARD metadata
  // written only on a NEW card (a dedupe hit writes neither row nor pointer).
  // So a replay of the same decomposition_id with a different stamp is not a
  // decomposition_id_conflict — it returns the existing cards with their
  // ORIGINAL stamps, re-minting and mutating nothing. Only cards created by
  // THAT call (e.g. the remainder after a partial failure) carry its stamp.
  version_stamp: z.record(z.string(), z.unknown()).optional(),
});
type CommitBody = z.infer<typeof CommitDecompositionBody>;

interface PlanRefusal {
  status: 422;
  body: Record<string, unknown> & { error: string };
}

/**
 * Pure validation of a commit against the project's approved deliverables.
 * Returns null when the plan may be recorded, else the 422 body. Every message
 * is COMPUTED from the numbers so the orchestrator can route the intake card to
 * BLOCKED with it verbatim (ruling 1).
 */
export function validateCommitPlan(
  body: Pick<CommitBody, 'children'>,
  deliverables: ReadonlyArray<Pick<DeliverableRow, 'id' | 'kind'> & { deferred?: boolean }>,
): PlanRefusal | null {
  // U-PS-COMMIT (migration 169): a DEFERRED deliverable counts toward the 3..7
  // rule (it IS approved scope) but mints no card here — its minter attaches
  // cards later. So it is neither required nor allowed as a child. With no
  // deferred rows (every row today: the column defaults false) every check
  // below is exactly the pre-169 check.
  const isDeferred = (d: { deferred?: boolean }) => d.deferred === true;
  const mintedNow = deliverables.filter((d) => !isDeferred(d));
  const deliverableCount = deliverables.filter((d) => d.kind === 'deliverable').length;
  if (deliverableCount < MIN_DELIVERABLES || deliverableCount > MAX_DELIVERABLES) {
    return {
      status: 422,
      body: {
        error: 'deliverable_count_out_of_range',
        message: `${deliverableCount} deliverables; revise to ${MIN_DELIVERABLES}-${MAX_DELIVERABLES}`,
        deliverable_count: deliverableCount,
        min: MIN_DELIVERABLES,
        max: MAX_DELIVERABLES,
      },
    };
  }

  const intermediateCount = mintedNow.filter((d) => d.kind === 'intermediate').length;
  if (intermediateCount > MAX_REQUIRES_CARD_IDS) {
    // Every deliverable card requires every intermediate card, and the card
    // spawner caps `requires_card_ids` at MAX_REQUIRES_CARD_IDS.
    return {
      status: 422,
      body: {
        error: 'intermediate_count_out_of_range',
        message: `${intermediateCount} intermediates; at most ${MAX_REQUIRES_CARD_IDS} can be required by a deliverable card`,
        intermediate_count: intermediateCount,
        max: MAX_REQUIRES_CARD_IDS,
      },
    };
  }

  const known = new Set(deliverables.map((d) => d.id));
  const seen = new Map<string, number>();
  for (const c of body.children) seen.set(c.deliverable_id, (seen.get(c.deliverable_id) ?? 0) + 1);

  const unknown = [...seen.keys()].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      status: 422,
      body: {
        error: 'unknown_deliverable',
        message: `${unknown.length} child deliverable_id(s) are not approved deliverables of this project`,
        deliverable_ids: unknown,
      },
    };
  }
  const deferredIds = new Set(deliverables.filter(isDeferred).map((d) => d.id));
  const namedDeferred = [...seen.keys()].filter((id) => deferredIds.has(id));
  if (namedDeferred.length > 0) {
    return {
      status: 422,
      body: {
        error: 'deliverable_deferred',
        message: `${namedDeferred.length} child deliverable(s) are deferred; their minter attaches their cards — they are not minted at commit`,
        deliverable_ids: namedDeferred,
      },
    };
  }
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    return {
      status: 422,
      body: {
        error: 'coverage_duplicate',
        message: `${duplicated.length} deliverable(s) are covered more than once; each must be covered exactly once`,
        deliverable_ids: duplicated,
      },
    };
  }
  const missing = mintedNow.filter((d) => !seen.has(d.id)).map((d) => d.id);
  if (missing.length > 0) {
    return {
      status: 422,
      body: {
        error: 'coverage_incomplete',
        message: `${missing.length} of ${mintedNow.length} approved deliverables have no child; every deliverable must be covered exactly once`,
        deliverable_ids: missing,
      },
    };
  }
  return null;
}

/**
 * fr#1332 — every child that names a `repo` must name one of ITS deliverable's
 * attributed repos (compared on the canonical form hydration uses). A
 * deliverable with no attribution (NULL) admits none. Returns the 422 body, or
 * null with the STORED spelling of each matched repo keyed by deliverable id —
 * that spelling, not the caller's, is what the card is given.
 */
export function validateChildRepos(
  children: ReadonlyArray<{ deliverable_id: string; repo?: string }>,
  deliverables: ReadonlyArray<Pick<DeliverableRow, 'id' | 'repos'>>,
): { refusal: PlanRefusal } | { repoByDeliverable: Map<string, string> } {
  const attributed = new Map(deliverables.map((d) => [d.id, d.repos ?? null]));
  const repoByDeliverable = new Map<string, string>();
  const invalid: Array<{ deliverable_id: string; repo: string; attributed: string[] | null }> = [];
  for (const c of children) {
    if (c.repo === undefined) continue;
    const allowed = attributed.get(c.deliverable_id) ?? null;
    const match = allowed?.find((r) => canonRepo(r) === canonRepo(c.repo as string));
    if (match === undefined) {
      invalid.push({ deliverable_id: c.deliverable_id, repo: c.repo, attributed: allowed });
    } else {
      repoByDeliverable.set(c.deliverable_id, match);
    }
  }
  if (invalid.length > 0) {
    return {
      refusal: {
        status: 422,
        body: {
          error: 'repo_not_attributed',
          message: `${invalid.length} child repo(s) are not among their deliverable's attributed repos; nothing was recorded or minted`,
          invalid,
        },
      },
    };
  }
  return { repoByDeliverable };
}

/**
 * Thrown inside the record tx to roll it back with a 409 body. Extends AppError
 * so the 409 lives on the type: the route below still
 * returns `body` verbatim, and anything that lets it escape gets a 409 from
 * handleError rather than a bare 500.
 */
export class CommitConflict extends AppError {
  constructor(readonly body: Record<string, unknown> & { error: string }) {
    super(409, String(body.error));
    this.name = 'CommitConflict';
    // If it ever escapes the route, handleError still emits the machine code.
    this.withCode(String(body.error));
  }
}

interface ChildPlan {
  deliverable: DeliverableRow;
  childKey: string;
  cardType: string;
}

/**
 * The ONE transaction. Contains no Planka/HTTP call.
 *
 * The advisory xact lock is keyed on the PROJECT so two commits for one
 * project (any decomposition_id, any tenant view of it) serialise their
 * conflict check + insert; it is released at COMMIT, before any mint.
 */
/**
 * The advisory xact-lock key of a project's decomposition record step. ONE key
 * for both the commit and the split route, so a commit and a split on the same
 * project serialise their conflict checks.
 */
export function projectDecompositionLockKey(projectId: string): string {
  return `c158-decomposition-commit:${projectId}`;
}

async function recordDecomposition(input: {
  decompositionId: string;
  tenantId: string;
  projectId: string;
  parentCardId: string;
  plan: ChildPlan[];
}): Promise<Map<string, string | null>> {
  const childKeys = input.plan.map((p) => p.childKey);
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${projectDecompositionLockKey(input.projectId)}))`,
    );

    // A deliverable already contracted in ANOTHER family. child_key is
    // `deliv:<deliverable uuid>`, unique to that deliverable, so this is
    // deliberately NOT tenant-filtered: the project's EXEC owner and the
    // aa-orchestrator acting for its customer tenant see one project and must
    // not each record a family (card_contracts.card_id is UNIQUE — the second
    // family could never bind the cards the dedupe hands back).
    const elsewhere = await tx
      .select({
        family_id: cardContracts.family_id,
        child_key: cardContracts.child_key,
        card_id: cardContracts.card_id,
      })
      .from(cardContracts)
      .where(
        and(inArray(cardContracts.child_key, childKeys), ne(cardContracts.family_id, input.decompositionId)),
      );
    if (elsewhere.length > 0) {
      throw new CommitConflict({
        error: 'deliverables_already_decomposed',
        message: `${elsewhere.length} deliverable(s) already belong to another decomposition; nothing was recorded or minted. Re-commit with that decomposition_id to replay it.`,
        existing_decomposition_ids: [...new Set(elsewhere.map((e) => e.family_id))],
        cards: elsewhere.map((e) => ({ child_key: e.child_key, card_id: e.card_id })),
      });
    }

    await tx
      .insert(decompositions)
      .values({ id: input.decompositionId, tenant_id: input.tenantId, parent_card_id: input.parentCardId })
      .onConflictDoNothing();
    const [family] = await tx
      .select()
      .from(decompositions)
      .where(eq(decompositions.id, input.decompositionId));
    if (!family || family.tenant_id !== input.tenantId || family.parent_card_id !== input.parentCardId) {
      throw new CommitConflict({
        error: 'decomposition_id_conflict',
        message: 'decomposition_id is already recorded for a different tenant or parent card',
        decomposition_id: input.decompositionId,
      });
    }

    await tx
      .insert(cardContracts)
      .values(
        input.plan.map((p) => ({
          tenant_id: input.tenantId,
          family_id: input.decompositionId,
          child_key: p.childKey,
          depth: 1,
          ...deliverableCoversLink(p.deliverable),
        })),
      )
      .onConflictDoNothing({ target: [cardContracts.family_id, cardContracts.child_key] });

    // DEPENDENCY EDGES. The approved scope carries no per-deliverable dependency
    // (project_deliverables has no edge column, and the outline's deliverables
    // say nothing about which intermediate feeds which), so the only edge the
    // data supports is the coarse one: EVERY deliverable requires EVERY
    // intermediate of the same decomposition. Intermediates require nothing.
    const intermediates = input.plan.filter((p) => p.deliverable.kind === 'intermediate');
    const finals = input.plan.filter((p) => p.deliverable.kind === 'deliverable');
    const edges = finals.flatMap((f) =>
      intermediates.map((i) => ({
        family_id: input.decompositionId,
        child_key: f.childKey,
        requires_child_key: i.childKey,
      })),
    );
    if (edges.length > 0) {
      await tx.insert(contractDependencies).values(edges).onConflictDoNothing();
    }

    // A replay (or a racing first commit) with the same id must describe the
    // SAME family: the recorded child set has to equal the requested one.
    const recorded = await tx
      .select({ child_key: cardContracts.child_key, card_id: cardContracts.card_id })
      .from(cardContracts)
      .where(eq(cardContracts.family_id, input.decompositionId));
    const recordedKeys = new Set(recorded.map((r) => r.child_key));
    if (recordedKeys.size !== childKeys.length || childKeys.some((k) => !recordedKeys.has(k))) {
      throw new CommitConflict({
        error: 'decomposition_id_conflict',
        message: `decomposition_id is already recorded with ${recordedKeys.size} different children`,
        decomposition_id: input.decompositionId,
      });
    }
    return new Map(recorded.map((r) => [r.child_key as string, r.card_id]));
  });
}

/**
 * Statuses from the in-process minter (createProjectCardFor) that are a
 * PERMANENT refusal of the input: zod 400, version-stamp 422, list 404, the
 * 403 pin. Surfaced as 422 `mint_refused` (not retryable). Everything else that
 * is not 2xx — 5xx Planka/network failures and the 409 relation-write races —
 * stays the retryable 502 `mint_failed`.
 */
export const MINT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 422]);

/** The outcome of one in-process mint, classified once for every caller. */
export type MintOutcome =
  | { ok: true; cardId: string; created: boolean }
  | { ok: false; response: Response };

/**
 * Classify a `createProjectCardFor` response into a bound card or the route's
 * refusal (`mint_refused` 422 / `mint_failed` 502 / `mint_incomplete` 409).
 * Shared by POST /api/decompositions/commit and /split so the two speak ONE
 * retry contract. `cards` is the caller's already-minted list, echoed back.
 */
export async function classifyMintResponse(
  res: Response,
  ctx: { decompositionId: string; childKey: string; cards: unknown[] },
): Promise<MintOutcome> {
  const out = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const cardId = typeof out?.card_id === 'string' && out.card_id.length > 0 ? out.card_id : null;
  if (MINT_REFUSAL_STATUSES.has(res.status)) {
    // The minter REFUSED this card on its merits (a malformed or out-of-policy
    // create). Retrying the same call re-sends the same input and is refused
    // again, so this must NOT be the retryable 502 below — the orchestrator
    // would loop on it.
    return {
      ok: false,
      response: refusalResponse(
        {
          error: 'mint_refused',
          message: `minting ${ctx.childKey} was refused (${res.status}${
            typeof out?.error === 'string' ? ` ${out.error}` : ''
          }); the decomposition is recorded, but retrying the same call cannot succeed`,
          decomposition_id: ctx.decompositionId,
          child_key: ctx.childKey,
          upstream_status: res.status,
          upstream_error: typeof out?.error === 'string' ? out.error : null,
          upstream_message: typeof out?.message === 'string' ? out.message : null,
          upstream: out,
          cards: ctx.cards,
        },
        422,
      ),
    };
  }
  if (res.status >= 300 || res.status < 200) {
    return {
      ok: false,
      response: refusalResponse(
        {
          error: 'mint_failed',
          message: `minting ${ctx.childKey} failed with ${res.status}; the decomposition is recorded — retry the same call to converge`,
          decomposition_id: ctx.decompositionId,
          child_key: ctx.childKey,
          upstream_status: res.status,
          upstream: out,
          cards: ctx.cards,
        },
        502,
      ),
    };
  }
  if (!cardId) {
    // create_in_progress (another caller holds the create lease) or a
    // suppressed asset: there is no card to bind yet.
    return {
      ok: false,
      response: refusalResponse(
        {
          error: 'mint_incomplete',
          message: `no card id for ${ctx.childKey} yet; retry the same call`,
          decomposition_id: ctx.decompositionId,
          child_key: ctx.childKey,
          upstream: out,
          cards: ctx.cards,
        },
        409,
      ),
    };
  }
  return { ok: true, cardId, created: res.status === 201 };
}

/** Bind a minted card to its contract row (family_id, child_key). */
export async function bindContractCard(
  decompositionId: string,
  childKey: string,
  cardId: string,
): Promise<void> {
  await db
    .update(cardContracts)
    .set({ card_id: cardId, updated_at: new Date() })
    .where(and(eq(cardContracts.family_id, decompositionId), eq(cardContracts.child_key, childKey)));
}

interface MintedCard {
  deliverable_id: string;
  kind: string;
  child_key: string;
  card_type: string;
  card_id: string;
  created: boolean;
}

/**
 * 201 — at least one card was created this call.
 * 200 — replay: every card already existed (0 created), same card ids.
 * Every refusal below carries `code` === its machine code (refusalResponse /
 * withCode); `error` is unchanged.
 * 400 — validation_failed. 404 — project_not_found. 403 — EXEC pin.
 * 422 — version_stamp_too_large (> 64 KiB serialised; nothing recorded).
 * 422 — card_type_not_allowed | deliverable_count_out_of_range |
 *       intermediate_count_out_of_range | unknown_deliverable |
 *       coverage_duplicate | coverage_incomplete | repo_not_attributed
 *       (nothing recorded, nothing minted).
 * 409 — deliverables_already_decomposed | decomposition_id_conflict (nothing
 *       recorded) | mint_incomplete (recorded; a card is still being created
 *       elsewhere — retry the same call).
 * 422 — mint_refused: the family is recorded, but the minter refused a card on
 *       its input (400/403/404/422 inside); NOT retryable as-is.
 * 502 — mint_failed: the family is recorded, a card could not be minted
 *       (upstream/5xx/409 race); retry the same call, it converges.
 */
export async function handleCommitDecomposition(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  let body: CommitBody;
  try {
    body = CommitDecompositionBody.parse(await req.json());
  } catch (e) {
    const issues = e instanceof z.ZodError ? e.issues : [{ message: String(e) }];
    return refusalResponse({ error: 'validation_failed', issues }, 400);
  }

  const r = await resolveProjectForCaller(user, activeTenantId, body.project_id);
  if ('refusal' in r) return r.refusal;
  const project = r.project;

  // The minter's own 64 KiB stamp cap, checked HERE too so an oversized stamp
  // is the same 422 `version_stamp_too_large` with NOTHING recorded — rather
  // than a recorded family whose every mint is then refused (mint_refused).
  if (body.version_stamp !== undefined) {
    const stampBytes = versionStampSerialisedBytes(body.version_stamp);
    if (stampBytes > VERSION_STAMP_MAX_BYTES) {
      return refusalResponse(
        {
          error: 'version_stamp_too_large',
          message:
            `version_stamp is ${stampBytes} bytes serialised (UTF-8 JSON); ` +
            `the limit is ${VERSION_STAMP_MAX_BYTES} bytes. Nothing was recorded or created.`,
          field: 'version_stamp',
          max_bytes: VERSION_STAMP_MAX_BYTES,
          bytes: stampBytes,
        },
        422,
      );
    }
  }

  // Every child card_type must be a card type of the PROJECT's tenant in RM —
  // before anything is recorded or minted.
  const typeRefusal = await cardTypeCatalogueRefusal(
    projectCatalogueTenant(project),
    body.children.map((c) => c.card_type),
  );
  if (typeRefusal) return refusalResponse(typeRefusal.body, typeRefusal.status);

  const deliverables = await loadDeliverables(project.id);
  const refusal = validateCommitPlan(body, deliverables);
  if (refusal) return refusalResponse(refusal.body, refusal.status);
  const repos = validateChildRepos(body.children, deliverables);
  if ('refusal' in repos) return refusalResponse(repos.refusal.body, repos.refusal.status);

  // fr#1397 + design Q3 = b: each child priority must be one of the PROJECT
  // tenant's RM priority levels — refused here, before anything is recorded or
  // minted, naming `children.<i>.priority`. Normalised to the level's legacy
  // text, which the mint writes to Metadata.priority.
  const priorityById = new Map<string, string | undefined>();
  if (body.children.some((c) => c.priority !== undefined)) {
    const levels = await catalogueProjectPriorities(projectCatalogueTenant(project));
    const issues: Array<{ path: Array<string | number>; message: string }> = [];
    body.children.forEach((c, i) => {
      if (c.priority === undefined) return;
      const level = findPriorityLevel(levels, c.priority);
      if (!level) {
        issues.push({
          path: ['children', i, 'priority'],
          message: `not a priority level of this project's tenant (allowed: ${levels.map(legacyPriorityText).join(', ')})`,
        });
        return;
      }
      priorityById.set(c.deliverable_id, legacyPriorityText(level));
    });
    if (issues.length > 0) return refusalResponse({ error: 'validation_failed', issues }, 400);
  }
  const typeById = new Map(body.children.map((c) => [c.deliverable_id, c.card_type]));
  // Position order (loadDeliverables), intermediates FIRST: a deliverable card's
  // `requires_card_ids` names the intermediate cards, so they must exist.
  // U-PS-COMMIT: deferred deliverables are approved scope but get no card here.
  const mintedNow = deliverables.filter((d) => !d.deferred);
  const deferredRows = deliverables.filter((d) => d.deferred);
  const plan: ChildPlan[] = [
    ...mintedNow.filter((d) => d.kind === 'intermediate'),
    ...mintedNow.filter((d) => d.kind === 'deliverable'),
  ].map((d) => ({
    deliverable: d,
    childKey: deliverableKey(d.id),
    cardType: typeById.get(d.id) as string,
  }));

  let bound: Map<string, string | null>;
  try {
    bound = await recordDecomposition({
      decompositionId: body.decomposition_id,
      tenantId: activeTenantId,
      projectId: project.id,
      parentCardId: body.parent_card_id,
      plan,
    });
  } catch (err) {
    if (err instanceof CommitConflict) return refusalResponse(err.body, 409);
    throw err;
  }

  // ── mint (no tx, no lock held) ──
  const minted: MintedCard[] = [];
  const intermediateCardIds: string[] = [];
  for (const p of plan) {
    const isFinal = p.deliverable.kind === 'deliverable';
    const priority = priorityById.get(p.deliverable.id);
    const res = await createProjectCardFor(user, activeTenantId, {
      project_id: project.id,
      card_type: p.cardType,
      card_name: p.deliverable.title.slice(0, 200),
      description: mintedCardDescription({
        decompositionId: body.decomposition_id,
        deliverable: p.deliverable,
        repositoryUrl: repos.repoByDeliverable.get(p.deliverable.id),
      }),
      parent_card_id: body.parent_card_id,
      target_list: 'TODO',
      asset_id: p.childKey,
      ...(isFinal && intermediateCardIds.length > 0
        ? { requires_card_ids: intermediateCardIds }
        : {}),
      ...(body.version_stamp !== undefined ? { version_stamp: body.version_stamp } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
    const outcome = await classifyMintResponse(res, {
      decompositionId: body.decomposition_id,
      childKey: p.childKey,
      cards: minted,
    });
    if (!outcome.ok) return outcome.response;
    const cardId = outcome.cardId;
    if (bound.get(p.childKey) !== cardId) {
      await bindContractCard(body.decomposition_id, p.childKey, cardId);
    }
    if (!isFinal) intermediateCardIds.push(cardId);
    minted.push({
      deliverable_id: p.deliverable.id,
      kind: p.deliverable.kind,
      child_key: p.childKey,
      card_type: p.cardType,
      card_id: cardId,
      created: outcome.created,
    });
  }

  const createdCount = minted.filter((m) => m.created).length;
  return jsonResponse(
    {
      decomposition_id: body.decomposition_id,
      project_id: project.id,
      parent_card_id: body.parent_card_id,
      replayed: createdCount === 0,
      created_count: createdCount,
      cards: minted,
      // Present ONLY when the project has deferred deliverables, so a commit
      // over today's (all-fixed) rows answers byte-identically.
      ...(deferredRows.length > 0
        ? {
            deferred: deferredRows.map((d) => ({
              deliverable_id: d.id,
              kind: d.kind,
              minter: d.minter,
              minted_at: d.minted_at,
              minted_count: d.minted_count,
            })),
          }
        : {}),
    },
    createdCount > 0 ? 201 : 200,
  );
}
