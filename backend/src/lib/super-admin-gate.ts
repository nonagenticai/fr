// src/lib/super-admin-gate.ts
//
// Super-admin gate, backed by the `super_admin` Keycloak realm role.
//
// Super-admin is platform-scoped and out-of-band from workspace membership.
// It rides on the `realm_access.roles` JWT claim, already surfaced on
// `User.roles` by `keycloak.validateToken`. A realm role survives identity
// changes (a user's Keycloak `sub` changing no longer silently drops their
// super-admin), is managed in Keycloak with no redeploy, and needs no env.
//
// History: this replaced the opaque-UUID `SUPER_ADMIN_USER_IDS` env allowlist
// (a stale allowlist silently dropped super-admin when an operator's identity
// changed). The env path was a migration bridge and is now gone. Plan:
// fr-some-recent-pr-virtual-spindle.

/** The Keycloak realm role that grants platform super-admin. */
export const SUPER_ADMIN_REALM_ROLE = 'super_admin';

/** True iff the given Keycloak realm roles include the super-admin role. */
export function hasSuperAdminRole(
  roles: readonly string[] | undefined,
): boolean {
  return roles?.includes(SUPER_ADMIN_REALM_ROLE) ?? false;
}

/**
 * Super-admin gate. A subject is super-admin iff they carry the `super_admin`
 * Keycloak realm role. Accepts a `User`-shaped subject (or any `{ roles }`) so
 * role- and claims-derived callers share one entry point. Returns false for an
 * undefined subject.
 */
export function isSuperAdmin(
  subject: { roles?: readonly string[] } | undefined,
): boolean {
  if (!subject) return false;
  return hasSuperAdminRole(subject.roles);
}
