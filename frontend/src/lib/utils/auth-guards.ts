// src/lib/utils/auth-guards.ts
//
// Client-side role predicates mirroring the backend gate
// (`backend/src/lib/super-admin-gate.ts`). The server is always the real
// authority — every /api/* call still 403s on its own — these only gate the
// UI shell so a non-admin never sees an admin screen flash before the API
// denies it.
//
// Roles flow from the Keycloak `realm_access.roles` claim → `user.roles`
// (see `stores/auth.svelte.ts`). `super_admin` is the platform tier. The
// tenant tier is NOT read from the claim here: whether the caller is admin of
// the ACTIVE workspace comes from `/api/me/workspaces` (the row's `role`), which
// the backend computes as a `user_roles` workspace-admin row OR the realm role
// `tenant_admin` pinned to the raw `tenant_id` claim — see
// `auth.tenantRoles` and `backend/src/services/user-roles.ts`.

/** The Keycloak realm role that grants platform super-admin. Mirrors the backend. */
export const SUPER_ADMIN_ROLE = 'super_admin';

/** Anything carrying a Keycloak realm-role list. */
export interface RoleBearer {
  roles?: readonly string[];
}

/** True iff the realm roles include `super_admin`. */
export function hasSuperAdmin(user: RoleBearer | null | undefined): boolean {
  return user?.roles?.includes(SUPER_ADMIN_ROLE) ?? false;
}

// `hasTenantAdmin` was DELETED: it tested the claim for `workspace-admin`, which
// the portal realm never issues, and nothing but its own test called it. Use
// `auth.hasTenantRole('workspace-admin')`, which reads the active workspace's
// server-computed role.
