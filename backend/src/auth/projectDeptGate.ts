// src/auth/projectDeptGate.ts
//
// Spec 2 Plan 2-C Phase 0.5 Task 0.5.3 — shared dept-role gate keyed by
// project_id, factored out of routes/scheduled-triggers.ts so both
// scheduled-triggers and scheduled-reports (and any future project-keyed
// route) can reuse the same lookup + gate composition without duplicating
// the workspace-scope short-circuit.
//
// Why this lives in src/auth/ next to requireDeptRole.ts:
//
//   The pattern "load project's dept_id, delegate to requireDeptRole" is
//   exactly the same shape requireDeptRole already supports via its
//   `lookup` parameter — this module just curries the lookup against
//   the projects table. Keeping it in src/auth/ makes the dependency
//   chain (route → projectDeptGate → requireDeptRole) obvious.
//
// Workspace-scope handling:
//
//   Projects with `dept_id IS NULL` are workspace-scope. Only
//   workspace-admin / admin should be able to operate on them via these
//   routes. We pass a stub lookup that always returns null so postgres
//   is never asked to compare an empty string against the uuid dept_id
//   column; requireDeptRole's workspace-admin bypass kicks in first for
//   admins, and dept-only roles fall through to AppError(403).

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { projects, type DeptRole } from '../db/schema';
import { requireDeptRole } from './requireDeptRole';
import type { User } from '../types/api';

/**
 * Returns the dept_id for `projectId`, or null when the project is
 * workspace-scope (no dept) or does not exist. The caller is expected
 * to have already verified existence (or to handle null as a 404 path);
 * we surface null without distinction here so the gate can uniformly
 * translate "no dept" → "non-workspace-admin denied".
 */
export async function loadProjectDeptId(
  projectId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ dept_id: projects.dept_id })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.dept_id ?? null;
}

/**
 * Spec §13 dept-role gate keyed by project_id: looks up the project's
 * dept_id and delegates to `requireDeptRole`. Throws AppError(403) on
 * miss, which propagates through `handleError` in server.ts.
 * Workspace-admin / admin tenant roles bypass — see `requireDeptRole`.
 *
 * Workspace-scope projects (`projects.dept_id IS NULL`) only pass for
 * workspace-admin / admin: dept-only roles can never satisfy "minimum
 * dept-X role on a null dept" because the lookup will return null,
 * which `requireDeptRole` rejects.
 */
export async function gateOnProject(
  user: User,
  projectId: string,
  minRole: DeptRole,
): Promise<void> {
  const deptId = await loadProjectDeptId(projectId);
  if (deptId === null) {
    // For workspace-scope projects, requireDeptRole's workspace-admin
    // bypass still kicks in first; for everyone else we short-circuit
    // with a stub lookup that returns null so postgres is never asked
    // to compare an empty string against a uuid column.
    await requireDeptRole(user, '', minRole, async () => null);
    return;
  }
  await requireDeptRole(user, deptId, minRole);
}
