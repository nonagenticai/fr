// src/services/departments.ts
//
// Foundation Plan 2 — departments are workspace-scoped buckets that group
// users + projects + assets. Per Spec 1 §6, every workspace has at most one
// `is_default = true` department (enforced by the partial unique index
// `departments_one_default_per_workspace` on the SQL side).
//
// Surface:
//   * createDepartment(workspaceId, { name, description?, is_default? })
//   * listDepartments(workspaceId, { includeArchived? })
//   * getDefaultDepartment(workspaceId)            — null when no default set
//   * setDefaultDepartment(deptId)                 — atomic swap inside a tx
//   * archiveDepartment(deptId)                    — soft-delete via archived_at
//
// `setDefaultDepartment` runs in a single transaction so the partial unique
// index can never observe two `is_default=true` rows for the same
// workspace, even under concurrent callers.

import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb, departments } from '../db/client';

export type DepartmentsDb = typeof defaultDb;

/** Create a new department under `workspaceId`. `is_default` defaults to false. */
export async function createDepartment(
  workspaceId: string,
  input: { name: string; description?: string; is_default?: boolean },
  db: DepartmentsDb = defaultDb,
): Promise<typeof departments.$inferSelect> {
  const inserted = await db
    .insert(departments)
    .values({
      workspace_id: workspaceId,
      name: input.name,
      description: input.description ?? '',
      is_default: input.is_default ?? false,
    })
    .returning();
  if (!inserted[0]) {
    throw new Error(
      `createDepartment: insert returned no row for workspace=${workspaceId}, name=${input.name}`,
    );
  }
  return inserted[0];
}

/** All departments in `workspaceId`. By default archived rows are filtered out. */
export async function listDepartments(
  workspaceId: string,
  opts: { includeArchived?: boolean } = {},
  db: DepartmentsDb = defaultDb,
): Promise<(typeof departments.$inferSelect)[]> {
  const where = opts.includeArchived
    ? eq(departments.workspace_id, workspaceId)
    : and(
        eq(departments.workspace_id, workspaceId),
        isNull(departments.archived_at),
      );
  return db.select().from(departments).where(where);
}

/** The single `is_default=true` department for the workspace, or null. */
export async function getDefaultDepartment(
  workspaceId: string,
  db: DepartmentsDb = defaultDb,
): Promise<typeof departments.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(departments)
    .where(
      and(
        eq(departments.workspace_id, workspaceId),
        eq(departments.is_default, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Atomic swap: clear `is_default` for the workspace, then set it on
 * `deptId`. The partial unique index enforces the at-most-one invariant; we
 * use a single transaction so the index can never see a transient pair.
 *
 * Throws when `deptId` does not exist.
 */
export async function setDefaultDepartment(
  deptId: string,
  db: DepartmentsDb = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(departments)
      .where(eq(departments.id, deptId))
      .limit(1);
    if (!target) {
      throw new Error(`department not found: ${deptId}`);
    }
    await tx
      .update(departments)
      .set({ is_default: false })
      .where(eq(departments.workspace_id, target.workspace_id));
    await tx
      .update(departments)
      .set({ is_default: true })
      .where(eq(departments.id, deptId));
  });
}

/** Soft-delete: stamp `archived_at = now()`. Idempotent. */
export async function archiveDepartment(
  deptId: string,
  db: DepartmentsDb = defaultDb,
): Promise<void> {
  await db
    .update(departments)
    .set({ archived_at: new Date() })
    .where(eq(departments.id, deptId));
}
