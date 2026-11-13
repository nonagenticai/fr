// src/routes/assets/_lib/governed-asset-write-gate.ts
//
// fr-agui SPEC §14 OQ-16 FOLLOW-UPS (George 2026-10-16): "Members edit
// project-owned copies. A member may edit, not only create, the project's own
// copy of a requirement, principle or decision. Tenant-library
// originals stay workspace-admin-only."
//
// ⭐ THE ONE WRITE GATE of the three governed kinds' in-place edit AND delete
// routes (George 2026-10-16: "DELETE gate = PUT gate"):
//
//   PUT|DELETE /api/assets/requirements/:rid
//   PUT|DELETE /api/assets/principles/:pid
//   PUT|DELETE /api/assets/decisions/:did
//
// Every one of them calls `assertGovernedAssetWritable`, so the six can never
// drift apart.
//
// WHO MAY WRITE:
//   1. a workspace-admin of the ACTIVE tenant (`isWorkspaceAdminVia`, the
//      canonical predicate — see routes/assets/requirements.ts's RBAC note);
//   2. a super-admin (platform maintenance of system rows, which
//      `mutateWithSystemUnion` already admits);
//   3. a MEMBER, only when the asset is a PROJECT-OWNED asset of a project the
//      member belongs to (the tenant-member project lane, P1-TEAM-a:
//      `findTenantScopedProject` — the project's tag is the caller's ACTIVE
//      tenant). "Project-owned" means exactly ONE thing (George 2026-10-16,
//      binding): the asset was CREATED inside that project — the upstream
//      row's `origin_project_id` is that project and its `origin_kind` is
//      'project' (requirements_management requirements / principles /
//      decisions — migrations 2026_05_19_0024/0025). `project_assets.edit`'s copy-on-write
//      creates its copies that way.
//      ⛔ An OQ-16 override row (`asset_assignments`, link_kind 'override')
//      does NOT make an asset project-owned. Any project member may POST an
//      override (routes/asset-scope/override.ts), and naming the ORIGINAL as
//      its own candidate used to launder it into a member-writable "copy"
//      (the P2-b override-laundering blocker). The override row says which
//      asset a project USES, never who may write it.
//      ⛔ Being BOUND to that project — even to it alone — does NOT either: any
//      member may bind (routes/assets/bindings.ts; the P2-b bind loophole).
//      Anything else — an unbound (tenant-wide) asset, a bound-only or
//      overridden-only one, another tenant's project — is an ORIGINAL: 403.
//
// ⛔ A licence caller never takes the member arm (it is a tenant's conveyor
//    seat, not a member; the licence allowlist does not route these writes anyway).
// ⛔ The member arm reads the upstream row under the caller's tenant frame
//    (another tenant's row is not served), and the write itself is still made
//    under that frame.
// ⛔ The member arm fails CLOSED: an upstream read that fails (or a row with no
//    `origin_project_id`, or an `origin_kind` other than 'project') admits nothing.
// ⛔ Reads stay member-level — this module gates in-place EDIT and DELETE only.

import { db as defaultDb } from '../../../db/client';
import { isIntegrationError, reportSwallowedFailure } from '../../../integrations/_lib/errors';
import { findTenantScopedProject } from '../../../lib/project-access';
import { isSuperAdmin } from '../../../lib/super-admin-gate';
import { ctxTenantId } from '../../../middleware/request-context';
import { userRolesService as defaultUserRolesService } from '../../../services/user-roles';
import type { User } from '../../../types/api';
import { ForbiddenError } from '../../../utils/errors';

export type GovernedKind = 'requirement' | 'principle' | 'decision';

/** The refusal of a member on an original. Same text as the pre-P2-b requirement gate. */
const GOVERNED_WRITE_REFUSAL = 'workspace-admin role required';
const GOVERNED_WRITE_REFUSAL_CODE = 'project_copy_member_only';

type UserRolesService = typeof defaultUserRolesService;

/** The P1-TEAM-a tenant-member write lane: the project is tagged for the caller's ACTIVE tenant. */
async function isProjectMember(user: User, projectId: string): Promise<boolean> {
  return (await findTenantScopedProject(defaultDb, user, projectId)) !== undefined;
}

/** The fields of the upstream row the gate reads (the caller's tenant frame). */
interface GovernedAssetRow {
  id?: unknown;
  origin_kind?: unknown;
  origin_project_id?: unknown;
}

interface GovernedWriteTarget {
  kind: GovernedKind;
  /**
   * Read the asset's current upstream row (the route's own GET read, under the
   * caller's tenant frame). Called at most once, and only when the member arm
   * is needed — for its `origin_kind` / `origin_project_id`.
   */
  loadRow: () => Promise<GovernedAssetRow>;
  /** The id the asset is addressed by (informational). */
  assetId: string;
  /**
   * The route's own user-roles service. Defaults to the gate's.
   */
  userRoles?: UserRolesService;
}

/** Which arm admitted the write (for tests and logs). */
export type GovernedWriteArm = 'workspace-admin' | 'super-admin' | 'project-origin-member';

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A usable id: a non-blank string, or a number. */
function nonEmpty(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The project an upstream row was CREATED in, or null (fail closed: no origin, or origin_kind not 'project'). */
function createdInProject(row: { origin_kind?: unknown; origin_project_id?: unknown } | null | undefined): string | null {
  if (!row) return null;
  // Every governed kind carries `origin_kind` upstream; an older row that omits
  // it is judged by `origin_project_id` alone (the upstreams' own CHECK lets
  // that be set only when origin_kind is 'project').
  if (row.origin_kind !== undefined && row.origin_kind !== null && row.origin_kind !== 'project') return null;
  return nonEmpty(row.origin_project_id);
}

/**
 * THE definition of "project-owned", for ONE project: the row was created
 * inside `projectId` (`origin_kind` 'project', `origin_project_id` = it).
 * Override rows and bindings play no part (see the header). The PUT/DELETE
 * gate, `project_assets.edit` (in place vs copy-on-write) and the agent's
 * `agent.update_asset` guard all use this, so none can offer an in-place edit
 * the gate would refuse a member — and none can be widened alone.
 */
export function isProjectOwnedAsset(input: { originKind?: unknown; originProjectId: unknown; projectId: string }): boolean {
  const origin = createdInProject({ origin_kind: input.originKind, origin_project_id: input.originProjectId });
  return origin !== null && sameId(origin, input.projectId);
}

/**
 * Throws 403 unless `user` may edit or delete the asset (see the header).
 * Resolves the arm that admitted the write.
 */
export async function assertGovernedAssetWritable(user: User, target: GovernedWriteTarget): Promise<GovernedWriteArm> {
  const tenantId = ctxTenantId(user.tenantId);
  const roles = target.userRoles ?? defaultUserRolesService;
  if (await roles.isWorkspaceAdminVia(user, tenantId, roles.hasRole)) return 'workspace-admin';
  if (isSuperAdmin(user)) return 'super-admin';
  const refuse = (): never => {
    throw new ForbiddenError(GOVERNED_WRITE_REFUSAL).withCode(GOVERNED_WRITE_REFUSAL_CODE);
  };
  if (user.authKind === 'licence' || typeof tenantId !== 'string' || tenantId.trim() === '') refuse();

  // The member arm: created inside a project the caller belongs to.
  let row: GovernedAssetRow | null = null;
  try {
    row = await target.loadRow();
  } catch (err) {
    // Fail CLOSED (no origin ⇒ the member arm admits nothing), and leave a record.
    reportSwallowedFailure(err, {
      service: 'fr',
      method: `governed-asset-write-gate.${target.kind}.origin_read`,
      degradedTo: 'member arm not taken (member refused)',
    });
  }
  const origin = createdInProject(row);
  if (origin !== null && (await isProjectMember(user, origin.toLowerCase()))) return 'project-origin-member';
  return refuse();
}

/**
 * Read a governed asset by the id it is RECORDED by (`asset_assignments.asset_id`)
 * under the caller's tenant frame.
 */
async function loadGovernedById(kind: GovernedKind, id: string): Promise<GovernedAssetRow | undefined> {
  if (kind === 'requirement') return (await import('../../../integrations/requirements')).getRequirement(id) as Promise<GovernedAssetRow>;
  if (kind === 'principle') return (await import('../../../integrations/principles')).getPrinciple(id) as Promise<GovernedAssetRow>;
  return (await import('../../../integrations/decisions')).getDecision(id) as Promise<GovernedAssetRow>;
}

/** 403 for a member naming, as a project's override, an asset that was not created in that project. */
const OVERRIDE_CANDIDATE_REFUSAL =
  'workspace-admin role required: a member may record as the project override only a copy created in that project';

/**
 * The override route's member check (P2-b, George 2026-10-16), defence in depth
 * beside the gate ignoring override rows: a NON-admin may record as project
 * `projectId`'s OQ-16 override of a governed asset only a candidate CREATED in
 * that project. Fails closed — a failed or empty read is a refusal.
 */
export async function assertOverrideCandidateCreatedInProject(kind: GovernedKind, candidateId: string, projectId: string): Promise<void> {
  let row: GovernedAssetRow | undefined;
  try {
    row = await loadGovernedById(kind, candidateId);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr',
      method: `asset-scope.override.${kind}.candidate_read`,
      degradedTo: 'override refused (candidate origin unknown)',
    });
  }
  const origin = createdInProject(row);
  if (origin === null || !sameId(origin, projectId)) {
    throw new ForbiddenError(OVERRIDE_CANDIDATE_REFUSAL).withCode(GOVERNED_WRITE_REFUSAL_CODE);
  }
}

export function isGovernedKind(kind: string): kind is GovernedKind {
  return kind === 'requirement' || kind === 'principle' || kind === 'decision';
}

// ---------------------------------------------------------------------------
// ORIGIN ON A WRITE (P2-b open check, 2026-10-16)
// ---------------------------------------------------------------------------
//
// ⛔ THE UPSTREAM RESETS PROVENANCE ON A PUT THAT OMITS IT. requirements_management's
// `*In` schemas carry `OriginFieldsInMixin` with `origin_kind` DEFAULTING
// to 'tenant' (requirements_management src/schemas/common.py), and it does not keep
// the stored value: rm's `entity_service.update`
// walks the schema's fields and `origin_*` is not in `SERVER_MANAGED_FIELDS`.
// The classic library editor (frontend AssetEditor.svelte) posts only its form
// sections, so every save of a member's project copy through it used to turn
// the copy into a tenant ORIGINAL — and this gate then locked that member out
// of the very asset they had just saved. Preserving it here, on the route,
// covers every caller (editor, AG-UI `project_assets.edit`, any API client).
//
// ⛔ AND A CLIENT MAY NOT SET PROVENANCE IT DOES NOT OWN:
//   - a member (the `project-origin-member` arm) may not change it at all — an
//     origin change is what decides who may write the asset (see `createdInProject`);
//   - nobody may name as `origin_project_id` a project outside their ACTIVE
//     tenant's project lane (`isProjectMember`), on a PUT or a CREATE.

const ORIGIN_FIELDS = ['origin_kind', 'origin_project_id', 'origin_workflow_run_id'] as const;

const ORIGIN_CHANGE_REFUSAL = "a member may not change an asset's provenance (origin_kind / origin_project_id)";
const ORIGIN_CHANGE_REFUSAL_CODE = 'origin_change_forbidden';
const ORIGIN_PROJECT_REFUSAL = 'origin_project_id must name a project you are a member of';
const ORIGIN_PROJECT_REFUSAL_CODE = 'origin_project_not_member';

type OriginRow = GovernedAssetRow & { origin_workflow_run_id?: unknown };

function sendsOrigin(body: Record<string, unknown>): boolean {
  return ORIGIN_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(body, k));
}

/** The (kind, project, run) triple, normalised for comparison. Absent kind = the upstream default 'tenant'. */
function originKey(row: Record<string, unknown>): string {
  const kind = row.origin_kind === undefined || row.origin_kind === null ? 'tenant' : String(row.origin_kind);
  const project = nonEmpty(row.origin_project_id)?.toLowerCase() ?? '';
  const run = nonEmpty(row.origin_workflow_run_id) ?? '';
  return `${kind}|${project}|${run}`;
}

/**
 * 403 unless a body that names `origin_project_id` names a project of the
 * caller's active tenant. Used by the four kinds' CREATE routes (and by
 * `withPreservedOrigin` on a PUT that changes provenance).
 */
export async function assertOriginProjectAssignable(user: User, body: unknown): Promise<void> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const project = nonEmpty((body as Record<string, unknown>).origin_project_id);
  if (project === null) return;
  if (!(await isProjectMember(user, project.toLowerCase()))) {
    throw new ForbiddenError(ORIGIN_PROJECT_REFUSAL).withCode(ORIGIN_PROJECT_REFUSAL_CODE);
  }
}

/**
 * The body to forward on an in-place PUT of a governed asset:
 *   - omits every origin field → the STORED origin is carried forward;
 *   - carries the stored origin unchanged → forwarded as is;
 *   - CHANGES the origin → refused for the member arm; otherwise the new
 *     `origin_project_id` must pass `assertOriginProjectAssignable`.
 * `loadRow` is the route's own read under the caller's tenant frame. A row the
 * caller's frame does not serve (404 — e.g. a system-only row a super-admin
 * writes through the system frame) leaves the body untouched; any other read
 * failure propagates (fail closed: no write on an unknown origin).
 */
export async function withPreservedOrigin<B>(
  user: User,
  arm: GovernedWriteArm,
  body: B,
  loadRow: () => Promise<OriginRow>,
): Promise<B> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as unknown as Record<string, unknown>;
  let stored: OriginRow;
  try {
    stored = await loadRow();
  } catch (err) {
    if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') return body;
    throw err;
  }
  const storedRecord = (stored ?? {}) as Record<string, unknown>;
  if (!sendsOrigin(record)) {
    if (storedRecord.origin_kind === undefined || storedRecord.origin_kind === null) return body;
    const carried: Record<string, unknown> = { ...record };
    for (const k of ORIGIN_FIELDS) carried[k] = storedRecord[k] ?? null;
    return carried as unknown as B;
  }
  if (originKey(record) === originKey(storedRecord)) return body;
  if (arm === 'project-origin-member') {
    throw new ForbiddenError(ORIGIN_CHANGE_REFUSAL).withCode(ORIGIN_CHANGE_REFUSAL_CODE);
  }
  await assertOriginProjectAssignable(user, record);
  return body;
}

/** Memoise a row read so the gate and `withPreservedOrigin` share ONE upstream GET. */
/**
 * G8 / R313 — the project an in-place write of this row is made FOR: the project that
 * CREATED it (`createdInProject`), else undefined (a tenant-level edit, which RM allows
 * for fr only). Sent upstream as `scope_project_id`, so RM's own ownership check
 * (409 `inherited_asset_requires_copy`) backs fr's gate. A failed read ⇒ undefined: the
 * write itself then answers exactly as it did before this field existed.
 */
export async function scopeProjectOf(
  loadRow: () => Promise<{ origin_kind?: unknown; origin_project_id?: unknown } | null | undefined>,
): Promise<string | undefined> {
  try {
    return createdInProject(await loadRow()) ?? undefined;
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr',
      method: 'governed-asset-write-gate.scope_project_read',
      degradedTo: 'write sent without scope_project_id (tenant-level)',
    });
    return undefined;
  }
}

export function onceRow<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
}
