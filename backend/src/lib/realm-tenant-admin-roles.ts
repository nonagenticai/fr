/**
 * Realm roles accepted by fr's PINNED tenant-admin arm (services/user-roles.ts
 * :: isRealmTenantAdminOf) and by the admin-recipient lookup
 * (services/keycloak.ts :: listRealmTenantAdminIds). Dependency-free on purpose
 * so both can import it.
 */

/** The Keycloak realm role that makes its holder admin of their claimed tenant. */
export const REALM_TENANT_ADMIN_ROLE = 'tenant_admin';

/**
 * Every realm role accepted by the pinned tenant-admin arm.
 *
 * `admin` is the LEGACY realm role and is a PINNED ALIAS of `tenant_admin`
 * (George, 2026-09-29: "a fr admin is a tenant_admin"; fr#1289). It used to be
 * an UNPINNED claim fast path in `isWorkspaceAdminVia` that made its holder
 * admin of EVERY tenant. Measured live at the ruling: only cdmsfirst-admin and
 * fr-test hold realm `admin` directly, and both also hold `tenant_admin` with a
 * `tenant_id`, so pinning it costs nobody.
 *
 * `workspace-admin` is deliberately NOT here: no realm role by that name exists,
 * so a `workspace-admin` CLAIM grants nothing — that value is only meaningful
 * as a `user_roles` row.
 */
export const REALM_TENANT_ADMIN_ROLES = [REALM_TENANT_ADMIN_ROLE, 'admin'] as const;

/** True iff `roles` holds any realm role in REALM_TENANT_ADMIN_ROLES. Pinning
 *  to a tenant is the CALLER's job — this answers only "which role". */
export function holdsRealmTenantAdminRole(roles: readonly string[]): boolean {
  return REALM_TENANT_ADMIN_ROLES.some((r) => roles.includes(r));
}
