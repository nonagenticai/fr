// src/routes/assets/bindings.ts
//
// Plan: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase A)
//
// Project-scoped asset bindings. Bindings are the authoritative
// project-scope signal for automation. Empty bindings = tenant-wide,
// out of scope for n8n. Non-empty bindings = in scope on each bound
// project.
//
// Three routes:
//   POST   /api/assets/:kind/:id/bindings
//          body: { project_ids: string[] }
//          → 200 { added: [...], already_bound: [...] }
//
//   DELETE /api/assets/:kind/:id/bindings/:project_id
//          → 204
//
//   GET    /api/projects/:project_id/asset-bindings
//          → { requirement: [ids], principle: [ids], ..., artifact: [ids] }
//
// Auth: validateAuth on every route. The bound_by_user_id column records
// the subject_id. n8n auto-binds (Phase F) go through a separate internal
// endpoint that writes `workflow:<run_id>` instead.
//
// Tenant isolation has TWO orthogonal gates:
//   1. The PROJECT side — every handler scopes its project_id reference(s)
//      to the caller's own tenant via `projectsInTenant` (the #393/#396
//      resolver: departments.workspace_id, falling back to
//      project_data.keycloak_tenant_id for dept-less projects). A
//      cross-tenant or un-attributable project is indistinguishable from a
//      missing one (400/404/empty — no existence leak).
//   2. The ASSET side — `findForeignAssets` rejects an fr-local asset
//      (trigger/channel) that belongs to another tenant. Upstream kinds are
//      deliberately read-path-gated only (no per-id HTTP on the bind hot
//      path); see findForeignAssets.

import { and, eq, inArray } from 'drizzle-orm';

import { validateAuth } from '../../middleware/auth';
import {
  db,
  assetBindings,
  assetType,
  projects,
  departments,
  channels,
  scheduledTriggers,
} from '../../db/client';
import { ctxTenantId } from '../../middleware/request-context';
import { assertProjectNotArchived } from '../../lib/project-live-status';
import { getRequirement } from '../../integrations/requirements';
import { getPrinciple } from '../../integrations/principles';
import { getDecision } from '../../integrations/decisions';
import { isIntegrationError } from '../../integrations/_lib/errors';
import { AppError } from '../../utils/errors';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { isValidUuid } from '../../utils/tenant';

/** Machine-readable code on the 409 a bind of an archived (inactive) asset gets. */
const ASSET_ARCHIVED = 'asset_archived';

/**
 * The upstream read of ONE asset, under the caller's tenant frame — used by the SINGLE bind route
 * only (`handleBindAsset`). `findForeignAssets` deliberately skips upstream kinds because it sits on
 * the bulk project-creation path; one human-rate bind naming one id can afford one GET. A kind with
 * no reader (kag_document, workflow, artifact — the artifact read needs its project) is not checked.
 * `inactive` is the kind's own retired flag: principles `active`.
 */
type UpstreamAssetReader = (id: string) => Promise<{ inactive: boolean }>;
const upstreamReaders: Partial<Record<AssetKind, UpstreamAssetReader>> = {
  requirement: async (id) => (await getRequirement(id), { inactive: false }),
  principle: async (id) => ({ inactive: (await getPrinciple(id)).active === false }),
  decision: async (id) => (await getDecision(id), { inactive: false }),
};

/**
 * Either the root db handle or an open transaction handle. `bulkBindAssets`
 * accepts whichever so it can participate in a caller's transaction
 * (handleCreateProject) or run standalone (handleBindAsset).
 */
type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Single-sourced from the `asset_type` pgEnum (migration 030) — the type of
// the `asset_bindings.asset_kind` COLUMN (migration 067). Never hand-copy the
// member list.
export const ASSET_KINDS = assetType.enumValues;

export type AssetKind = (typeof ASSET_KINDS)[number];

function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * Bulk-insert asset_bindings for the given project. Idempotent — existing
 * rows are silently skipped via the (kind, id, project_id) primary key
 * conflict. Returns the number of input rows after dedup (some of which
 * may have been no-ops on conflict).
 *
 * Used by:
 *   - handleCreateProject — to persist the user's project-creation picker
 *     selections in one round-trip.
 *   - handleInternalCreateAsset (Phase 3) — n8n authoring path.
 *
 * Inputs are NOT validated against upstream services here — tenant
 * isolation is the caller's job via `findForeignAssets` (run before the
 * insert / outside any transaction, since it does network I/O). This
 * function is a pure writer.
 *
 * Pass `executor` (an open transaction) to enrol the insert in a caller's
 * transaction; omit it to run against the root pool.
 */
export async function bulkBindAssets(
  projectId: string,
  boundByUserId: string,
  bindingsByKind: Partial<Record<AssetKind, string[]>>,
  executor: DbExecutor = db,
): Promise<number> {
  const rows: Array<{
    asset_kind: AssetKind;
    asset_id: string;
    project_id: string;
    bound_by_user_id: string;
  }> = [];
  for (const kind of ASSET_KINDS) {
    const ids = bindingsByKind[kind];
    if (!ids || ids.length === 0) continue;
    const unique = Array.from(new Set(ids.filter((id) => id && id.length > 0)));
    for (const id of unique) {
      rows.push({
        asset_kind: kind,
        asset_id: id,
        project_id: projectId,
        bound_by_user_id: boundByUserId,
      });
    }
  }
  if (rows.length === 0) return 0;
  await executor.insert(assetBindings).values(rows).onConflictDoNothing();
  return rows.length;
}

/**
 * Of `projectIds`, the subset whose owning tenant == `tenantId`. Tenant is
 * resolved exactly like the #393/#396 IDOR fixes (scheduled-reports
 * `loadProject` / domain/reporting `projectStatus`): `departments.workspace_id`,
 * falling back to `project_data.keycloak_tenant_id` for dept-less projects
 * (which always carry it in production — stamped by routes/projects.ts).
 *
 * A project in another tenant — or one whose tenant can't be attributed — is
 * simply absent from the returned set, indistinguishable from a missing id.
 * Callers treat "not in the set" as "not found" (400/404/filtered) so
 * cross-tenant existence never leaks. Non-uuid ids are dropped up front.
 */
async function projectsInTenant(
  projectIds: string[],
  tenantId: string,
): Promise<Set<string>> {
  const valid = Array.from(
    new Set(projectIds.filter((id) => isValidUuid(id))),
  );
  if (valid.length === 0) return new Set();
  const rows = await db
    .select({
      id: projects.id,
      deptTenant: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(inArray(projects.id, valid));
  const out = new Set<string>();
  for (const r of rows) {
    const t =
      r.deptTenant ??
      (r.project_data as { keycloak_tenant_id?: string } | null)
        ?.keycloak_tenant_id ??
      null;
    if (t === tenantId) out.add(r.id);
  }
  return out;
}

/**
 * Tenant-isolation check for a set of asset ids. Returns the (kind, id)
 * pairs that are DEFINITIVELY foreign to `tenantId`. A non-empty result
 * means the caller supplied an id that does not belong to their tenant;
 * reject the bind.
 *
 * Scope — only the kinds whose tenant key lives in an fr-local table are
 * verified, because that's a single indexed query with no network I/O:
 *   - trigger  → `scheduled_triggers.tenant_id`
 *   - channel  → `channels.workspace_id` (the workspace IS the tenant,
 *     migration 029)
 *
 * The upstream-service kinds (requirement / principle / decision /
 * artifact / kag_document) and n8n-owned `workflow` are NOT
 * verified here on purpose: a per-id upstream GET would put a blocking,
 * retrying HTTP call on the bind / project-creation hot path and couple
 * it to upstream availability — disproportionate for what is hygiene-grade
 * isolation. Their hard boundary is the read path: every asset list
 * endpoint fetches the tenant-scoped upstream list and intersects it with
 * `asset_bindings`, so a foreign id can never surface as a real asset. A
 * binding row also carries no asset data — only an id the caller already
 * supplied. The picker UI is the practical create-time gate.
 *
 * Non-uuid ids for the local kinds can never match the uuid PK column and
 * are reported foreign.
 */
export async function findForeignAssets(
  bindingsByKind: Partial<Record<AssetKind, string[]>>,
  tenantId: string,
): Promise<Array<{ kind: AssetKind; id: string }>> {
  const foreign: Array<{ kind: AssetKind; id: string }> = [];

  const dedupe = (ids: string[] | undefined): string[] =>
    ids ? Array.from(new Set(ids.filter((id) => id && id.length > 0))) : [];

  // --- fr-local table kinds ---
  const triggerIds = dedupe(bindingsByKind.trigger);
  const validTriggerIds = triggerIds.filter((id) => isValidUuid(id));
  // Non-uuid trigger ids can never match the uuid PK column → foreign.
  for (const id of triggerIds) {
    if (!isValidUuid(id)) foreign.push({ kind: 'trigger', id });
  }
  if (validTriggerIds.length > 0) {
    const rows = await db
      .select({ id: scheduledTriggers.id })
      .from(scheduledTriggers)
      .where(
        and(
          eq(scheduledTriggers.tenant_id, tenantId),
          inArray(scheduledTriggers.id, validTriggerIds),
        ),
      );
    const present = new Set(rows.map((r) => r.id));
    for (const id of validTriggerIds) {
      if (!present.has(id)) foreign.push({ kind: 'trigger', id });
    }
  }

  const channelIds = dedupe(bindingsByKind.channel);
  const validChannelIds = channelIds.filter((id) => isValidUuid(id));
  for (const id of channelIds) {
    if (!isValidUuid(id)) foreign.push({ kind: 'channel', id });
  }
  if (validChannelIds.length > 0) {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspace_id, tenantId),
          inArray(channels.id, validChannelIds),
        ),
      );
    const present = new Set(rows.map((r) => r.id));
    for (const id of validChannelIds) {
      if (!present.has(id)) foreign.push({ kind: 'channel', id });
    }
  }

  return foreign;
}

function badRequest(message: string): Response {
  return jsonResponse({ error: { code: 'BAD_REQUEST', message } }, 400);
}

function notFound(message: string): Response {
  return jsonResponse({ error: { code: 'NOT_FOUND', message } }, 404);
}

/**
 * POST /api/assets/:kind/:id/bindings
 * Body: { project_ids: string[] }
 *
 * Idempotent — projects already bound are returned in `already_bound`,
 * not added again. Unknown projects return 400; an archived target project
 * 409 `project_archived`; an unknown / foreign asset (trigger, channel, and
 * the upstream requirement / principle / decision) 404; an
 * archived channel or an inactive principle 409 `asset_archived`.
 */
export async function handleBindAsset(
  req: Request,
  kind: string,
  assetId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  if (!isAssetKind(kind)) return badRequest(`unknown asset kind: ${kind}`);
  if (!assetId) return badRequest('asset id is required');

  const body = (await req.json().catch(() => null)) as
    | { project_ids?: unknown }
    | null;
  const projectIds = body?.project_ids;
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return badRequest('project_ids: non-empty array required');
  }
  const normalized: string[] = [];
  for (const pid of projectIds) {
    if (typeof pid !== 'string' || !isValidUuid(pid)) {
      return badRequest(`project_ids: invalid uuid "${String(pid)}"`);
    }
    normalized.push(pid);
  }
  const uniquePids = Array.from(new Set(normalized));

  // Verify all referenced projects exist AND belong to the caller's tenant.
  // The FK enforces existence at insert time, but a pre-check produces a clean
  // 400 instead of a 500 and lets us return the offending id. Tenant-scoping
  // it closes the cross-tenant IDOR: a foreign project is reported as
  // "unknown" — the same 400 as a missing one, so existence never leaks.
  const inTenant = await projectsInTenant(uniquePids, ctxTenantId(user.tenantId));
  const missing = uniquePids.filter((p) => !inTenant.has(p));
  if (missing.length > 0) {
    return badRequest(`unknown project_id(s): ${missing.join(', ')}`);
  }

  // A bind is a WRITE on each target project: an archived one is refused
  // 409 `project_archived` (the write-lane convention, fr#1499) — only AFTER the
  // tenant check above, so a foreign / unknown id still gets the 400 (no
  // existence oracle). Nothing is written when any target is archived.
  const targetStatuses = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(inArray(projects.id, uniquePids));
  for (const p of targetStatuses) assertProjectNotArchived(p);

  // Tenant-isolation + existence: an fr-local asset (trigger / channel) that
  // does not exist in the caller's tenant is a 404 — a foreign one is the same
  // 404, so cross-tenant existence never leaks (see findForeignAssets; the
  // upstream kinds stay read-path-gated).
  const foreign = await findForeignAssets({ [kind]: [assetId] }, user.tenantId);
  if (foreign.length > 0) {
    return notFound(`asset ${kind}:${assetId} not found in tenant`);
  }
  // An upstream kind: the asset must exist under the caller's tenant (404 otherwise — the upstream
  // scopes the read, so a foreign id is the same 404), and must not be retired (409). Any other read
  // failure propagates: fail closed, nothing is bound.
  const readUpstream = upstreamReaders[kind];
  if (readUpstream) {
    let found: { inactive: boolean };
    try {
      found = await readUpstream(assetId);
    } catch (err) {
      if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') {
        return notFound(`asset ${kind}:${assetId} not found in tenant`);
      }
      throw err;
    }
    if (found.inactive) {
      throw new AppError(409, `asset_archived: ${kind} ${assetId} is inactive; it cannot be bound`, {
        asset_kind: kind,
        asset_id: assetId,
      }).withCode(ASSET_ARCHIVED);
    }
  }
  // An archived channel (`channels.archived_at` set; hidden from every channel
  // list, channels-registry) is refused 409 `asset_archived`: binding it would
  // scope an asset nobody can see or pick. Triggers have no archived state.
  if (kind === 'channel') {
    const [row] = await db
      .select({ archived_at: channels.archived_at })
      .from(channels)
      .where(eq(channels.id, assetId))
      .limit(1);
    if (row?.archived_at) {
      throw new AppError(409, `asset_archived: channel ${assetId} is archived; it cannot be bound`, {
        asset_kind: kind,
        asset_id: assetId,
      }).withCode(ASSET_ARCHIVED);
    }
  }

  // Find existing bindings to compute (added, already_bound).
  const already = await db
    .select({ project_id: assetBindings.project_id })
    .from(assetBindings)
    .where(
      and(
        eq(assetBindings.asset_kind, kind),
        eq(assetBindings.asset_id, assetId),
        inArray(assetBindings.project_id, uniquePids),
      ),
    );
  const alreadySet = new Set(already.map((r) => r.project_id));
  const toAdd = uniquePids.filter((p) => !alreadySet.has(p));

  if (toAdd.length > 0) {
    await db.insert(assetBindings).values(
      toAdd.map((pid) => ({
        asset_kind: kind,
        asset_id: assetId,
        project_id: pid,
        bound_by_user_id: user.id,
      })),
    );
  }

  return jsonResponse({
    added: toAdd,
    already_bound: Array.from(alreadySet),
  });
}

/**
 * DELETE /api/assets/:kind/:id/bindings/:project_id
 *
 * Idempotent — deleting a non-existent binding returns 204 (no surprise
 * for repeat clicks in the UI).
 */
export async function handleUnbindAsset(
  req: Request,
  kind: string,
  assetId: string,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  if (!isAssetKind(kind)) return badRequest(`unknown asset kind: ${kind}`);
  if (!assetId) return badRequest('asset id is required');
  if (!isValidUuid(projectId)) return badRequest('invalid project_id');

  // Tenant gate: only unbind from a project in the caller's own tenant. A
  // foreign or missing project is a no-op (idempotent 204, no cross-tenant
  // delete) — indistinguishable from "the binding didn't exist", no leak.
  const inTenant = await projectsInTenant([projectId], ctxTenantId(user.tenantId));
  if (inTenant.has(projectId)) {
    await db
      .delete(assetBindings)
      .where(
        and(
          eq(assetBindings.asset_kind, kind),
          eq(assetBindings.asset_id, assetId),
          eq(assetBindings.project_id, projectId),
        ),
      );
  }
  return noContentResponse();
}

/**
 * GET /api/projects/:project_id/asset-bindings
 *
 * Returns bound asset ids grouped by kind. Used by the project workspace
 * tabs and by the kanban setup-card builder (Phase E).
 */
export async function handleListProjectBindings(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  if (!isValidUuid(projectId)) return badRequest('invalid project_id');

  // Tenant gate: a project outside the caller's tenant (or un-attributable)
  // is reported as not found — same 404 as a genuinely missing project, so
  // cross-tenant existence never leaks.
  const inTenant = await projectsInTenant([projectId], ctxTenantId(user.tenantId));
  if (!inTenant.has(projectId)) return notFound('project not found');

  const rows = await db
    .select({
      asset_kind: assetBindings.asset_kind,
      asset_id: assetBindings.asset_id,
    })
    .from(assetBindings)
    .where(eq(assetBindings.project_id, projectId));

  const grouped: Record<AssetKind, string[]> = {
    requirement: [],
    principle: [],
    decision: [],
    kag_document: [],
    workflow: [],
    trigger: [],
    channel: [],
    artifact: [],
  };
  for (const r of rows) {
    grouped[r.asset_kind as AssetKind].push(r.asset_id);
  }
  return jsonResponse({ data: grouped });
}

/**
 * GET /api/assets/:kind/:id/bindings
 *
 * Returns the project ids an asset is currently bound to. Used by the
 * asset detail page bindings list.
 */
export async function handleListAssetBindings(
  req: Request,
  kind: string,
  assetId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  if (!isAssetKind(kind)) return badRequest(`unknown asset kind: ${kind}`);
  if (!assetId) return badRequest('asset id is required');

  const rows = await db
    .select({
      project_id: assetBindings.project_id,
      bound_at: assetBindings.bound_at,
      bound_by_user_id: assetBindings.bound_by_user_id,
    })
    .from(assetBindings)
    .where(
      and(
        eq(assetBindings.asset_kind, kind),
        eq(assetBindings.asset_id, assetId),
      ),
    );

  // Tenant gate: only surface bindings on projects in the caller's own
  // tenant. An asset bound solely to foreign projects returns [] — the
  // cross-tenant binding set never leaks.
  const inTenant = await projectsInTenant(
    rows.map((r) => r.project_id),
    ctxTenantId(user.tenantId),
  );
  return jsonResponse({ data: rows.filter((r) => inTenant.has(r.project_id)) });
}
