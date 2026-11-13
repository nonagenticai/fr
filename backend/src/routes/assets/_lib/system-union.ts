// src/routes/assets/_lib/system-union.ts
//
// Plan 6 W-1 — shared helper that brings the system-tenant UNION
// pattern (already used by /api/admin/assets/*) to the user-facing
// /api/assets/{principles,requirements,decisions} list
// routes, plus two additive fields per row:
//
//   * is_system: bool             — origin marker (frontend renders
//                                    a badge; future write gates use this
//                                    to refuse edits to inherited rows)
//   * tags: string[]              — pass-through if upstream provided it,
//                                    [] otherwise (manifest tag-filter UI)
//
// ⛔ STRICT TENANT SEPARATION (2026-09-30). fr never reads another tenant's
// frame on a customer's behalf. For a non-system active tenant every READ runs
// ONCE, under the caller's own tenant frame, and the upstream's answer is
// passed through as-is. Inheritance of system rows, if any, is the UPSTREAM's
// decision (e.g. requirements_management returns only PUBLISHED system rows
// under include_system) — fr must never widen it. The previous behaviour called
// upstream a second time pinned to the SYSTEM tenant, where upstream saw the
// system tenant reading its OWN rows and returned everything (DRAFT conveyor
// decisions included), and fr showed that to customer tenants.
//
//   * active === system            → rows under the system frame, all is_system: true
//   * any other active tenant      → rows under the caller's frame only;
//                                    is_system derived from the row's own
//                                    tenant_id (see isSystemRow)

import type { AssetType } from '../../../services/asset-assignments';
import { getRequestContext } from '../../../integrations/_lib/context';
import { withTenantFrame } from '../../admin/assets/_lib/gate';
import {
  INTERNAL_SYSTEM_TENANT_ID,
  isPlatformTenant,
} from '../../../middleware/internal-tenant-only';
import { applyEffectiveFilter } from './effective-query';
import { IntegrationError, isIntegrationError } from '../../../integrations/_lib/errors';
import { isSuperAdmin } from '../../../lib/super-admin-gate';
import { AppError } from '../../../utils/errors';

// Generic row constraint — the upstream service-client types
// (PrincipleOut, RequirementOut, DecisionOut)
// are narrow interfaces without a string index signature, so we can't
// require `Record<string, unknown>`. They all carry an `id`; that's the
// minimum applyEffectiveFilter needs.
export type AssetRowLike = { id: string | number };

export interface EnrichedRow {
  is_system: boolean;
  tags: string[];
}

function readTags(row: AssetRowLike): string[] {
  // Upstream services don't all expose a `tags` column yet — accept
  // either `tags` (canonical) or fall back to `[]`. Coerce non-string
  // entries defensively.
  const raw = (row as { tags?: unknown }).tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  return [];
}

function tag<T extends AssetRowLike>(
  row: T,
  isSystem: boolean,
): T & EnrichedRow {
  return {
    ...row,
    is_system: isSystem,
    tags: readTags(row),
  };
}

/**
 * A row is a system asset when the row ITSELF says it is owned by the system
 * tenant. Never inferred from which frame fr read it under — fr reads only the
 * caller's frame, and the upstream decides what it inherits into that frame.
 */
// PLATFORM_TENANT_IDS / AA_CONVEYOR_TENANT_ID / isPlatformTenant moved to
// middleware/internal-tenant-only.ts (beside INTERNAL_TENANT_IDS, so the three
// tenant sets are read side by side). Re-exported here so existing imports keep
// working — a pure move, the set contents are unchanged.
export {
  AA_CONVEYOR_TENANT_ID,
  PLATFORM_TENANT_IDS,
  isPlatformTenant,
} from '../../../middleware/internal-tenant-only';

/**
 * The upstream call a masked read made: the same `service`/`method`/`path` the
 * http-client received, plus the `detail` string that upstream puts in ITS 404
 * for that route. Built by the integration module that owns the call
 * (`getPrincipleTarget`, ...) from the same URL builder.
 */
export interface UpstreamReadTarget {
  service: string;
  method: string;
  path: string;
  detail: string;
}

/**
 * Each upstream's HTTPException envelope code for a 404. requirements_management
 * main.py `_http_exception_to_response` → `HTTP_<status>`.
 */
const UPSTREAM_404_CODE: Readonly<Record<string, string>> = {
  requirements_management: 'HTTP_404',
};

/**
 * The body the upstream returns for a genuine 404 on `target`. Both services
 * render `{error: {code, message, status, request_id, timestamp}}` in that key
 * order; fr sends no X-Request-ID, so upstream mints a fresh uuid7, and the
 * timestamp is `%Y-%m-%dT%H:%M:%SZ` (second precision, no millis).
 */
/**
 * Upstreams whose 404 body is a FIXED document rather than the
 * `{error:{…}}` envelope above. n8n's Public API answers a missing workflow
 * with `{"message":"not found"}` (MEASURED live 2026-09-30: GET
 * /api/v1/workflows/<unknown> → 404 application/json `{"message":"not found"}`),
 * so `detail` is unused for it. Used by `lib/production-workflows-gate.ts`.
 */
const UPSTREAM_FIXED_404_BODY: Readonly<Record<string, unknown>> = {
  n8n: { message: 'not found' },
};

export function upstreamNotFoundBody(target: UpstreamReadTarget): unknown {
  if (Object.hasOwn(UPSTREAM_FIXED_404_BODY, target.service)) {
    return structuredClone(UPSTREAM_FIXED_404_BODY[target.service]);
  }
  const code = UPSTREAM_404_CODE[target.service];
  if (code === undefined) {
    throw new Error(`no upstream 404 envelope known for service ${target.service}`);
  }
  return {
    error: {
      code,
      message: target.detail,
      status: 404,
      request_id: Bun.randomUUIDv7(),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  };
}

/**
 * The 404 a customer gets for a system-owned row. The ONE construction site —
 * the admin handlers reuse it. The upstream DID serve the row (200); fr masks it
 * as a 404 so a customer cannot learn that a system row exists. It is built
 * field-for-field as `HttpClient.json()` builds the error for that same call
 * returning 404 (code, message `${service} ${method} ${path} returned 404`,
 * service, path, method, upstreamStatus, upstreamBody), so after
 * `integrationErrorResponse` the two responses differ only in the per-request
 * request_id/timestamp values a genuine 404 also varies in.
 */
export function customerNotFoundError(target: UpstreamReadTarget): IntegrationError {
  return new IntegrationError({
    code: 'UPSTREAM_NOT_FOUND',
    message: `${target.service} ${target.method} ${target.path} returned 404`,
    service: target.service,
    path: target.path,
    method: target.method,
    upstreamStatus: 404,
    upstreamBody: upstreamNotFoundBody(target),
  });
}

export function isSystemRow(row: unknown): boolean {
  return (
    row !== null &&
    typeof row === 'object' &&
    (row as { tenant_id?: unknown }).tenant_id === INTERNAL_SYSTEM_TENANT_ID
  );
}

/**
 * Shared list pipeline. Calls `listFn()` exactly ONCE, under the caller's
 * active tenant frame, tags each row (`is_system` from the row's own
 * tenant_id; always true when the active tenant IS the system tenant), then
 * runs `applyEffectiveFilter` so the project-scope rules (Foundation Plan 2
 * §6.2) still apply. It never reads the system frame on a customer's behalf.
 */
export async function listWithSystemUnion<T extends AssetRowLike>(
  user: { tenantId: string; tenantName?: string | null },
  assetType: AssetType,
  projectId: string | undefined,
  listFn: () => Promise<T[]>,
): Promise<Array<T & EnrichedRow>> {
  const ctx = getRequestContext();
  const active = ctx.tenantId ?? user.tenantId;
  const isSystemActive = active === INTERNAL_SYSTEM_TENANT_ID;

  let merged: Array<T & EnrichedRow>;
  if (isSystemActive) {
    const rows = await listFn();
    merged = rows.map((r) => tag(r, true));
  } else {
    // ONE read, the caller's frame. Whatever system rows appear here are the
    // ones the upstream chose to inherit into this tenant (published only);
    // fr passes them through and marks them from their own tenant_id.
    const rows = await listFn();
    // A customer tenant never sees a system-owned row, whatever the upstream
    // returned. Platform tenants keep their inherited rows, tagged.
    const visible = isPlatformTenant(active)
      ? rows
      : rows.filter((r) => !isSystemRow(r));
    merged = visible.map((r) => tag(r, isSystemRow(r)));
  }

  return await applyEffectiveFilter(
    active,
    assetType,
    merged,
    projectId,
    user.tenantName,
  );
}

/**
 * Detail-page sibling of {@link listWithSystemUnion}: ONE `getFn()` call under
 * the caller's active tenant frame.
 *
 *   * active === system       → tag is_system: true
 *   * any other active tenant → tag is_system from the row's own tenant_id
 *                               (isSystemRow). A 404 propagates as a 404 —
 *                               there is NO system-frame fallback: a row the
 *                               upstream does not serve to this tenant does
 *                               not exist for this tenant.
 *   * any upstream error      → re-thrown unchanged
 *
 * Why no `applyEffectiveFilter`: that helper is project-scope row
 * filtering for *lists*. For a single GET the user already navigated to
 * a specific id from a UI that did its own scope filtering on the list
 * call, so the result is by definition in scope.
 */
export async function getWithSystemUnion<T extends AssetRowLike>(
  user: { tenantId: string },
  getFn: () => Promise<T>,
  target: UpstreamReadTarget,
  assetType?: AssetType,
): Promise<T & EnrichedRow> {
  const ctx = getRequestContext();
  const active = ctx.tenantId ?? user.tenantId;
  const isSystemActive = active === INTERNAL_SYSTEM_TENANT_ID;

  if (isSystemActive) {
    const row = await getFn();
    return tag(row, true);
  }

  const row = await getFn();
  if (isSystemRow(row) && !isPlatformTenant(active)) {
    throw customerNotFoundError(target);
  }
  return tag(row, isSystemRow(row));
}

/** Stable machine-readable code for a refused write to a system-tenant asset. */
export const SYSTEM_ASSET_READ_ONLY = 'system_asset_read_only';

/**
 * The 403 a non-super-admin gets for a write that resolves to a SYSTEM-tenant
 * asset. An `AppError`, not an `IntegrationError`: no upstream was contacted
 * and it is not an upstream refusal. `handle()` re-throws non-integration
 * errors, and the server boundary (`utils/errors.ts handleError`) renders it as
 * `403 { error: 'system_asset_read_only', details, code: 'system_asset_read_only' }`
 * — the same flat `{ error: <code> }` shape `gateWriteAsset` uses for
 * `super_admin_only`.
 */
export function systemAssetReadOnlyError(): AppError {
  return new AppError(
    403,
    SYSTEM_ASSET_READ_ONLY,
    'system assets are read-only for workspace users; only a super-admin may edit or delete them',
  ).withCode(SYSTEM_ASSET_READ_ONLY);
}

/**
 * By-id DELETE/UPDATE with the system-asset write gate. Rule (product owner,
 * 2026-09-30: "a customer tenant-admin must NOT be able to edit or delete ANY
 * system-tenant asset"):
 *
 *   * active tenant === system                 → mutate (only a super-admin via
 *                                                X-Active-Tenant or the
 *                                                aa-orchestrator service role
 *                                                reaches this frame)
 *   * non-super-admin (fail-closed at fr):
 *       - pre-read under the CALLER's frame 404s → re-throw that 404 and NEVER
 *                                              call mutateFn (a system row and
 *                                              an absent row are the same 404)
 *       - pre-read says tenant_id === system   → 403 system_asset_read_only
 *       - otherwise mutate under the caller's frame; a 404 is re-thrown as-is.
 *         No system-frame probe: that would reveal a system row the tenant
 *         cannot read.
 *   * super-admin:
 *       - mutate under the caller's frame; on 404 probe the system frame and,
 *         if the row is there, mutate it under the system frame (a super-admin
 *         WRITE, not a customer read); else the original 404.
 *
 * The mutation's own return value passes through untouched — no tagging.
 * (The `ownershipPreRead: false` opt-out existed only for the quality-judge
 * evaluate proxies, removed with RM #238; every caller now pre-reads.)
 */
export async function mutateWithSystemUnion<T>(
  user: { tenantId: string; roles?: readonly string[] },
  fetchFn: () => Promise<{ origin_kind?: string | null; tenant_id?: string | null }>,
  mutateFn: () => Promise<T>,
): Promise<T> {
  const ctx = getRequestContext();
  const active = ctx.tenantId ?? user.tenantId;

  if (active === INTERNAL_SYSTEM_TENANT_ID) {
    return mutateFn();
  }

  // Ownership pre-read under the CALLER's tenant, and it FAILS CLOSED.
  // Since fr#1313 requirements_management never serves a system row to a
  // customer tenant (visibility.py), so for a customer the pre-read of a system
  // row 404s. The old code swallowed that 404 and forwarded the PUT/DELETE
  // upstream anyway (measured in prod 2026-09-30: customer PUT on a system
  // principle → upstream 422), leaving fr's own gate dead and the upstream's
  // `_get_mutable`/RLS as the only fence. A pre-read 404 now ends the request
  // here with that same 404 — a genuine upstream GET 404, the shape
  // `customerNotFoundError` imitates for the read path — so a customer cannot
  // tell "system row" from "no such row", and mutateFn never runs.
  // A row the upstream DOES serve but that is owned by the system tenant (an
  // older/partial upstream) is still refused 403 below.
  if (!isSuperAdmin(user)) {
    // Any pre-read failure — UPSTREAM_NOT_FOUND included — propagates
    // unchanged and mutateFn never runs.
    const row = await fetchFn();
    if (isSystemRow(row)) {
      throw systemAssetReadOnlyError();
    }
  }

  try {
    return await mutateFn();
  } catch (err) {
    if (!isIntegrationError(err) || err.code !== 'UPSTREAM_NOT_FOUND') {
      throw err;
    }
    // The row isn't under the caller's active tenant. A non-super-admin gets
    // the 404 as-is: probing the system frame to choose 403-vs-404 would
    // reveal the existence of a system row this tenant cannot read. (Reached
    // by a non-super-admin only when the pre-read found the row but the write
    // raced a delete.)
    if (!isSuperAdmin(user)) {
      throw err;
    }
    // Super-admin only: probe the system frame; if it isn't there either this
    // is a genuine 404. A super-admin already holds this exact capability on
    // the admin console (`gateWriteAsset` admits super-admin for system-tenant
    // writes), so admitting them here adds no new power, only a second door.
    try {
      await withTenantFrame(INTERNAL_SYSTEM_TENANT_ID, fetchFn);
    } catch {
      throw err;
    }
    return withTenantFrame(INTERNAL_SYSTEM_TENANT_ID, mutateFn);
  }
}
