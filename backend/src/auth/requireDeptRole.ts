// src/auth/requireDeptRole.ts
//
// Spec 2 Plan 2-C Phase 0.5 Task 0.5.1 — reusable HTTP-route gate that
// asserts the caller has at least `minRole` on `deptId`. Tasks 0.5.2 and
// 0.5.3 wire this onto the 14 scheduled-triggers + scheduled-reports
// handlers (Spec §13).
//
// Role ordering (Spec 1 §11):
//
//   dept-viewer < dept-member < dept-manager < dept-admin
//
// Workspace-admin bypass:
//
//   A user whose JWT carries the tenant-level `workspace-admin` (or bare
//   `admin`) role passes every minRole regardless of dept membership.
//   This mirrors `isWorkspaceAdmin` in routes/asset-scope/promote.ts so
//   the two RBAC paths agree on the operational backstop.
//
// Why a `lookup` parameter instead of always calling getMemberRole?
//
//   A project with NO department has no membership to read: its callers
//   (auth/projectDeptGate.ts, routes/scheduled-triggers.ts,
//   routes/scheduled-reports.ts) pass `async () => null`, so only the
//   workspace-admin bypass can admit the caller.
//
// The default lookup is the real `getMemberRole` from
// services/department-members, so call sites with a department omit
// the argument.

import { AppError } from '../utils/errors';
import { getMemberRole } from '../services/department-members';
import type { DeptRole } from '../db/schema';
import type { User } from '../types/api';
import { ctxTenantId } from '../middleware/request-context';
import { userRolesService } from '../services/user-roles';

/**
 * Lookup signature compatible with `services/department-members.getMemberRole`.
 * `string | null` instead of `DeptRole | null` because a stored role is a
 * free `text` column: the gate only treats the four known roles as ranked,
 * anything else is treated as "no role".
 */
export type DeptRoleLookup = (
  deptId: string,
  userId: string,
) => Promise<DeptRole | string | null>;

const ROLE_RANK: Record<DeptRole, number> = {
  'dept-viewer': 1,
  'dept-member': 2,
  'dept-manager': 3,
  'dept-admin': 4,
};

const KNOWN_ROLES = new Set<string>(Object.keys(ROLE_RANK));

/**
 * True iff `user` is a workspace admin of their own tenant.
 *
 * This used to test the JWT alone:
 *     user.roles.includes('workspace-admin') || user.roles.includes('admin')
 * but `workspace-admin` is NOT a Keycloak realm role in this product — it is a
 * `user_roles` row, delivered via `GET /api/me/workspaces`. So the claim was
 * false for all 12 real workspace admins, and the bypass below never fired for
 * any of them: they were held to a dept-role check their status should have
 * skipped. Same defect as routes/assets/kag.ts, scheduled-reports.ts and
 * scheduled-triggers/list.ts; scripts/check-admin-claim-only.ts now guards it.
 */
export type WorkspaceAdminCheck = (user: User) => Promise<boolean>;

const defaultWorkspaceAdminCheck: WorkspaceAdminCheck = (user) =>
  userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );

/**
 * Throw `AppError(403)` if `user` does not have at least `minRole` on
 * `deptId`. Returns silently otherwise.
 *
 * Workspace-admin / admin tenant roles bypass the gate without invoking
 * `lookup`.
 */
export async function requireDeptRole(
  user: User,
  deptId: string,
  minRole: DeptRole,
  lookup: DeptRoleLookup = getMemberRole,
): Promise<void> {
  if (await defaultWorkspaceAdminCheck(user)) return;

  const role = await lookup(deptId, user.id);
  if (role === null || role === undefined || !KNOWN_ROLES.has(role)) {
    throw new AppError(
      403,
      `dept-role required on department ${deptId}: minimum ${minRole}`,
    );
  }
  if (ROLE_RANK[role as DeptRole] < ROLE_RANK[minRole]) {
    throw new AppError(
      403,
      `dept-role '${minRole}' or higher required on department ${deptId}; have '${role}'`,
    );
  }
}
