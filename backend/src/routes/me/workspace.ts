// src/routes/me/workspace.ts
//
// GET /api/me/workspace — returns the workspace the caller is CURRENTLY ACTING
// IN. (The is_operator / operator_kind fields went with the three improvement
// tenants, 2026-11-03.)
//
// ⚠️ EFFECTIVE tenant, not the JWT tenant. This endpoint is the only thing that
// tells the frontend which workspace it is showing, and it used to read
// `validateAuth(req).tenantId` — the token claim — while every DATA route on
// the same page scopes by `ctxTenantId()`. Measured in a browser as a
// super-admin with `X-Active-Tenant: <switched>`:
//
//   GET /api/approvals?status=pending  → rows stamped the SWITCHED tenant
//   GET /api/me/workspace              → reported the HOME tenant …0099
//
// so the UI named one workspace while the data came from another. Its sibling
// `GET /api/auth/me` (`routes/auth.ts`) already resolves `tenant_id` through
// `ctxTenantId(user.tenantId)` for exactly this reason; this route was the one
// that was missed, not a deliberate divergence.
//
// ⛔ NOT the `409 tenant_context_conflict` that `routes/assets/kag-reviews.ts`
// answers the same disagreement with, and the difference is the point. That
// proxy refuses because the UPSTREAM (Evidence Review with ENABLE_AUTH on)
// resolves the tenant from the token and IGNORES the forwarded header, so the
// write would land somewhere the UI is not showing and cannot be undone. This
// route has no upstream — it IS the reporter of where fr is, so refusing would
// not prevent a divergence, it would create one: `fetchWorkspaceInfo()`
// (`frontend/src/lib/stores/auth.svelte.ts:433`) fails CLOSED, so a non-200
// leaves `tenant_id: ''` and the switcher reports
// nothing at all.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { canonicalTenantName } from '../../middleware/internal-tenant-only';
import { jsonResponse } from '../../utils/response';

/**
 * Display name for the EFFECTIVE tenant.
 *
 * ⭐ The half of the fix that is easy to omit, and omitting it is WORSE than
 * the original defect: reporting the switched id beside the home tenant's
 * `tenant_name` claim would make the response internally inconsistent, where
 * today it is at least consistently wrong.
 *
 * Two cases, and they are exhaustive for every tenant this endpoint can be
 * asked about:
 *
 *  - **No switch** (`effective === jwt`) — including `X-Active-Tenant` set to
 *    the caller's OWN tenant, which `buildRequestContext` accepts and flags
 *    `'header'` while being no divergence at all, and including the
 *    no-frame / `AUTH_BYPASS` paths where `ctxTenantId` takes its fallback.
 *    The JWT `tenant_name` claim is the right answer and is returned
 *    byte-for-byte as before.
 *  - **Switched** — `middleware/request-context.ts` accepts `X-Active-Tenant`
 *    ONLY for the four reserved internal tenants, the execution tenant, or the
 *    caller's own JWT tenant. The first five are exactly the keys of
 *    `CANONICAL_TENANT_NAMES`, so the constant answers every reachable case
 *    with no query.
 *
 * ⛔ No `workspaces` lookup on purpose. It would add a DB round-trip to an
 * endpoint the SPA hits on every boot in order to cover only the
 * `aa-orchestrator` `X-Tenant-Id` override — an unbounded any-uuid branch used
 * by n8n, which never calls this route. `null` is the honest answer there: the
 * frontend already types `tenant_name` as nullable and
 * `routes/settings/account/+page.svelte:90` falls back to
 * `workspaces.active?.name`. Returning the HOME name for a switched id is the
 * one thing that must not happen.
 */
function resolveTenantName(
  effectiveTenantId: string,
  jwtTenantId: string,
  jwtTenantName: string | null,
): string | null {
  if (effectiveTenantId === jwtTenantId) return jwtTenantName;
  return canonicalTenantName(effectiveTenantId);
}

export async function handleGetMyWorkspace(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  // The JWT claim is still needed — not as the answer, but as the thing the
  // effective tenant is compared against, and as the fallback when there is no
  // request frame (direct handler calls in unit tests, cron, startup).
  const jwtTenantId = user.tenantId;
  const tenantId = ctxTenantId(jwtTenantId);
  const tenantName = resolveTenantName(
    tenantId,
    jwtTenantId,
    user.tenantName ?? null,
  );

  return jsonResponse({
    tenant_id: tenantId,
    tenant_name: tenantName,
  });
}
