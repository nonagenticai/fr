// src/routes/admin/assets/_lib/gate.ts
//
// Shared authorization gate for the super-admin asset console
// (`/api/admin/assets/*`). Two flavours:
//
//   - `gateReadAsset`: any authenticated user; their X-Active-Tenant
//     header (if present and accepted by the request-context middleware)
//     already pinned the read scope. The route just needs a logged-in user.
//
//   - `gateWriteAsset`: writes against the system tenant require the
//     super-admin allowlist; writes against any other tenant require either
//     super-admin OR a `workspace-admin` row in that tenant.
//
// Read scope when active tenant is NOT the system tenant: the route layer
// is responsible for performing the system-UNION (fetch the user's tenant
// rows AND the system rows; tag each row with `is_system`). See
// `withTenantFrame` below.

import { validateAuth } from '../../../../middleware/auth';
import type { User } from '../../../../types/api';
type AuthedUser = User;
import {
  getRequestContext,
  withRequestContext,
} from '../../../../integrations/_lib/context';
import { isSuperAdmin } from '../../../../lib/super-admin-gate';
import { hasRole, isRealmTenantAdminOf } from '../../../../services/user-roles';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../../middleware/internal-tenant-only';
import { jsonResponse } from '../../../../utils/response';

/**
 * Return shape from the gate. On failure, `response` carries the prebuilt
 * error response; on success, `user` is populated. Routes that need other
 * context can call `getRequestContext()` directly after a success.
 */
export type GateResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; response: Response };

/** Logged-in user check — any tenant. */
export async function gateReadAsset(req: Request): Promise<GateResult> {
  try {
    const user = await validateAuth(req);
    return { ok: true, user };
  } catch (e) {
    const status =
      (e as { status?: number; statusCode?: number }).statusCode ??
      (e as { status?: number }).status ??
      401;
    return { ok: false, response: jsonResponse({ error: 'unauthorized' }, status) };
  }
}

/**
 * Stronger gate for write endpoints. The active tenant (from the request
 * context's `tenantId`, post X-Active-Tenant override) determines the
 * required role:
 *   - system tenant: super-admin allowlist only.
 *   - any other tenant: super-admin OR `user_roles` admin in that tenant.
 *
 * Returns 403 with a stable error code on failure.
 */
export async function gateWriteAsset(req: Request): Promise<GateResult> {
  const read = await gateReadAsset(req);
  if (!read.ok) return read;
  const { user } = read;
  const ctx = getRequestContext();
  const activeTenant = ctx.tenantId;

  if (!activeTenant) {
    return {
      ok: false,
      response: jsonResponse(
        { error: 'no_active_tenant' },
        400,
      ),
    };
  }

  if (activeTenant === INTERNAL_SYSTEM_TENANT_ID) {
    if (!isSuperAdmin(user)) {
      return {
        ok: false,
        response: jsonResponse(
          { error: 'super_admin_only', detail: 'system asset writes are super-admin only' },
          403,
        ),
      };
    }
    return { ok: true, user };
  }

  // Non-system tenant: super-admin OR workspace-admin in this tenant — the
  // latter being a user_roles row OR the Keycloak realm `tenant_admin` role
  // pinned to the raw `tenant_id` claim (services/user-roles.ts).
  if (isSuperAdmin(user)) return { ok: true, user };
  if (isRealmTenantAdminOf(user, activeTenant)) return { ok: true, user };
  const admin = await hasRole(user.id, activeTenant, 'workspace-admin');
  if (admin) return { ok: true, user };
  return {
    ok: false,
    response: jsonResponse(
      { error: 'workspace_admin_required' },
      403,
    ),
  };
}

/**
 * Run `fn` inside a request context whose `tenantId` is overridden to
 * `overrideTenantId`. Used by list endpoints to perform the
 * "<active-tenant rows> ∪ <system rows>" UNION: the second fetch runs
 * under a tenant frame pinned to the system tenant so the http-client
 * forwards X-Tenant-Id=system upstream.
 *
 * Other fields (userId, subjectId, bearerToken) are preserved so upstream
 * services see the same user, only the tenant changes. `activeTenantSource`
 * is marked `'header'` to keep observability honest.
 *
 * ⚠️ `activeTenantVia` is CLEARED, not inherited. The spread would carry the
 * ORIGINAL request's provenance forward onto a tenant that request did not
 * choose: this frame's tenant was pinned SERVER-SIDE by the UNION read, by no
 * header at all. Inheriting would leave a frame claiming header provenance
 * for a tenant no header named. `undefined` is the truthful answer here: no header path produced this tenant. See the
 * `activeTenantVia` docblock in `integrations/_lib/context.ts`.
 *
 * ⚠️ `projectId` is CLEARED too, for the identical reason. `resolveProject`
 * (`lib/project-access.ts`) fill-once `setProjectId`s a GUARD-VALIDATED
 * project id onto whichever frame is live when it runs. If the outer
 * request's frame already carried one — from an earlier resolution against
 * the caller's OWN tenant — the `...ctx` spread would carry it, unvalidated,
 * into this system-tenant clone, where `setProjectId`'s fill-if-empty
 * semantics would then refuse to overwrite it even if a project genuinely
 * resolved inside the union read. That would let a project id validated
 * against one tenant ride an outbound call (`X-Project-Id`, the metering
 * span) made under a DIFFERENT tenant's frame — exactly the cross-tenant
 * class `lib/project-owner-guard.ts` exists to prevent. No caller of
 * `withTenantFrame` sets a project id today (unreachable per the auditor),
 * but that is a property of today's call sites, not of this function;
 * clearing it here makes the leak structurally impossible rather than
 * merely absent.
 *
 * ⚠️ `endUserToken` is CLEARED as well (fr BYO validator D2). It is the
 * caller's verified portal token, admitted onto the frame ONLY because its own
 * `tenant_id` claim equals the ORIGINAL frame's tenant
 * (`middleware/request-context.ts::endUserTokenFromClaims`). Re-pinning the
 * tenant breaks that equality, and the http-client's forwarding check compares
 * against the frame's tenant, not the token's — so inheriting it would forward
 * tenant A's token beside `X-Effective-Tenant-Id: <system>`. No current caller
 * reaches worker_management from inside this frame; clearing it makes that
 * structural rather than a property of today's call sites.
 */
export async function withTenantFrame<T>(
  overrideTenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = getRequestContext();
  return withRequestContext(
    {
      ...ctx,
      tenantId: overrideTenantId,
      activeTenantSource: 'header',
      activeTenantVia: undefined,
      projectId: undefined,
      endUserToken: undefined,
      superAdminSwitchToken: undefined,
    },
    fn,
  );
}
