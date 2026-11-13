// src/routes/admin/user-roles.ts
//
// POST/DELETE /api/admin/users/:userId/roles — grant and revoke one person's
// role inside one workspace.
//
// `services/user-roles.ts` has carried `grantRole`/`revokeRole` for a long time
// and no route ever reached them, so the only way a `user_roles` row came into
// existence was the provisioning flow. Giving an existing person access to a
// second workspace meant re-provisioning them; taking access away meant a
// hand-written DELETE in postgres. `GET /api/admin/users` renders the grants —
// these two routes are what makes that list editable.
//
// Gated on the `super_admin` Keycloak realm role, like every other route under
// `/api/admin`. A role grant IS the fr access boundary (`assets/_lib/gate.ts`
// resolves through `hasRole`), so anything less than super-admin here would let
// a workspace-admin widen their own reach.

import { z } from 'zod';
import { GrantBody, RevokeParams } from './user-roles-schemas';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { userRolesService } from '../../services/user-roles';
import { adminGetTenant } from '../../services/licenses';
import { isIntegrationError, reportSwallowedFailure } from '../../integrations/_lib/errors';
import { keycloak } from '../../services/keycloak';
import {
  isLiveAdminOf,
  wouldStrandWorkspace,
} from '../../services/last-workspace-admin-guard';
import {
  WorkspaceAdminRevokeBusy,
  withWorkspaceAdminRevokeLock,
  type WorkspaceAdminRevokeTx,
} from '../../services/workspace-admin-revoke-lock';
import { emitSpan } from '../../telemetry/spans';
import type { User } from '../../types/api';
import {
  isTenantAdminWriteThroughEnabled,
  syncTenantAdminGrant,
  syncTenantAdminRevoke,
  type GrantSync,
  type RevokeSync,
} from '../../services/tenant-admin-sync';

// GrantBody / RevokeParams (and their rationale) live in ./user-roles-schemas.ts, side-effect free,
// so the capability declarations describe the same body / query (fr-agui P4c part 2).

/**
 * The ONE DB role that makes its holder a workspace admin (`isWorkspaceAdminVia`).
 * Revoking it can strand a tenant, so it goes through the last-admin guard
 * (fr#1309) and the per-tenant revoke lock (fr#1312). There is no DB-level
 * 'admin' alias: migration 104's CHECK forbids that value.
 */
const DB_ADMIN_ROLE = 'workspace-admin';

type LastAdminCheck = 'ok' | 'strands' | 'unavailable';

/**
 * Would revoking `role` from `userId` in `tenantId` remove the tenant's last
 * live workspace admin? Fails CLOSED: any Keycloak/DB read failure is
 * 'unavailable' (the caller answers 503 and changes nothing).
 *
 * A target that stays admin afterwards (a realm tenant_admin whose realm role
 * this revoke does not touch) cannot strand anyone.
 *
 * `tx` is the revoke lock's transaction (fr#1312): the DB read MUST use it, so
 * one revoke never needs a second pooled connection while holding the lock.
 */
async function checkLastAdmin(
  userId: string,
  tenantId: string,
  role: string,
  tx: WorkspaceAdminRevokeTx | undefined,
): Promise<LastAdminCheck> {
  try {
    const realmIds = await keycloak.listRealmTenantAdminIds(tenantId, { fresh: true });
    const dbAdminIds = await userRolesService.listUsersByRole(tenantId, DB_ADMIN_ROLE, tx);
    // Unless write-through removes the realm role (flag on), this route only
    // deletes the DB row; a realm tenant_admin target then stays admin via
    // Keycloak, so nobody is stranded.
    if (realmIds.includes(userId) && !isTenantAdminWriteThroughEnabled()) return 'ok';
    const strands = await wouldStrandWorkspace({
      targetUserId: userId,
      realmAdminIds: new Set(realmIds),
      dbAdminIds: [...new Set(dbAdminIds ?? [])],
      isLive: (id) => isLiveAdminOf(id, tenantId),
    });
    return strands ? 'strands' : 'ok';
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      path: '/admin/realms/{realm}/users',
      degradedTo: `super-admin ${role} revoke refused (503) for tenant ${tenantId}`,
    });
    return 'unavailable';
  }
}

/**
 * Super-admin gate. Returns the caller, or the response to send instead.
 *
 * `validateAuth` throws on a missing/invalid token; every throw is 401 here
 * because the only thing this route needs from the token is an identity.
 */
async function superAdminOnly(
  req: Request,
): Promise<{ user: User } | { response: Response }> {
  let user: User;
  try {
    user = await validateAuth(req);
  } catch {
    return { response: jsonResponse({ error: 'unauthorized' }, 401) };
  }
  if (!isSuperAdmin(user)) {
    return { response: jsonResponse({ error: 'super-admin only' }, 403) };
  }
  return { user };
}

interface TenantLookup {
  /** The legible workspace name, or null when it could not be resolved. */
  name: string | null;
  /** Non-null when the lookup failed for a reason other than "no such tenant". */
  error: string | null;
  /** True only when licences ANSWERED 404 — the tenant genuinely does not exist. */
  missing: boolean;
}

/**
 * Resolve the workspace name for a tenant id.
 *
 * The 404 and the outage are kept apart on purpose. A 404 from licences is an
 * ANSWER — this tenant does not exist — and the grant must be refused, because
 * a row pointing at no workspace is an access record nobody can act on. Any
 * other failure is not an answer, and `tenant_name` is a display field: refusing
 * the grant because the catalogue was briefly unreachable would take the access
 * console down with it.
 */
async function lookupTenant(tenantId: string): Promise<TenantLookup> {
  try {
    const tenant = await adminGetTenant(tenantId);
    return { name: tenant.name, error: null, missing: false };
  } catch (e) {
    if (isIntegrationError(e) && e.code === 'UPSTREAM_NOT_FOUND') {
      return { name: null, error: null, missing: true };
    }
    return {
      name: null,
      error: e instanceof Error ? e.message : String(e),
      missing: false,
    };
  }
}

/**
 * POST /api/admin/users/:userId/roles — grant `role` in `tenant_id`.
 *
 * 201 for a new grant, 200 for one that already existed. Re-granting is not an
 * error: the console re-posts the whole role set on save, and answering 409
 * would make a no-op look like a failure.
 */
export async function handleGrantUserRole(
  req: Request,
  userId: string,
): Promise<Response> {
  const gate = await superAdminOnly(req);
  if ('response' in gate) return gate.response;
  const actor = gate.user;

  let body: z.infer<typeof GrantBody>;
  try {
    body = GrantBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'invalid request body', details: e.errors }, 422);
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    throw e;
  }

  // The parse rejections above stay outside the span: a 422 is not a grant
  // attempt and would skew the error rate on this operation.
  return emitSpan(
    'fr.admin.user-roles.grant',
    {
      'user.id': actor.id,
      'target.user_id': userId,
      'tenant.id': body.tenant_id,
      'grant.role': body.role,
    },
    async () => {
      const tenant = await lookupTenant(body.tenant_id);
      if (tenant.missing) {
        return jsonResponse(
          { error: 'tenant not found', tenant_id: body.tenant_id },
          404,
        );
      }

      // Ask before writing. `grantRole` is `onConflictDoNothing` and returns
      // void, so after the call there is nothing left to distinguish a fresh
      // grant from a repeat, and 201-for-everything would tell the console it
      // changed something when it did not.
      const existed = await userRolesService.hasRole(
        userId,
        body.tenant_id,
        body.role,
      );
      if (!existed) {
        await userRolesService.grantRole(
          userId,
          body.tenant_id,
          body.role,
          actor.id,
          undefined,
          // Populating `tenant_name` is this route's job. `routes/admin/users.ts`
          // reads the column and nothing in `src/` ever wrote it, so every row
          // in production carries NULL and the access list renders raw UUIDs.
          tenant.name,
        );
      }

      // Keycloak write-through of realm `tenant_admin` (fr#1289). Never throws;
      // the DB grant above stands even on 'failed' — the outcome is reported.
      let keycloakSync: GrantSync | undefined;
      if (body.role === 'workspace-admin') {
        keycloakSync = await syncTenantAdminGrant(userId, body.tenant_id, actor.id);
      }

      return jsonResponse(
        {
          user_id: userId,
          tenant_id: body.tenant_id,
          tenant_name: tenant.name,
          role: body.role,
          created: !existed,
          // Non-null means the grant went through but the workspace name did
          // not. The UI must say so rather than render the row as nameless.
          tenant_lookup_error: tenant.error,
          ...(keycloakSync !== undefined ? { keycloak_sync: keycloakSync } : {}),
        },
        existed ? 200 : 201,
      );
    },
  );
}

/**
 * DELETE /api/admin/users/:userId/roles?tenant_id=…&role=… — revoke one grant.
 *
 * The target rides in the query string, not a body: DELETE-with-body is
 * unevenly supported by proxies and fetch implementations, and this route sits
 * behind cloudflared plus istio.
 */
export async function handleRevokeUserRole(
  req: Request,
  userId: string,
): Promise<Response> {
  const gate = await superAdminOnly(req);
  if ('response' in gate) return gate.response;

  const params = new URL(req.url).searchParams;
  const parsed = RevokeParams.safeParse({
    // `?? undefined` so a missing param reports as "required" rather than as a
    // type error about null.
    tenant_id: params.get('tenant_id') ?? undefined,
    role: params.get('role') ?? undefined,
  });
  if (!parsed.success) {
    return jsonResponse(
      { error: 'invalid query parameters', details: parsed.error.errors },
      422,
    );
  }
  const { tenant_id, role } = parsed.data;

  return emitSpan(
    'fr.admin.user-roles.revoke',
    {
      'user.id': gate.user.id,
      'target.user_id': userId,
      'tenant.id': tenant_id,
      'grant.role': role,
    },
    async () => {
      // `tx` is the revoke lock's transaction when run inside it (fr#1312);
      // every DB read/write below goes through it. A non-admin revoke takes no
      // lock and passes none.
      const revoke = async (tx?: WorkspaceAdminRevokeTx): Promise<Response> => {
        // Last-admin guard (fr#1309) BEFORE any write, whatever the write-through
        // flag says, and with no super-admin override: stranding a tenant is
        // never the intended effect of a single revoke.
        if (role === DB_ADMIN_ROLE) {
          const check = await checkLastAdmin(userId, tenant_id, role, tx);
          if (check === 'unavailable') {
            return jsonResponse(
              {
                error: 'admin_count_unavailable',
                detail:
                  'Could not verify the remaining workspace admins (Keycloak or database unavailable); refusing to revoke until it can be verified. Retry shortly.',
              },
              503,
            );
          }
          if (check === 'strands') {
            return jsonResponse(
              {
                error: 'cannot remove the last workspace admin',
                detail: 'Grant workspace-admin to someone else in this tenant first.',
                user_id: userId,
                tenant_id,
                role,
              },
              409,
            );
          }
        }

        // Keycloak FIRST (fr#1289): if the realm role cannot be removed the DB is
        // left untouched, so fr and Keycloak never disagree in the direction
        // "fr says revoked, Keycloak still grants admin".
        let keycloakSync: RevokeSync | undefined;
        if (role === 'workspace-admin' && isTenantAdminWriteThroughEnabled()) {
          keycloakSync = await syncTenantAdminRevoke(userId, tenant_id, gate.user.id);
          if (keycloakSync === 'failed') {
            return jsonResponse(
              {
                error: 'keycloak_write_failed',
                detail:
                  'Could not remove the tenant_admin realm role in Keycloak; the grant was not revoked. Retry shortly.',
                user_id: userId,
                tenant_id,
                role,
                keycloak_sync: keycloakSync,
              },
              502,
            );
          }
          // 'skipped_user_absent' falls through to the DB delete: a user Keycloak
          // does not know cannot hold tenant_admin (2026-09-30: orphan rows for
          // deleted Keycloak users were unrevocable behind a 502).
          // refused_composite / skipped_super_admin: the target keeps
          // `tenant_admin` for THIS tenant via a composite, group or super_admin
          // (sync only returns these when their tenant_id == tenant_id). Deleting
          // the DB row would report a revoke while the realm arm still admits
          // them — refuse, exactly as the workspace members route does.
          if (keycloakSync === 'refused_composite' || keycloakSync === 'skipped_super_admin') {
            return jsonResponse(
              {
                error: 'super_admin_implies_tenant_admin',
                detail:
                  'This user holds tenant_admin for this tenant through super_admin or a composite/group role; remove that in Keycloak first.',
                user_id: userId,
                tenant_id,
                role,
                keycloak_sync: keycloakSync,
              },
              409,
            );
          }
        }

        // `revokeRole` returns nothing and treats a missing row as a no-op, so it
        // cannot tell "revoked" from "was never there". Without this read every
        // revoke would answer 204 and the console would report removing access
        // that some other operator had already removed.
        const had = await userRolesService.hasRole(userId, tenant_id, role, tx);
        if (!had) {
          // Keycloak may have just removed a realm-only admin: that IS a revoke.
          if (keycloakSync === 'removed') {
            return jsonResponse({ user_id: userId, tenant_id, role, keycloak_sync: keycloakSync });
          }
          return jsonResponse(
            {
              error: 'no such grant',
              user_id: userId,
              tenant_id,
              role,
              ...(keycloakSync !== undefined ? { keycloak_sync: keycloakSync } : {}),
            },
            404,
          );
        }
        await userRolesService.revokeRole(userId, tenant_id, role, tx);
        if (keycloakSync !== undefined) {
          return jsonResponse({ user_id: userId, tenant_id, role, keycloak_sync: keycloakSync });
        }
        return noContentResponse();
      };

      // Only an admin-role revoke can strand a tenant; a member revoke takes
      // no lock.
      if (role !== DB_ADMIN_ROLE) return revoke(undefined);

      // fr#1312: the last-admin guard is check-then-act. Two concurrent admin
      // revokes (here, or via /api/workspace/members, which takes the SAME
      // per-tenant lock) would both pass it and strand the tenant, so guard +
      // Keycloak revoke + DB delete run under one transaction-scoped lock, all
      // DB work on that lock's single connection.
      try {
        return await withWorkspaceAdminRevokeLock(tenant_id, revoke);
      } catch (err) {
        if (err instanceof WorkspaceAdminRevokeBusy) {
          return jsonResponse(
            {
              error: 'workspace_admin_revoke_busy',
              detail:
                'Another workspace-admin revoke for this tenant is in progress; nothing was changed. Retry shortly.',
              user_id: userId,
              tenant_id,
              role,
            },
            503,
          );
        }
        throw err;
      }
    },
  );
}
