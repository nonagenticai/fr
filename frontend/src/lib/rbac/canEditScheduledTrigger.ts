// canEditScheduledTrigger.ts
//
// Plan 2-C Phase 4 — pure-logic RBAC helpers for scheduled-trigger /
// scheduled-report UI gating. **UX-only.** The backend (Plan 2-C Phase 0.5)
// is the security boundary; these helpers exist to hide buttons the user
// cannot use, so the UI doesn't promise actions the API will reject.
//
// Spec §13 rules mirrored here:
//   - workspace-admin: edit + view + run-now anywhere.
//   - dept-manager (or dept-admin) of the project's dept: edit + view + run-now.
//   - dept-member of the project's dept: view only.
//   - dept-viewer of the project's dept: view only.
//   - everyone else (including admins of OTHER depts): no.
//   - Workspace-scope projects (dept_id === null) require workspace-admin
//     for edit; that mirrors backend `requireDeptRole(null, 'dept-manager')`
//     which only succeeds for workspace-admin.
//
// The signature uses a minimal `User` / `Project` shape so the helper stays
// pure and trivially testable. Callers in `+page.svelte` construct the
// `User` from the `auth` store (`tenantRoles` + `deptRoles`) — the auth
// store's typed surface (Spec 1 §11) already carries the per-dept role map
// pulled from `GET /api/me/dept-roles`.

export type DeptRole = 'dept-viewer' | 'dept-member' | 'dept-manager' | 'dept-admin';

const ORDER: readonly DeptRole[] = ['dept-viewer', 'dept-member', 'dept-manager', 'dept-admin'];

export type User = {
  /** Tenant-level roles, e.g. 'workspace-admin' or 'workspace-member'. */
  roles: readonly string[];
  /** Per-dept role map keyed by dept uuid. Missing keys mean no membership. */
  depts: Readonly<Record<string, DeptRole>>;
};

export type Project = {
  id: string;
  /** Project's owning department. `null` means workspace-scope. */
  dept_id: string | null;
};

function deptRoleAtLeast(u: User, deptId: string | null, min: DeptRole): boolean {
  if (u.roles.includes('workspace-admin')) return true;
  if (!deptId) return false;
  const have = u.depts[deptId];
  if (!have) return false;
  return ORDER.indexOf(have) >= ORDER.indexOf(min);
}

/** dept-manager+ on the project's dept (or workspace-admin). */
export const canEditScheduledTrigger = (u: User, p: Project): boolean =>
  deptRoleAtLeast(u, p.dept_id, 'dept-manager');

