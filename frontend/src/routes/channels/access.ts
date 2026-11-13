// /channels access gate — pure, so the timing rule is unit-testable.
//
// ⛔ Prod defect 2026-09-30: the layout judged access ONCE in onMount, right
// after `auth.isLoading` went false. But the active workspace's role — the
// thing that makes a realm `tenant_admin` (or a `user_roles` workspace-admin)
// a `workspace-admin` on the client — arrives LATER, from
// `GET /api/me/workspaces` via `workspaces.load()` -> `auth.setActiveWorkspaceRole`.
// So a tenant admin saw Channels in the sidebar, `GET /api/channels` answered
// 200, and the page still bounced them Home with "Workspace or department
// admin required.". The gate now returns 'pending' until the workspace role
// has settled (loaded, or the load failed) and the caller re-evaluates it
// reactively.
//
// Arms mirror the backend's `isWorkspaceAdminVia`
// (backend/src/services/user-roles.ts): the realm `tenant_admin` / legacy
// `admin` role PINNED to the raw `tenant_id` claim equalling the active tenant
// (never unpinned — that would admit a tenant admin browsing a foreign
// workspace the API will 403), OR a workspace-admin role for the active
// workspace. Plus the dept-admin arm this route has always admitted.

/** Mirrors backend/src/lib/realm-tenant-admin-roles.ts REALM_TENANT_ADMIN_ROLES. */
export const REALM_TENANT_ADMIN_ROLES = ['tenant_admin', 'admin'] as const;

export type ChannelsGate = 'pending' | 'allow' | 'deny';

export interface ChannelsGateInput {
  authLoading: boolean;
  /** `auth.hasTenantRole('workspace-admin')` — fed by /api/me/workspaces. */
  workspaceAdmin: boolean;
  deptAdmin: boolean;
  /** Keycloak realm roles (`auth.user.roles`). */
  realmRoles: readonly string[];
  /** Raw `tenant_id` claim (`auth.user.tenant_id`). */
  tenantClaim: string | undefined;
  /** The tenant requests will carry (`workspaces.scopeKey`). */
  activeTenantId: string | undefined;
  workspacesLoaded: boolean;
  workspacesError: string | undefined;
}

export function realmTenantAdminOf(
  realmRoles: readonly string[],
  tenantClaim: string | undefined,
  activeTenantId: string | undefined,
): boolean {
  if (!tenantClaim || !activeTenantId || tenantClaim !== activeTenantId) return false;
  return REALM_TENANT_ADMIN_ROLES.some((r) => realmRoles.includes(r));
}

export function channelsGate(s: ChannelsGateInput): ChannelsGate {
  if (s.authLoading) return 'pending';
  // Positive arms can admit early; only a DENY must wait for roles to settle.
  if (s.workspaceAdmin || s.deptAdmin) return 'allow';
  if (realmTenantAdminOf(s.realmRoles, s.tenantClaim, s.activeTenantId)) return 'allow';
  if (!s.workspacesLoaded && s.workspacesError === undefined) return 'pending';
  return 'deny';
}
