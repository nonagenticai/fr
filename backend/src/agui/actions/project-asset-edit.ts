/**
 * fr-agui SPEC §13 P2 / OQ-16 (DECIDED a, George 2026-10-14) — editing a
 * governed asset INSIDE a project: `project_assets.edit`.
 *
 * "Copy-on-write: a project-scope override. The tenant original changes only in
 * the tenant UI, and the card states which one is edited."
 *
 * Which asset is edited:
 *
 *   PROJECT-OWNED  THE PUT/DELETE gate's definition (`isProjectOwnedAsset`,
 *                  routes/assets/_lib/governed-asset-write-gate.ts, George
 *                  2026-10-16): the asset was CREATED in this project
 *                  (`origin_kind` 'project', `origin_project_id`) → edited IN PLACE.
 *                  ⛔ Neither a binding to this project (the P2-b bind loophole)
 *                  nor an override row naming it (the override-laundering
 *                  blocker) is ownership — any member may write either.
 *   OVERRIDDEN     this project already holds a project-scope override of it
 *                  (`asset_assignments`, link_kind 'override')
 *                  → the project's COPY is edited in place; the original is not touched.
 *   INHERITED      anything else: bound to no project (a workspace asset every
 *                  project sees), bound to this project only, or shared with
 *                  another project
 *                  → COPY-ON-WRITE: a copy with the edits is created, bound to
 *                  this project, recorded as this project's override of the
 *                  original, and LAST the original is unbound from this project
 *                  if it was bound here. The original is never written.
 *
 * ⭐ THE COPY-ON-WRITE IS IDEMPOTENT AND SERIALISED (audit blocker, P2-a). Its
 * writes span two systems and cannot share a transaction, so it runs under a
 * per-(project, kind, original) CLAIM row (services/project-asset-copy-intents.ts,
 * migration 196), taken BEFORE the upstream create:
 *   * a second editor meanwhile gets 409 `edit_in_progress` — never a second copy;
 *   * the copy is journalled the moment it exists, so a retry after ANY failed
 *     step RESUMES with that copy (never a second one) and re-runs only the
 *     steps not yet done — each step checks its own effect first;
 *   * ORDER makes every partial state safe: the copy is bound and recorded as
 *     the override BEFORE the original is unbound, so the project never loses
 *     the asset; the original is unbound LAST;
 *   * a thrown failure releases the claim (retry resumes at once); a crash is
 *     taken over after the lease. The claim row is deleted on completion.
 * The workspace prerequisites (`workspaces` row, the `owns` parent the override
 * needs) are written FIRST, before anything upstream, so a tenant without a
 * `workspaces` row no longer fails after the copy exists (it used to: 23503).
 *
 * ⭐ Every write is the project shell's own UI route run AS THE HUMAN
 * (`callRouteAsHuman`): create (`POST /api/assets/<kind>s`), update (`PUT …/:id`),
 * bind / unbind (`/api/assets/:kind/:id/bindings…`) and the override
 * (`POST /api/asset-scope/:kind/:id/override`). So each step keeps that route's
 * gate and refusal VERBATIM. The four kinds' PUTs share ONE gate
 * (routes/assets/_lib/governed-asset-write-gate.ts, P2-b, George 2026-10-16):
 * a member edits a PROJECT-OWNED asset (this project's recorded override, or
 * one created in it) of a project they belong to; an original stays
 * workspace-admin only — which is why an inherited asset is copied, never
 * written, and why the "already overridden" edit succeeds for a member. The one
 * non-route writes are the workspace `owns` row the override needs as its
 * parent and that row's own parent, the `workspaces` row (FK), both of which
 * the library list writes lazily "on first sight" anyway
 * (routes/assets/_lib/effective-query.ts: `ensureWorkspace`, then the seed);
 * they are written the same way, in the same order, here — plus the claim row.
 *
 * Kinds: requirement, principle, decision.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { resolvedRbacTenant } from '../rbac';
import { withInvokeCard } from '../capability-invoke-card';
import { AppError } from '../../utils/errors';
import { isProjectOwnedAsset } from '../../routes/assets/_lib/governed-asset-write-gate';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';
import {
  claimCopyIntent,
  clearCopyIntentCreating,
  completeCopyIntent,
  markCopyIntentCreating,
  recordCopyIntentCopy,
  releaseCopyIntent,
  type CopyIntentKey,
} from '../../services/project-asset-copy-intents';

export type EditableKind = 'requirement' | 'principle' | 'decision';

interface KindSpec {
  plural: string;
  load: () => Promise<Record<string, unknown>>;
  get: string;
  create: string;
  update: string;
  /** Fields a copy carries over (the upstream create schema minus lifecycle fields). */
  copy: readonly string[];
  /** Fields an in-place PUT re-sends (the upstream In schema). */
  full: readonly string[];
}

/** Lifecycle / provenance fields a COPY never inherits: it starts a fresh draft of its own. */
const LIFECYCLE = [
  'approved_at',
  'approved_by',
  'published_at',
  'superseded_by',
  'supersedes',
  'stable_key',
  'version',
  'version_notes',
  'version_status',
  'created_by_user_id',
  'origin_kind',
  'origin_workflow_run_id',
  'origin_project_id',
] as const;

const REQ = ['acceptance', 'confidence', 'description', 'effort', 'impact', 'lens_metadata', 'links', 'reach', 'title'] as const;
const PRI = ['active', 'implications', 'rationale', 'statement', 'tags', 'title'] as const;
const DEC = ['alternatives', 'consequences', 'context', 'decision', 'lens_metadata', 'related_principles', 'status', 'title'] as const;
/** The upstream's own (RM) project field: re-sent on an in-place PUT, never copied (a copy is this project's). */
const RM_PROJECT = ['project_id'] as const;

export const KINDS: Readonly<Record<EditableKind, KindSpec>> = {
  requirement: {
    plural: 'requirements',
    load: () => import('../../routes/assets/requirements'),
    get: 'handleGetRequirement',
    create: 'handleCreateRequirement',
    update: 'handleUpdateRequirement',
    copy: REQ,
    full: [...REQ, ...RM_PROJECT, ...LIFECYCLE],
  },
  principle: {
    plural: 'principles',
    load: () => import('../../routes/assets/principles'),
    get: 'handleGetPrinciple',
    create: 'handleCreatePrinciple',
    update: 'handleUpdatePrinciple',
    copy: PRI,
    full: [...PRI, ...LIFECYCLE],
  },
  decision: {
    plural: 'decisions',
    load: () => import('../../routes/assets/decisions'),
    get: 'handleGetDecision',
    create: 'handleCreateDecision',
    update: 'handleUpdateDecision',
    copy: DEC,
    full: [...DEC, ...RM_PROJECT, ...LIFECYCLE],
  },
};

/** The fields `changes` may set: what a copy carries. */
export function editableFields(kind: EditableKind): string[] {
  return [...KINDS[kind].copy];
}

function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

function dataOf(body: unknown): Record<string, unknown> {
  const o = (body ?? {}) as { data?: unknown };
  const d = o.data !== undefined ? o.data : body;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
}

const bindingRoutes = () => import('../../routes/assets/bindings');
const overrideRoutes = () => import('../../routes/asset-scope/override');

/** Every project the asset is bound to (all tenants: a binding the caller cannot see still makes it shared). */
async function boundProjects(kind: EditableKind, bindingId: string): Promise<string[]> {
  const [{ db, assetBindings }, { and, eq }] = await Promise.all([import('../../db/client'), import('drizzle-orm')]);
  const rows = await db
    .select({ project_id: assetBindings.project_id })
    .from(assetBindings)
    .where(and(eq(assetBindings.asset_kind, kind), eq(assetBindings.asset_id, bindingId)));
  return rows.map((r) => r.project_id);
}

/** The asset id this project already overrides `originalId` with, or null. */
async function overrideCandidate(workspaceId: string, kind: EditableKind, originalId: string, projectId: string): Promise<string | null> {
  const { listAssignmentsByScope, listAssignmentsForAsset } = await import('../../services/asset-assignments');
  const parents = new Set((await listAssignmentsForAsset(workspaceId, kind, originalId)).filter((r) => r.link_kind === 'owns').map((r) => r.id));
  if (parents.size === 0) return null;
  const here = await listAssignmentsByScope(workspaceId, kind, 'project', projectId);
  return here.find((r) => r.link_kind === 'override' && r.overrides_id !== null && parents.has(r.overrides_id))?.asset_id ?? null;
}

/**
 * The workspace `owns` row an override needs as its parent — AND, first, the
 * `workspaces` row that row has a FK to. Same order as the library list
 * (routes/assets/_lib/effective-query.ts: `ensureWorkspace` then the seed);
 * without `ensureWorkspace` a tenant with no `workspaces` row failed 23503
 * here. Both idempotent. A concurrent first-sight insert of the workspace
 * (23505) means the row now exists, which is all this needs.
 */
async function ensureWorkspaceOwns(workspaceId: string, workspaceName: string | undefined, kind: EditableKind, originalId: string, by: string): Promise<void> {
  const [{ upsertOwns }, { ensureWorkspace }, { pgErrorCode }] = await Promise.all([
    import('../../services/asset-assignments'),
    import('../../services/workspaces'),
    import('../../utils/errors'),
  ]);
  try {
    await ensureWorkspace(workspaceId, workspaceName?.trim() || workspaceId);
  } catch (err) {
    if (pgErrorCode(err) !== '23505') throw err;
  }
  await upsertOwns(workspaceId, kind, originalId, { scope: 'workspace', by });
}

/**
 * G8 / R313: an inherited requirement / principle / decision is copied by RM itself
 * (`POST /{kind}/{id}/project-copy {project_id, changes}`, idempotent per (original,
 * project)), so fr and the conveyor share ONE copy mechanism. The original is never written.
 */
async function projectCopy(kind: EditableKind, originalId: string, projectId: string, changes: Record<string, unknown>, tenantId: string): Promise<Record<string, unknown>> {
  const body = { project_id: projectId, changes };
  if (kind === 'requirement') return (await (await import('../../integrations/requirements')).projectCopyRequirement(originalId, body, tenantId)) as unknown as Record<string, unknown>;
  if (kind === 'principle') return (await (await import('../../integrations/principles')).projectCopyPrinciple(originalId, body, tenantId)) as unknown as Record<string, unknown>;
  return (await (await import('../../integrations/decisions')).projectCopyDecision(originalId, body, tenantId)) as unknown as Record<string, unknown>;
}

const NAME = 'project_assets.edit';

const inputSchema = z
  .object({
    project_id: z.string().uuid().describe('The project (set from this conversation; never chosen by the model).'),
    kind: z.enum(['requirement', 'principle', 'decision']),
    asset_id: z.string().min(1).max(255).describe('The asset as the project lists it: its id.'),
    changes: z.record(z.unknown()).describe('The fields to change, by upstream field name (see the error for the allowed list).'),
    idempotency_key: z.string().min(1).max(255).optional(),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;

export interface EditResult {
  mode: 'in_place' | 'copy_on_write';
  kind: EditableKind;
  /** The asset that was written. */
  edited_id: string;
  /** The workspace original (copy-on-write and an existing override): never written. */
  original_id?: string;
  /** True when this edit created the project's copy. */
  created_copy?: boolean;
  /** Whether the original was unbound from this project (it was shared here). */
  unbound_original?: boolean;
  item: unknown;
}

async function readAsset(kind: EditableKind, id: string, ctx: ActionContext): Promise<Record<string, unknown>> {
  const k = KINDS[kind];
  return dataOf(
    await callRouteAsHuman(NAME, { method: 'GET', template: `/api/assets/${k.plural}/:id`, handler: lazyRoute(k.load, k.get), params: { id } }, ctx),
  );
}

async function updateAsset(kind: EditableKind, id: string, body: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const k = KINDS[kind];
  return dataOf(
    await callRouteAsHuman(
      NAME,
      { method: 'PUT', template: `/api/assets/${k.plural}/:id`, handler: lazyRoute(k.load, k.update), params: { id }, body },
      ctx,
    ),
  );
}

/**
 * Whether RM's own project-copy (`POST /{kind}/{id}/project-copy`, G8 / R313) can make this
 * copy. RM refuses a CROSS-TENANT original, so an original whose row names a tenant other than
 * the caller's (a platform tenant editing an inherited SYSTEM-tenant principle / decision) keeps
 * fr's PREVIOUS copy path: a fresh create through the kind's own create route, provenance
 * 'project', bound + recorded as the override exactly as before. A row that names no tenant is
 * the caller's.
 */
export function copiesViaRmProjectCopy(original: Record<string, unknown>, workspaceId: string): boolean {
  const t = original.tenant_id;
  if (typeof t !== 'string' || t.trim() === '') return true;
  return sameId(t.trim(), workspaceId);
}

export async function editProjectAsset(input: Input, ctx: ActionContext): Promise<EditResult> {
  const projectId = bound(ctx, NAME);
  const kind = input.kind;
  const allowed = editableFields(kind);
  const unknown = Object.keys(input.changes).filter((k) => !allowed.includes(k));
  if (unknown.length > 0 || Object.keys(input.changes).length === 0) {
    throw new AppError(
      422,
      unknown.length > 0
        ? `${NAME}: ${unknown.join(', ')} cannot be edited on a ${kind}; editable: ${allowed.join(', ')}`
        : `${NAME}: no change given; editable: ${allowed.join(', ')}`,
      { allowed },
    ).withCode('invalid_input');
  }
  const workspaceId = resolvedRbacTenant(ctx);
  if (!workspaceId) throw new AppError(409, 'no workspace is resolved for this session').withCode('tenant_required');

  const original = await readAsset(kind, input.asset_id, ctx);
  const bindingId = input.asset_id;
  if (bindingId === '') throw new AppError(502, `${NAME}: the ${kind} carries no id`).withCode('upstream_shape');
  const k = KINDS[kind];

  // 1. PROJECT-OWNED (the PUT gate's own definition; bindings play no part) → in place.
  const owned = isProjectOwnedAsset({ originKind: original.origin_kind, originProjectId: original.origin_project_id, projectId });
  if (owned) {
    const item = await updateAsset(kind, input.asset_id, { ...pick(original, k.full), ...input.changes }, ctx);
    return { mode: 'in_place', kind, edited_id: input.asset_id, item };
  }

  // Everything past PROJECT-OWNED is serialised per (project, kind, original).
  // Prerequisites FIRST — before anything upstream exists, so their failure
  // leaves nothing behind.
  await ensureWorkspaceOwns(workspaceId, ctx.tenantName, kind, bindingId, ctx.userId);
  const key: CopyIntentKey = { projectId, kind, originalId: bindingId };
  const claim = await claimCopyIntent(key, { workspaceId, by: ctx.userId });
  if (claim === null) {
    throw new AppError(409, `${NAME}: another edit of this ${kind} in this project is in progress; retry shortly`).withCode('edit_in_progress');
  }
  const { token, intent } = claim;
  try {
    // Read UNDER the claim: an edit that completed just before ours is visible here.
    const candidate = await overrideCandidate(workspaceId, kind, bindingId, projectId);

    // 2. OVERRIDDEN (and no copy-on-write of ours in flight): the project's
    //    existing copy is edited; the original is not touched.
    if (candidate !== null && intent.copy_id === null) {
      await completeCopyIntent(key, token);
      const copyRef = candidate;
      const copy = await readAsset(kind, copyRef, ctx);
      const item = await updateAsset(kind, copyRef, { ...pick(copy, k.full), ...input.changes }, ctx);
      return { mode: 'copy_on_write', kind, edited_id: copyRef, original_id: input.asset_id, created_copy: false, item };
    }

    // 3. INHERITED → copy-on-write, fresh or RESUMED. Each step checks its own
    //    effect first, so re-running a half-done one is a no-op.
    const changesKey = canonicalChanges(input.changes);
    let copyId = intent.copy_id;
    let copyRef = intent.copy_ref ?? '';
    let created: Record<string, unknown> | null = null;
    if (copyId === null) {
      const viaRm = copiesViaRmProjectCopy(original, workspaceId);
      // (a) create the copy, and journal it at once.
      // Provenance: created in THIS project. requirements_management's origin
      // CHECK needs origin_kind 'project' beside origin_project_id (its
      // default 'tenant' REJECTS a set origin_project_id — 422).
      const copyBody: Record<string, unknown> = { ...pick(original, k.copy), ...input.changes, origin_kind: 'project', origin_project_id: projectId };
      // RM's project-copy is idempotent per (original, project): a lost answer cannot orphan a copy there.
      if (intent.copy_create_started_at !== null && !viaRm) {
        // An earlier attempt's create never answered: upstream may hold a copy
        // fr never learned the id of. Not closable from fr (the upstream create
        // takes no idempotency key) — recorded, then a copy is made.
        reportSwallowedFailure(new Error(`${NAME}: earlier copy create of ${kind} ${bindingId} in project ${projectId} had no known outcome`), {
          service: 'fr',
          method: `${NAME}.create_copy`,
          degradedTo: 'possible orphan upstream copy (unbound, no override)',
        });
      }
      await markCopyIntentCreating(key, token);
      try {
        created = viaRm
          ? // G8 / R313: RM makes the copy (origin_kind 'project', supersedes the original).
            dataOf(await projectCopy(kind, bindingId, projectId, input.changes, workspaceId))
          : // An original in ANOTHER tenant (RM's project-copy refuses it): fr's own create.
            dataOf(
              await callRouteAsHuman(NAME, { method: 'POST', template: `/api/assets/${k.plural}`, handler: lazyRoute(k.load, k.create), params: {}, body: copyBody }, ctx),
            );
      } catch (err) {
        // The route ANSWERED (an AppError carrying its status): nothing was
        // created upstream. Only a gateway timeout (504) or an unexpected throw
        // leaves the outcome unknown, and keeps the stamp.
        if (err instanceof AppError && err.statusCode !== 504) await clearCopyIntentCreating(key, token);
        throw err;
      }
      copyId = String(created.id ?? '');
      if (copyId === '') throw new AppError(502, `${NAME}: the created copy carries no id`).withCode('upstream_shape');
      copyRef = copyId;
      await recordCopyIntentCopy(key, token, { copyId, copyRef, changesKey });
    }

    // (b) bind the copy here.
    if (!(await boundProjects(kind, copyId)).some((p) => sameId(p, projectId))) {
      await callRouteAsHuman(
        NAME,
        { method: 'POST', template: '/api/assets/:kind/:id/bindings', handler: lazyRoute(bindingRoutes, 'handleBindAsset'), params: { kind, id: copyId }, body: { project_ids: [projectId] } },
        ctx,
      );
    }

    // (c) record it as this project's override of the original.
    if (candidate !== copyId) {
      await callRouteAsHuman(
        NAME,
        {
          method: 'POST',
          template: '/api/asset-scope/:assetType/:assetId/override',
          handler: lazyRoute(overrideRoutes, 'handleOverride'),
          params: { assetType: kind, assetId: bindingId },
          body: { project_id: projectId, candidate_asset_id: copyId },
        },
        ctx,
      );
    }

    // (d) LAST: unbind the original from this project, now that its replacement is bound and recorded.
    const sharedHere = (await boundProjects(kind, bindingId)).some((p) => sameId(p, projectId));
    if (sharedHere) {
      await callRouteAsHuman(
        NAME,
        {
          method: 'DELETE',
          template: '/api/assets/:kind/:id/bindings/:project_id',
          handler: lazyRoute(bindingRoutes, 'handleUnbindAsset'),
          params: { kind, id: bindingId, project_id: projectId },
        },
        ctx,
      );
    }
    await completeCopyIntent(key, token);

    // A RESUMED copy carries the edit that created it; a different edit is applied to it now.
    let item: unknown = created;
    if (created === null) {
      const copy = await readAsset(kind, copyRef, ctx);
      item = intent.copy_changes_key === changesKey ? copy : await updateAsset(kind, copyRef, { ...pick(copy, k.full), ...input.changes }, ctx);
    }
    return {
      mode: 'copy_on_write',
      kind,
      edited_id: copyRef,
      original_id: input.asset_id,
      created_copy: created !== null,
      unbound_original: sharedHere,
      item,
    };
  } catch (err) {
    // Release so a retry resumes at once (a no-op once completed). Never mask the real error.
    // A failed release only delays the retry until the claim's lease expires.
    await releaseCopyIntent(key, token).catch((releaseErr: unknown) =>
      reportSwallowedFailure(releaseErr, { service: 'fr', method: 'project_asset_copy_intents.release', degradedTo: 'claim held until its lease expires' }),
    );
    throw err;
  }
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A stable rendering of `changes` (keys sorted, recursively): equal edits compare equal. */
function canonicalChanges(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((key) => [key, norm((x as Record<string, unknown>)[key])]))
        : x;
  return JSON.stringify(norm(v));
}

export const projectAssetEditAction: AgentCallableAction<Input, EditResult> = {
  name: NAME,
  kind: 'write',
  description:
    "Edit a requirement, principle, decision of THIS project (OQ-16). An asset the project inherits from the workspace " +
    "(or shares with another project) is never changed: fr creates a project copy with the edits (copy-on-write) and records it as " +
    "this project's override; the project's own asset, or its existing copy, is edited in place. The card says which one is edited.",
  input: inputSchema,
  output: z.unknown(),
  // The human's Confirm IS the approval: the sole approver is the initiator, so the
  // confirmed run executes inline (shouldSelfApprove) instead of parking an
  // approval only that same human could grant. A non-human initiator still parks.
  approval: { type: 'single-approver', approver: 'initiator' },
  autoApproveForInitiator: true,
  cronSafe: false,
  rbac: { type: 'project-member' },
  projectParam: 'project_id',
  webOnly: true,
  idempotencyKey: (i) => `${NAME}:${i.project_id}:${i.kind}:${i.asset_id}:${i.idempotency_key ?? JSON.stringify(i.changes)}`,
  handler: editProjectAsset,
};

// ── G8 / R313: REQUEST promotion of this project's copy to the workspace ─────────────
// The agent twin of the UI's "Ask to promote" action (George 10-14: every UI capability is
// an agent tool). It runs the SAME route as the human (`callRouteAsHuman`), so the route's
// gate and refusals apply verbatim. It only RAISES the approval; a tenant admin decides it.
const PROMOTE_NAME = 'project_assets.request_promotion';
const promotionRoutes = () => import('../../routes/asset-scope/promotion-request');

const promoteInputSchema = z
  .object({
    project_id: z.string().uuid().describe('The project (set from this conversation; never chosen by the model).'),
    kind: z.enum(['requirement', 'principle', 'decision']),
    asset_id: z.string().min(1).max(255).describe("The project's COPY (project_assets.edit's edited_id)."),
    original_id: z.string().min(1).max(255).optional().describe('The workspace original, when known.'),
    note: z.string().max(2000).optional().describe('Why the workspace should adopt this version.'),
  })
  .strict();
type PromoteInput = z.infer<typeof promoteInputSchema>;

export async function requestProjectAssetPromotion(input: PromoteInput, ctx: ActionContext): Promise<unknown> {
  bound(ctx, PROMOTE_NAME);
  const body: Record<string, unknown> = {};
  if (input.original_id !== undefined) body.original_id = input.original_id;
  if (input.note !== undefined) body.note = input.note;
  return dataOf(
    await callRouteAsHuman(
      PROMOTE_NAME,
      {
        method: 'POST',
        template: '/api/asset-scope/:assetType/:assetId/promotion-request',
        handler: lazyRoute(promotionRoutes, 'handleRequestAssetPromotion'),
        params: { assetType: input.kind, assetId: input.asset_id },
        body,
      },
      ctx,
    ),
  );
}

export const projectAssetRequestPromotionAction: AgentCallableAction<PromoteInput, unknown> = {
  name: PROMOTE_NAME,
  kind: 'write',
  description:
    "Ask the workspace's tenant admins to promote THIS project's copy of a requirement, principle or decision to the whole " +
    'workspace. Raises one approval per copy (a repeat returns the pending one); only a tenant admin decides it and every ' +
    "member is told. On approval the workspace version takes the copy's content; on rejection the copy stays in this project.",
  input: promoteInputSchema,
  output: z.unknown(),
  approval: { type: 'single-approver', approver: 'initiator' },
  autoApproveForInitiator: true,
  cronSafe: false,
  rbac: { type: 'project-member' },
  projectParam: 'project_id',
  webOnly: true,
  idempotencyKey: (i) => `${PROMOTE_NAME}:${i.project_id}:${i.kind}:${i.asset_id}`,
  handler: requestProjectAssetPromotion,
};

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerProjectAssetEditActions(): void {
  safeRegister(withInvokeCard(projectAssetEditAction));
  safeRegister(withInvokeCard(projectAssetRequestPromotionAction));
}
