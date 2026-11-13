/**
 * Write-through of fr workspace-admin grants/revokes to the Keycloak portal
 * realm role `tenant_admin` (George, 2026-09-29: "a fr admin is a
 * tenant_admin"; fr#1289).
 *
 * Gated by FR_TENANT_ADMIN_WRITE_THROUGH (config.keycloak.tenantAdminWriteThrough,
 * default OFF). With the flag off every call returns 'disabled' and makes ZERO
 * Keycloak calls.
 *
 * Invariants:
 *  - fr NEVER sets a user's `tenant_id` attribute (single-valued). A target with
 *    no tenant, or a different tenant, is skipped — never re-homed.
 *  - Super-admins (effective realm role `super_admin`) are never touched.
 *  - A revoke of a role the user holds only through a composite/group is
 *    REFUSED: removing the direct mapping would be a no-op that reads as done.
 *  - A user Keycloak does not know (lookup 404) cannot hold `tenant_admin`, so
 *    there is nothing to add or remove: 'skipped_user_absent', and the caller
 *    proceeds with its DB-only grant/revoke. 2026-09-30 incident: an orphan
 *    workspace-admin row for a user DELETED from Keycloak could never be
 *    revoked — the lookup 404 read as 'failed', the route answered 502
 *    keycloak_write_failed and kept the row. Only a 404 from the LOOKUP counts;
 *    any error from assign/remove stays 'failed' (fail closed).
 *  - Neither function throws. Grant 'failed' → caller keeps its DB grant.
 *    Revoke 'failed' → caller must refuse the revoke (502).
 */
import { config } from '../config';
import { keycloak, invalidateRealmTenantAdminCache } from './keycloak';
import { REALM_TENANT_ADMIN_ROLE } from '../lib/realm-tenant-admin-roles';
import { isKeycloakNotFoundError } from '../lib/keycloak-not-found';

export type GrantSync =
  | 'disabled'
  | 'added'
  | 'already'
  | 'skipped_no_tenant'
  | 'skipped_tenant_mismatch'
  | 'skipped_super_admin'
  | 'skipped_user_absent'
  | 'failed';

export type RevokeSync =
  | 'disabled'
  | 'removed'
  | 'absent'
  | 'refused_composite'
  | 'skipped_no_tenant'
  | 'skipped_tenant_mismatch'
  | 'skipped_super_admin'
  | 'skipped_user_absent'
  | 'failed';

interface TargetTenantAndRoles {
  tenantId: string | null;
  directRoles: string[];
  effectiveRoles: string[];
  enabled: boolean;
}

interface SyncDeps {
  isEnabled: () => boolean;
  getUserTenantAndRoles: (userId: string) => Promise<TargetTenantAndRoles>;
  assignRealmTenantAdmin: (userId: string) => Promise<'added' | 'already'>;
  removeRealmTenantAdmin: (userId: string) => Promise<'removed' | 'absent'>;
  logoutUser: (userId: string) => Promise<void>;
  invalidateCache: (tenantId?: string) => void;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const SUPER_ADMIN_ROLE = 'super_admin';

// The KeycloakService methods are called through the singleton at call time so
// the default deps never capture a stale reference. Typed, not cast: tsc fails
// if a method's signature drifts from what this service relies on.
type KeycloakSyncApi = Pick<
  typeof keycloak,
  'getUserTenantAndRoles' | 'assignRealmTenantAdmin' | 'removeRealmTenantAdmin' | 'logoutUser'
>;
const kc = (): KeycloakSyncApi => keycloak;

function defaultDeps(): SyncDeps {
  return {
    isEnabled: () => config.keycloak.tenantAdminWriteThrough === true,
    getUserTenantAndRoles: (id) => kc().getUserTenantAndRoles(id),
    assignRealmTenantAdmin: (id) => kc().assignRealmTenantAdmin(id),
    removeRealmTenantAdmin: (id) => kc().removeRealmTenantAdmin(id),
    logoutUser: (id) => kc().logoutUser(id),
    invalidateCache: (t) => invalidateRealmTenantAdminCache(t),
    log: (line) => console.info(line),
    warn: (line) => console.warn(line),
  };
}

export function isTenantAdminWriteThroughEnabled(): boolean {
  return defaultDeps().isEnabled();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emit(
  d: SyncDeps,
  op: 'grant' | 'revoke',
  outcome: string,
  userId: string,
  tenantId: string,
  actorId: string,
  extra?: Record<string, unknown>,
): void {
  try {
    d.log(
      JSON.stringify({
        event: 'tenant_admin_sync',
        op,
        outcome,
        target_user_id: userId,
        tenant_id: tenantId,
        actor_id: actorId,
        ...(extra ?? {}),
      }),
    );
  } catch {
    // Logging must never change the outcome.
  }
}

type Precheck = 'skipped_no_tenant' | 'skipped_tenant_mismatch' | 'skipped_super_admin' | null;

function precheck(target: TargetTenantAndRoles, tenantId: string): Precheck {
  if (target.tenantId === null || target.tenantId === undefined || target.tenantId === '') {
    return 'skipped_no_tenant';
  }
  if (target.tenantId !== tenantId) return 'skipped_tenant_mismatch';
  if ((target.effectiveRoles ?? []).includes(SUPER_ADMIN_ROLE)) return 'skipped_super_admin';
  return null;
}

const USER_ABSENT = Symbol('user_absent');

/**
 * The target's tenant + roles, or USER_ABSENT when Keycloak answers 404 for the
 * user. Any other lookup error propagates (→ 'failed'). The 404 is narrowed
 * HERE, around the lookup alone, so a 404 from assign/remove can never be
 * mistaken for a deleted account.
 */
async function lookupTarget(
  d: SyncDeps,
  userId: string,
): Promise<TargetTenantAndRoles | typeof USER_ABSENT> {
  try {
    return await d.getUserTenantAndRoles(userId);
  } catch (err) {
    if (isKeycloakNotFoundError(err)) return USER_ABSENT;
    throw err;
  }
}

export async function syncTenantAdminGrant(
  userId: string,
  tenantId: string,
  actorId: string,
): Promise<GrantSync> {
  let d: SyncDeps;
  try {
    d = defaultDeps();
    if (!d.isEnabled()) return 'disabled';
  } catch {
    return 'disabled';
  }

  let outcome: GrantSync;
  let extra: Record<string, unknown> | undefined;
  try {
    const target = await lookupTarget(d, userId);
    const skip = target === USER_ABSENT ? null : precheck(target, tenantId);
    if (target === USER_ABSENT) {
      outcome = 'skipped_user_absent';
    } else if (skip) {
      outcome = skip;
    } else {
      outcome = await d.assignRealmTenantAdmin(userId);
      if (outcome === 'added') {
        try {
          d.invalidateCache(tenantId);
        } catch {
          /* cache TTL bounds staleness */
        }
      }
    }
  } catch (err) {
    outcome = 'failed';
    extra = { error: errMsg(err) };
  }
  emit(d, 'grant', outcome, userId, tenantId, actorId, extra);
  return outcome;
}

export async function syncTenantAdminRevoke(
  userId: string,
  tenantId: string,
  actorId: string,
): Promise<RevokeSync> {
  let d: SyncDeps;
  try {
    d = defaultDeps();
    if (!d.isEnabled()) return 'disabled';
  } catch {
    return 'disabled';
  }

  let outcome: RevokeSync;
  let extra: Record<string, unknown> | undefined;
  try {
    const target = await lookupTarget(d, userId);
    const skip = target === USER_ABSENT ? null : precheck(target, tenantId);
    if (target === USER_ABSENT) {
      outcome = 'skipped_user_absent';
    } else if (skip) {
      outcome = skip;
    } else if (
      !(target.directRoles ?? []).includes(REALM_TENANT_ADMIN_ROLE) &&
      (target.effectiveRoles ?? []).includes(REALM_TENANT_ADMIN_ROLE)
    ) {
      outcome = 'refused_composite';
    } else {
      outcome = await d.removeRealmTenantAdmin(userId);
      if (outcome === 'removed') {
        try {
          d.invalidateCache(tenantId);
        } catch {
          /* cache TTL bounds staleness */
        }
        try {
          await d.logoutUser(userId);
        } catch (err) {
          extra = { logout_error: errMsg(err) };
          try {
            d.warn(
              JSON.stringify({
                event: 'tenant_admin_sync_logout_failed',
                target_user_id: userId,
                tenant_id: tenantId,
                actor_id: actorId,
                error: errMsg(err),
              }),
            );
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch (err) {
    outcome = 'failed';
    extra = { error: errMsg(err) };
  }
  emit(d, 'revoke', outcome, userId, tenantId, actorId, extra);
  return outcome;
}
