// Pure helpers for /admin/members. Kept out of the component so the rules that
// matter — how a person is labelled, which role a row holds, whether an action
// is safe — are unit-testable without mounting Svelte.
import type {
  WorkspaceMember,
  WorkspaceRole,
} from '$lib/api/workspaceMembers';
// Short, non-leaking form of an id. This file used to define its own
// `shortId` as `id.slice(0, 8)`; that copy is gone (fr#1205) because the
// LEADING 8 is not an identity — our ids are UUIDv7-shaped, so 52 live apps
// collapsed onto 27 distinct prefixes (fr#1203). The shared helper takes the
// TAIL, so labels rendered here now read `…7e9f1b33`, not `3f6a1c22`.
import { shortId } from '$lib/utils/shortId';

/** The all-zero UUID: the AUTH_BYPASS synthetic subject, never a real person. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * How a member is shown in the "Member" column.
 *
 * Mirrors the platform access list deliberately: an unresolved grant must never
 * appear as a raw UUID standing where a person's name belongs, because that is
 * indistinguishable from a real account with a missing profile. Measured on the
 * live estate, 10 of 14 grants were unresolvable, so this is the common case,
 * not the edge one.
 */
export function memberLabel(
  member: Pick<WorkspaceMember, 'user_id' | 'email' | 'name'> &
    Partial<Pick<WorkspaceMember, 'resolved'>>,
): string {
  if (member.user_id === NIL_UUID) return 'Seed artifact (dev placeholder)';
  if (member.resolved === false) {
    // A stored email/name is still the better handle if one survived; only the
    // id fallback is replaced, because only it leaks a raw UUID.
    return member.email ?? member.name ?? `Deleted account · ${shortId(member.user_id)}`;
  }
  return member.email ?? member.name ?? shortId(member.user_id);
}

/**
 * The role this member holds IN THIS WORKSPACE.
 *
 * The API returns a `workspaces` array shaped like the super-admin payload, but
 * this endpoint is already tenant-scoped, so there is exactly one entry. Reading
 * `[0]` blindly would still be wrong if a member somehow held two roles, so the
 * canonical role wins.
 */
export function roleInWorkspace(member: WorkspaceMember): string | null {
  const roles = member.workspaces.map((w) => w.role);
  if (roles.includes('workspace-admin')) return 'workspace-admin';
  // 'admin' is the legacy alias the backend still reads. Surface it as what it
  // grants, so the UI does not invent a third role name for the operator.
  if (roles.includes('admin')) return 'workspace-admin';
  return roles[0] ?? null;
}

/** True when this row currently administers the workspace. */
export function isAdminRow(member: WorkspaceMember): boolean {
  return roleInWorkspace(member) === 'workspace-admin';
}

/**
 * Whether revoking `member`'s admin role is allowed from the UI.
 *
 * The server refuses the last-admin case with a 409; the button is disabled
 * for the same reason so the operator is told BEFORE they click, not after.
 * The check is "would this leave zero admins", not "is this me" — an admin
 * demoting the only OTHER admin strands the workspace just as effectively when
 * they are themselves only a member.
 */
export function canRevokeAdmin(members: WorkspaceMember[]): boolean {
  return members.filter(isAdminRow).length > 1;
}

/** Client-side filter over email / name / id / role. */
export function filterMembers(
  members: WorkspaceMember[],
  query: string,
): WorkspaceMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return members;
  return members.filter((m) => {
    const hay = [
      m.email ?? '',
      m.name ?? '',
      m.user_id,
      roleInWorkspace(m) ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** The role a "promote/demote" toggle should move this member to. */
export function toggledRole(member: WorkspaceMember): WorkspaceRole {
  return isAdminRow(member) ? 'workspace-member' : 'workspace-admin';
}

/** Tooltip/label for an admin role this page cannot change (fr#1289). */
export const REALM_MANAGED_ADMIN_LABEL =
  "Managed by your organisation's identity provider (tenant_admin)";

/**
 * True when this member's admin role comes (at least partly) from the Keycloak
 * realm role `tenant_admin`, i.e. `admin_source` is 'keycloak' or 'both'.
 *
 * Such a row's admin role cannot be removed here: the backend answers the
 * revoke with 409 `realm_tenant_admin_not_revocable_here`. The demote toggle is
 * grant-then-revoke, so leaving it enabled would GRANT workspace-member and
 * then fail the revoke — the person ends up holding both roles. Disable the
 * demote and the remove instead.
 */
export function isRealmManagedAdmin(member: WorkspaceMember): boolean {
  return member.admin_source === 'keycloak' || member.admin_source === 'both';
}

/**
 * True when this row's admin role is realm-managed AND fr cannot currently
 * write the realm role — i.e. demote/remove must stay disabled.
 *
 * `realmAdminRevocable` is the list-level `realm_admin_revocable` flag
 * (fr#1289 part B: the Keycloak write-through is enabled). When it is true the
 * backend removes `tenant_admin` itself, so the controls are enabled like any
 * DB admin's. When false (or absent — the API client reads absent as false)
 * the lock and the REALM_MANAGED_ADMIN_LABEL tooltip stay, for the reason
 * given on `isRealmManagedAdmin`.
 */
export function isRealmLockedAdmin(
  member: WorkspaceMember,
  realmAdminRevocable: boolean,
): boolean {
  return isRealmManagedAdmin(member) && !realmAdminRevocable;
}

/** Non-blocking notice when a grant landed in fr but the IdP write-through failed. */
export const KEYCLOAK_SYNC_FAILED_WARNING =
  'Granted in fr, but the identity provider could not be updated';
