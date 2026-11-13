// src/services/department-members.ts
//
// Foundation Plan 2 — department membership + role. The four roles are
// defined per Spec 1 §11 (`dept-admin`, `dept-manager`, `dept-member`,
// `dept-viewer`); the SQL side enforces the closed set with a CHECK
// constraint, and `DeptRole` mirrors that on the TS side.
//
// Surface:
//   * addMember(deptId, userId, role)        — upsert; last role wins
//   * getMemberRole(deptId, userId)          — DeptRole | null
//   * listMembers(deptId)                    — full row list
//   * removeMember(deptId, userId)           — delete; missing row is no-op
//   * listDepartmentsForUser(userId)         — used by RBAC + landing
//
// The unique index `(dept_id, user_id)` makes addMember idempotent at the
// DB level via ON CONFLICT DO UPDATE.

import { and, eq } from 'drizzle-orm';
import { db as defaultDb, departmentMembers } from '../db/client';
import type { DeptRole } from '../db/schema';

export type DepartmentMembersDb = typeof defaultDb;

/**
 * Upsert a (dept, user) → role tuple. Re-calling with a different role
 * overwrites the previous role (last write wins) — there is exactly one
 * role per (dept, user) pair, so the call site never has to delete-then-
 * insert when promoting / demoting a member.
 */
export async function addMember(
  deptId: string,
  userId: string,
  role: DeptRole,
  db: DepartmentMembersDb = defaultDb,
): Promise<void> {
  await db
    .insert(departmentMembers)
    .values({ dept_id: deptId, user_id: userId, role })
    .onConflictDoUpdate({
      target: [departmentMembers.dept_id, departmentMembers.user_id],
      set: { role },
    });
}

/** Returns the role for `userId` in `deptId`, or null when not a member. */
export async function getMemberRole(
  deptId: string,
  userId: string,
  db: DepartmentMembersDb = defaultDb,
): Promise<DeptRole | null> {
  const [row] = await db
    .select()
    .from(departmentMembers)
    .where(
      and(
        eq(departmentMembers.dept_id, deptId),
        eq(departmentMembers.user_id, userId),
      ),
    )
    .limit(1);
  return (row?.role ?? null) as DeptRole | null;
}

/** All member rows for a dept. Order is unspecified. */
export async function listMembers(
  deptId: string,
  db: DepartmentMembersDb = defaultDb,
): Promise<(typeof departmentMembers.$inferSelect)[]> {
  return db
    .select()
    .from(departmentMembers)
    .where(eq(departmentMembers.dept_id, deptId));
}

/** Delete a member row. Missing rows are a no-op. */
export async function removeMember(
  deptId: string,
  userId: string,
  db: DepartmentMembersDb = defaultDb,
): Promise<void> {
  await db
    .delete(departmentMembers)
    .where(
      and(
        eq(departmentMembers.dept_id, deptId),
        eq(departmentMembers.user_id, userId),
      ),
    );
}

/**
 * All `(dept_id, role)` tuples this user belongs to across the whole
 * cluster. RBAC + landing-route resolution use this; for the common
 * within-workspace case the caller filters the result client-side rather
 * than joining through `departments` here.
 */
export async function listDepartmentsForUser(
  userId: string,
  db: DepartmentMembersDb = defaultDb,
): Promise<{ dept_id: string; role: DeptRole }[]> {
  const rows = await db
    .select({
      dept_id: departmentMembers.dept_id,
      role: departmentMembers.role,
    })
    .from(departmentMembers)
    .where(eq(departmentMembers.user_id, userId));
  return rows as { dept_id: string; role: DeptRole }[];
}
