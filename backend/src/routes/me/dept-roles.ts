// src/routes/me/dept-roles.ts
//
// Foundation Plan 2 follow-up. Ships the auth-store typed-roles surface
// consumed by the parallel Z2 frontend lane: a single GET that returns
// the authenticated user's `(deptId → role)` map. The frontend caches
// this into auth-store next to the existing tenant-roles snapshot so
// dept-scoped UI gates (e.g. "show 'Promote to dept' button") don't
// each fan out their own query.
//
// Reads from `department_members` via `services/department-members.ts`
// — no joins through `departments` here; the response key IS the
// dept_id and the caller filters client-side when it needs to scope to
// one workspace.
//
// 200 with empty `{}` is a valid response (user has zero memberships).
// 401 is raised by `validateAuth` for unauthenticated requests.

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { listDepartmentsForUser } from '../../services/department-members';
import type { DeptRole } from '../../db/schema';

export type DeptRolesResponse = Record<string, DeptRole>;

/** GET /api/me/dept-roles */
export async function handleListMyDeptRoles(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const rows = await listDepartmentsForUser(user.id);
  // Last-write-wins on the rare duplicate (the unique index on
  // (dept_id, user_id) makes this unreachable, but a Map keeps the
  // construction straight-line and easy to audit).
  const out: DeptRolesResponse = {};
  for (const r of rows) {
    out[r.dept_id] = r.role;
  }
  return jsonResponse({ data: out });
}
