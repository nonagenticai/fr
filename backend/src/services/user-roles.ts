// src/services/user-roles.ts
//
// RBAC: tenant-scoped user role assignments. DB-backed.
//
// Surface:
//   * hasRole(userId, tenantId, role)            — boolean check (admin gate)
//   * listUsersByRole(tenantId, role)            — "list all admins for tenant"
//   * grantRole(userId, tenantId, role, grantedBy)  — upsert
//   * revokeRole(userId, tenantId, role)         — delete

import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, userRoles, workspaces } from '../db/client';
import { isValidUuid } from '../utils/tenant';

/**
 * The root client or an open drizzle transaction on it. Accepting the
 * transaction lets a caller holding a transaction-scoped lock (the fr#1312
 * workspace-admin revoke lock) do every read/write on that ONE connection.
 */
export type UserRolesDb =
  | typeof defaultDb
  | Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

/**
 * The all-zero UUID. It wears two hats, and they must not be conflated:
 *  - as a TENANT it is the legitimate bootstrap/system workspace below;
 *  - as a USER it is the AUTH_BYPASS synthetic subject (`middleware/auth.ts`),
 *    which is never a real account. `grantRole` refuses it in that position.
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The default tenant id used by `validateAuth` (AUTH_BYPASS path) and
 * the existing integration tests for the engagement_deliveries surface.
 * The bootstrap path grants admin within this tenant so nothing about the
 * pre-existing admin set changes when the env-var is removed.
 */
export const DEFAULT_TENANT_ID = NIL_UUID;

// Rate-limited warn for non-UUID tenantId — legacy Keycloak claims (e.g.
// "gerard-dev") flow through here until the realm migration lands. We log
// once per unique tenantId to avoid drowning logs when an admin endpoint
// gets hit on every page render.
const _warnedNonUuidTenants = new Set<string>();
function _warnNonUuidTenant(scope: string, tenantId: string): void {
  if (_warnedNonUuidTenants.has(tenantId)) return;
  _warnedNonUuidTenants.add(tenantId);
  console.warn(
    `[user-roles] non-uuid tenantId='${tenantId}' — ${scope} denied; pending Keycloak claim migration`,
  );
}

/** True iff the (user, tenant, role) triple exists in the table. */
export async function hasRole(
  userId: string,
  tenantId: string,
  role: string,
  db: UserRolesDb = defaultDb,
): Promise<boolean> {
  if (!userId || !tenantId || !role) return false;
  if (!isValidUuid(tenantId)) {
    _warnNonUuidTenant('admin', tenantId);
    return false;
  }
  const rows = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.user_id, userId),
        eq(userRoles.tenant_id, tenantId),
        eq(userRoles.role, role),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** All user ids that hold `role` within `tenantId`. Sorted lexicographically. */
export async function listUsersByRole(
  tenantId: string,
  role: string,
  db: UserRolesDb = defaultDb,
): Promise<string[]> {
  if (!tenantId || !role) return [];
  if (!isValidUuid(tenantId)) {
    _warnNonUuidTenant('listUsersByRole', tenantId);
    return [];
  }
  const rows = await db
    .select({ user_id: userRoles.user_id })
    .from(userRoles)
    .where(
      and(eq(userRoles.tenant_id, tenantId), eq(userRoles.role, role)),
    );
  return rows.map((r) => r.user_id).sort();
}

/** One row of `user_roles`, as the admin console reads it. */
export interface RoleGrant {
  user_id: string;
  tenant_id: string;
  /** Legible workspace name; nullable for legacy rows and the bootstrap tenant. */
  tenant_name: string | null;
  role: string;
  granted_at: string;
  granted_by: string | null;
}

/**
 * The workspace label to display, preferring the SOURCE OF TRUTH over the copy.
 *
 * `user_roles.tenant_name` is a denormalized display column. Nothing in `src/`
 * wrote it until the admin grant route landed, so every row created before that
 * carries NULL — and the access list rendered a raw UUID where a name belongs
 * (measured live 2026-09-06: 10 of 13 grants had `tenant_name IS NULL`, and for
 * two of them — `claude` and `nonagenticai-prod` — the name was sitting in
 * `workspaces` the whole time).
 *
 * Resolving through the join is preferred over a one-time backfill because it
 * SELF-HEALS: a future writer that forgets the column still displays correctly.
 * A backfill would fix today's rows and leave the same trap armed — two copies
 * of one fact that can disagree, with the stale one winning.
 *
 * ⚠️ ORDER MATTERS, and the obvious order is the wrong one.
 * `coalesce(tenant_name, workspaces.name)` reads naturally ("use the stored
 * label, fall back to the join") and is WRONG: `tenant_name` is a snapshot taken
 * at grant time, so once a workspace is renamed that arm wins forever and the
 * access list shows a name that no longer exists. The live row is the authority
 * on what a workspace is CALLED, so it goes first.
 *
 * `tenant_name` remains the fallback for the case it is actually good at: the
 * `workspaces` row is gone, and the snapshot is the only surviving record of
 * what that grant referred to.
 *
 * Stays NULL when neither source has a name (8 of the 13 above), because
 * inventing a label for a workspace fr does not know would be worse than showing
 * the id — the id is at least true, and the UI already distinguishes them.
 */
export const TENANT_NAME_FROM_SOURCE =
  sql<string | null>`coalesce(${workspaces.name}, ${userRoles.tenant_name})`;

/**
 * Every role grant fr knows about.
 *
 * This is the only answer fr can give to "who has access, and where?".
 * Keycloak's user search needs >=2 characters and cannot enumerate, and
 * `user_roles` is the table the backend actually gates on — so it, not the
 * directory, is the authority on fr access.
 *
 * Unbounded on purpose: the table holds one row per (user, workspace, role)
 * and is on the order of tens. A LIMIT here would silently under-report who
 * has access, which is the one thing an access list must never do. If it ever
 * grows enough to need paging, that must be a visible page control, not a cap.
 */
export async function listAllGrants(db: UserRolesDb = defaultDb): Promise<RoleGrant[]> {
  const rows = await db
    .select({
      user_id: userRoles.user_id,
      tenant_id: userRoles.tenant_id,
      tenant_name: TENANT_NAME_FROM_SOURCE,
      role: userRoles.role,
      granted_at: userRoles.granted_at,
      granted_by: userRoles.granted_by,
    })
    .from(userRoles)
    .leftJoin(workspaces, eq(workspaces.id, userRoles.tenant_id));
  return rows.map((r) => ({
    ...r,
    granted_at:
      r.granted_at instanceof Date ? r.granted_at.toISOString() : String(r.granted_at),
  }));
}

/**
 * Every grant inside ONE workspace. The tenant-admin counterpart to
 * `listAllGrants`, which is fleet-wide and super-admin only.
 *
 * Scoped in SQL rather than by filtering `listAllGrants` in the caller: a
 * workspace admin must never receive another tenant's rows, and "we fetched
 * everything and then filtered" is one refactor away from leaking them.
 *
 * Unbounded for the same reason as `listAllGrants` — an access list that
 * silently under-reports who has access is worse than a slow one.
 */
export async function listGrantsForTenant(
  tenantId: string,
  db: UserRolesDb = defaultDb,
): Promise<RoleGrant[]> {
  // Fail CLOSED on a malformed tenant: returning [] reads as "nobody has
  // access", which is safe, where letting it through would compare a bad value
  // against every row.
  if (!tenantId || !isValidUuid(tenantId)) return [];
  const rows = await db
    .select({
      user_id: userRoles.user_id,
      tenant_id: userRoles.tenant_id,
      tenant_name: TENANT_NAME_FROM_SOURCE,
      role: userRoles.role,
      granted_at: userRoles.granted_at,
      granted_by: userRoles.granted_by,
    })
    .from(userRoles)
    .leftJoin(workspaces, eq(workspaces.id, userRoles.tenant_id))
    .where(eq(userRoles.tenant_id, tenantId));
  return rows.map((r) => ({
    ...r,
    granted_at:
      r.granted_at instanceof Date ? r.granted_at.toISOString() : String(r.granted_at),
  }));
}

// Constants live in lib/realm-tenant-admin-roles.ts so services/keycloak.ts can
// share them without importing the DB client. Re-exported for existing callers.
export {
  REALM_TENANT_ADMIN_ROLE,
  REALM_TENANT_ADMIN_ROLES,
  holdsRealmTenantAdminRole,
} from '../lib/realm-tenant-admin-roles';
import { holdsRealmTenantAdminRole } from '../lib/realm-tenant-admin-roles';
import { isSuperAdminSwitchedInto } from '../lib/super-admin-switch';

/**
 * Pure: does the SIGNED token make this user admin of `tenantId` via the
 * Keycloak realm role `tenant_admin` (or its legacy pinned alias `admin`)?
 *
 * True iff `realm_access.roles` holds `tenant_admin` or `admin` AND the RAW
 * `tenant_id` claim (`User.tenantClaim`) is a non-empty string equal to
 * `tenantId`.
 *
 * ⛔ Pinned to `tenantClaim`, NEVER `user.tenantId`. `deriveTenantId`
 * (utils/tenant.ts) falls back to `sub` when the token carries no `tenant_id`,
 * so reading `tenantId` would make a claim-less tenant_admin the admin of a
 * "tenant" whose id is their own subject. A tenant_admin (or admin) with no
 * `tenant_id` claim gets NOTHING from this arm — fail closed.
 *
 * ⭐ THE ONE SUPER-ADMIN ARM (George 2026-10-27: "I just need to be able to work
 * as a tenant-admin in every tenant I open"). A SIGNED `super_admin` whose
 * request carries an ACCEPTED workspace switch into `tenantId`
 * (`isSuperAdminSwitchedInto`, lib/super-admin-switch.ts — read from the request
 * frame `buildRequestContext` built) is tenant-admin of THAT tenant: the switch
 * re-pins what the realm composite (`super_admin` ⊃ `tenant_admin`) already
 * grants for the home claim to the workspace the UI shows. Only the frame's
 * active tenant, never another; never in home view; never for an fr-agent or
 * licence token (no signed claims). Since the same day the switch admits ANY
 * existing, non-archived workspace for an fr super-admin session
 * (lib/super-admin-switch-target.ts), so this arm makes a super_admin
 * tenant-admin in every tenant they switch into — audited per request
 * (lib/super-admin-tenant-audit.ts).
 */
export function isRealmTenantAdminOf(
  user: { roles: string[]; tenantClaim?: string },
  tenantId: string,
): boolean {
  if (isSuperAdminSwitchedInto(user, tenantId)) return true;
  const claim = user.tenantClaim;
  if (typeof claim !== 'string' || claim.length === 0) return false;
  if (!tenantId || claim !== tenantId) return false;
  return holdsRealmTenantAdminRole(user.roles);
}

/**
 * The canonical "is this person an admin of this workspace" test.
 *
 * ⚠️ Extracted because it was hand-rolled in six places and THREE of them got
 * it wrong. Measured against the live `fr` DB on 2026-08-28, `user_roles.role`
 * holds:
 *
 *     workspace-admin  12
 *     workspace-member  1
 *     admin             1   ← the AUTH_BYPASS seed artifact, not a real grant
 *
 * `routes/channels.ts`, `routes/suggested-schedules.ts` and
 * `routes/engagements/deliveries.ts` each checked ONLY `hasRole(..., 'admin')`,
 * so the DB path could match exactly one row in the entire estate — the seed
 * artifact — and never a real workspace admin. Those routes admitted people
 * solely via the Keycloak `admin` claim; anyone holding the grant in-app was
 * refused. `llm-provider.ts`, `department-members.ts` and `departments.ts`
 * already did it correctly, which is why this only bit some surfaces.
 *
 * The DB value `'admin'` is NOT an alias: migration 104 deleted that seed row
 * and added `CHECK (role IN ('workspace-admin','workspace-member'))`, so only
 * `'workspace-admin'` is read here. (The Keycloak REALM role `admin` is a
 * different axis and stays a pinned alias — see `isRealmTenantAdminOf`.)
 */
export async function isWorkspaceAdminOf(
  user: { id: string; roles: string[]; tenantClaim?: string },
  tenantId: string,
  db: UserRolesDb = defaultDb,
): Promise<boolean> {
  return isWorkspaceAdminVia(user, tenantId, (u, t, r) => hasRole(u, t, r, db));
}

/**
 * Same test, but taking `hasRole` as a PARAMETER.
 *
 * Routes call this one, passing their user-roles service's `hasRole`, which
 * keeps the authorization logic in one place.
 *
 * THE RULE (effective workspace-admin of tenant T):
 *
 *     user_roles row (user, T, 'workspace-admin')
 *  OR ( realm role `tenant_admin` | legacy `admin`  AND  RAW `tenant_id` claim === T )
 *
 * George ruled 2026-09-29 (fr#1289): "a fr admin is a tenant_admin". The second
 * arm is `isRealmTenantAdminOf` above: the estate-wide meaning of `tenant_admin`
 * (commonpractice `requireTenantAdmin`, admin_app, ...), which control_service
 * and commonpractice grant at onboarding, with the legacy realm role `admin` as a
 * PINNED alias (`REALM_TENANT_ADMIN_ROLES`). It is ADDITIVE — nothing is synced
 * into `user_roles`.
 *
 * ⛔ There is NO bare-claim arm any more. This used to begin with
 * `claim 'workspace-admin' | 'admin' -> true`, which was UNPINNED: holding the
 * claim made its bearer admin of ANY tenant, whatever T was. It was removed
 * rather than pinned in place. Realm `admin` now passes only through the pinned
 * arm; a `workspace-admin` claim grants nothing (no such realm role exists — the
 * value is meaningful only as a `user_roles` row).
 *
 * ⛔ `super_admin` IS DELIBERATELY ABSENT FROM THIS PREDICATE. DO NOT ADD IT.
 * (⭐ One narrow exception, George 2026-10-27, lives in `isRealmTenantAdminOf`:
 * a super-admin SWITCHED into T via `X-Active-Tenant` is admin of T — that
 * tenant only, never in home view. Everything below still holds for the
 * un-switched super-admin.)
 *
 * This has now been proposed twice and investigated twice, and the answer is the
 * same both times: super-admin is a SECOND, PLATFORM-SCOPED AXIS, not a stronger
 * workspace role. `lib/super-admin-gate.ts` says so in its own header —
 * "Super-admin is platform-scoped and out-of-band from workspace membership" —
 * and it reads the `super_admin` realm role from the SIGNED claim and fails
 * closed. `scripts/check-admin-claim-only.ts` (a CI guard) states the reason
 * explicitly: this function is "the one correct place for the claim to be read
 * for this purpose", while the super-admin gate answers "a different question
 * with a different answer". (This file was also exempt from that guard until
 * 2026-09-29; the exemption went with the unpinned claim arm.)
 *
 * The intended composition is CALL-SITE OPT-IN, not predicate widening. See
 * `routes/settings/llm-provider.ts:102` and `routes/me/budget-topup.ts:83,281`,
 * which short-circuit with `if (isSuperAdmin(user)) return true;` immediately
 * BEFORE calling this — the authors knew it excludes super_admin and added it
 * locally where they wanted it. There are ~40 `isSuperAdmin` call sites; twelve
 * of the thirteen callers of this function chose NOT to.
 *
 * ⭐ And there is no capability a super_admin actually lacks. Every one of the
 * thirteen gates is reachable through `POST /api/admin/users/:userId/roles`
 * (`routes/admin/user-roles.ts:133`) — `superAdminOnly`, audited, fleet-scoped,
 * and able to grant `workspace-admin` in any tenant.
 * (Historical: until George's 2026-10-27 ruling `X-Active-Tenant` admitted only
 * the platform tenants or the caller's own, so these gates were unreachable with
 * a foreign tenant. The switch now admits any live workspace for a human
 * super_admin, and the switched arm in `isRealmTenantAdminOf` is what makes them
 * admin there — still not this predicate's un-switched rule.)
 *
 * Adding `super_admin` here would collapse two deliberately distinct authority
 * levels into one and grant it implicitly at thirteen sites. fr #1079 tried and
 * was withdrawn: `WorkspaceRole.safeParse('super_admin').success === false`.
 *
 * ⚠️ The `tenant_admin` arm does not reopen that door. In the portal realm
 * `super_admin` is a COMPOSITE containing `tenant_admin`, so a super_admin's
 * token satisfies the arm — but only for the tenant named by their OWN raw
 * `tenant_id` claim, exactly as it would in every other estate service. It never
 * reaches a foreign tenant, and `super_admin` without `tenant_admin` gains
 * nothing here.
 */
export async function isWorkspaceAdminVia(
  user: { id: string; roles: string[]; tenantClaim?: string },
  tenantId: string,
  hasRoleFn: (userId: string, tenantId: string, role: string) => Promise<boolean>,
): Promise<boolean> {
  // Keycloak realm `tenant_admin` / legacy `admin`, pinned to the raw
  // `tenant_id` claim — cheap, no DB round trip. NO unpinned claim arm.
  if (isRealmTenantAdminOf(user, tenantId)) return true;
  // DB arm: 'workspace-admin' only. Migration 104's CHECK makes a DB 'admin'
  // row impossible, so there is no DB-level legacy alias to read.
  return hasRoleFn(user.id, tenantId, 'workspace-admin');
}

/**
 * Idempotent upsert: grants `role` to `userId` within `tenantId`. Re-granting
 * an existing triple is a no-op (the unique index is the conflict target).
 * `grantedBy` is the user id of the granter; pass 'system' for the bootstrap
 * path or null for tests / migrations that don't carry a granter identity.
 *
 * `tenantName` is the legible workspace label stored beside the id.
 * `routes/admin/users.ts` READS `user_roles.tenant_name` and, until the admin
 * grant route landed, nothing in `src/` ever wrote it — every row carried NULL
 * and the access list rendered raw UUIDs. It is display-only, so a caller that
 * cannot resolve the name passes null and still gets the grant. It sits AFTER
 * `db` because the existing call sites pass `db` positionally as the fifth
 * argument.
 */
export async function grantRole(
  userId: string,
  tenantId: string,
  role: string,
  grantedBy: string | null,
  db: UserRolesDb = defaultDb,
  tenantName: string | null = null,
): Promise<void> {
  if (!userId || !tenantId || !role) {
    throw new Error('grantRole: userId, tenantId, role are all required');
  }
  // The nil UUID is the AUTH_BYPASS synthetic SUBJECT (`middleware/auth.ts`),
  // never a real Keycloak account. A demo seeder granted it a role and the row
  // reached production, where it renders as a grant to a user the directory
  // 404s on and cannot be revoked through the API. Refuse it at the writer so
  // no future seeder can recreate it.
  //
  // Deliberately NOT symmetric with tenantId: the same value is the legitimate
  // bootstrap TENANT (`DEFAULT_TENANT_ID` above), which the admin bootstrap
  // path grants within — rejecting it there would break that grant.
  if (userId === NIL_UUID) {
    throw new Error(
      `grantRole: userId must not be the nil UUID; got "${userId}" (the AUTH_BYPASS placeholder subject, not a real account)`,
    );
  }
  if (!isValidUuid(tenantId)) {
    throw new Error(
      `grantRole: tenantId must be a valid UUID; got "${tenantId}"`,
    );
  }
  await db
    .insert(userRoles)
    .values({
      user_id: userId,
      tenant_id: tenantId,
      tenant_name: tenantName,
      role,
      granted_by: grantedBy,
    })
    .onConflictDoNothing({
      target: [userRoles.user_id, userRoles.tenant_id, userRoles.role],
    });
}

/** Revoke a single role. Missing rows are a no-op. */
export async function revokeRole(
  userId: string,
  tenantId: string,
  role: string,
  db: UserRolesDb = defaultDb,
): Promise<void> {
  if (!userId || !tenantId || !role) return;
  await db
    .delete(userRoles)
    .where(
      and(
        eq(userRoles.user_id, userId),
        eq(userRoles.tenant_id, tenantId),
        eq(userRoles.role, role),
      ),
    );
}

export const userRolesService = {
  hasRole,
  listUsersByRole,
  listAllGrants,
  listGrantsForTenant,
  isWorkspaceAdminOf,
  isWorkspaceAdminVia,
  isRealmTenantAdminOf,
  grantRole,
  revokeRole,
  DEFAULT_TENANT_ID,
};
