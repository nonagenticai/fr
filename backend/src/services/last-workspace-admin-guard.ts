/**
 * Last-workspace-admin guard (fr#1309).
 *
 * A workspace admin of tenant T is a `user_roles` 'workspace-admin' row for T
 * OR a Keycloak realm `tenant_admin` holder whose `tenant_id` is T (fr#1287).
 * Removing the last LIVE one strands the workspace: nobody can administer it
 * and recovery needs a super-admin. Both revoke routes
 * (routes/workspace/members.ts, routes/admin/user-roles.ts) ask this module
 * BEFORE any write — for every workspace-admin revoke, not only a self-revoke.
 *
 * "Live" matters because a DB row can outlive its Keycloak user. An orphan row
 * (user deleted, or `enabled: false`) admits nobody, so it must neither count
 * as a remaining admin nor be protected as the last one.
 *
 * FAIL CLOSED: `isLiveAdminOf` throws on anything but a clean answer, and
 * `wouldStrandWorkspace` lets that propagate. Callers turn it into a 503 and
 * change nothing — "could not ask" is never read as "someone else remains".
 */
import { keycloak } from './keycloak';
import { isKeycloakNotFoundError } from '../lib/keycloak-not-found';
import { isSuperAdmin } from '../lib/super-admin-gate';
import {
  EXECUTION_TENANT_ID,
  INTERNAL_TENANT_IDS,
} from '../middleware/internal-tenant-only';

/**
 * Tenants a super_admin can scope a request to via `X-Active-Tenant`
 * (middleware/request-context.ts): the internal tenants and the execution
 * tenant. Their own JWT tenant is covered by the tenant_id match.
 */
const SUPER_ADMIN_SWITCHABLE: ReadonlySet<string> = new Set([
  ...INTERNAL_TENANT_IDS,
  EXECUTION_TENANT_ID,
]);

/**
 * Can this DB-row holder actually administer `tenantId`? true iff the Keycloak
 * user exists, is enabled, AND a request of theirs can be scoped to the tenant:
 * their `tenant_id` attribute is `tenantId` (the members gate takes the tenant
 * from the JWT claim), or they are super_admin and `tenantId` is one of the
 * tenants the X-Active-Tenant switch accepts. A row whose holder lives in
 * another tenant admits nobody here, exactly like an orphan (fr#1311 audit).
 * false for a Keycloak 404 (user gone). THROWS on any other failure.
 *
 * Only a 404 from this USER LOOKUP means "gone" — same narrowing as
 * services/tenant-admin-sync.ts `lookupTarget`.
 */
export async function isLiveAdminOf(userId: string, tenantId: string): Promise<boolean> {
  let r: { enabled: boolean; tenantId: string | null; effectiveRoles: string[] };
  try {
    r = await keycloak.getUserTenantAndRoles(userId);
  } catch (err) {
    if (isKeycloakNotFoundError(err)) return false;
    throw err;
  }
  if (r.enabled !== true) return false;
  if (r.tenantId === tenantId) return true;
  return isSuperAdmin({ roles: r.effectiveRoles }) && SUPER_ADMIN_SWITCHABLE.has(tenantId);
}

/**
 * Would revoking `targetUserId`'s workspace-admin leave the tenant with no live
 * admin? The caller removes the target from BOTH arms (the members route
 * refuses or writes through a realm admin; the DB row goes either way).
 *
 *  - target is not an admin at all                    → false (nothing changes)
 *  - target is DB-only and not live (orphan)          → false (an orphan is not
 *    an admin, so deleting its row never lowers the live count — keeps orphan
 *    cleanup possible even in a tenant with zero live admins)
 *  - any other realm admin remains                    → false (realm set is
 *    already fresh and enabled-filtered)
 *  - any other DB-only admin is live                  → false
 *  - otherwise                                        → true (refuse, 409)
 *
 * Errors from `isLive` propagate: the caller must fail closed.
 */
export async function wouldStrandWorkspace(args: {
  targetUserId: string;
  realmAdminIds: ReadonlySet<string>;
  dbAdminIds: readonly string[];
  isLive: (userId: string) => Promise<boolean>;
}): Promise<boolean> {
  const { targetUserId, realmAdminIds, dbAdminIds, isLive } = args;
  const inRealm = realmAdminIds.has(targetUserId);
  const inDb = dbAdminIds.includes(targetUserId);
  if (!inRealm && !inDb) return false;
  if (!inRealm && !(await isLive(targetUserId))) return false;

  const remaining = [...new Set([...realmAdminIds, ...dbAdminIds])].filter(
    (id) => id !== targetUserId,
  );
  if (remaining.some((id) => realmAdminIds.has(id))) return false;
  for (const id of remaining) {
    if (await isLive(id)) return false;
  }
  return true;
}
