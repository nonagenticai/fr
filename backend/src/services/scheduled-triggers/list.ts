// src/services/scheduled-triggers/list.ts
//
// Shared list query for scheduled_triggers. Used by:
//   - GET /api/scheduled-triggers          (routes/scheduled-triggers.ts)
//   - GET /api/assets/triggers              (routes/assets/triggers.ts — Library alias)
//
// RBAC follows Spec 2 §13: workspace-admin sees every trigger in tenant;
// dept-scoped users see only triggers whose project's dept_id is one of
// their member depts. Workspace-scope projects (dept_id IS NULL) are
// visible to workspace-admin only.

import { and, eq, inArray } from 'drizzle-orm';
import { db, projects, scheduledTriggers } from '../../db/client';
import type { ScheduledTrigger } from '../../db/client';
import { listDepartmentsForUser } from '../department-members';
import type { User } from '../../types/api';
import { userRolesService } from '../user-roles';
import { ctxTenantId } from '../../middleware/request-context';

export interface ListScheduledTriggersOpts {
  /** Optional project filter — if set, only triggers for this project. */
  projectId?: string;
}

/**
 * RBAC-respecting list of scheduled_triggers for the calling user.
 *
 * Returns the full row shape so callers can either pass the raw rows
 * through (existing /api/scheduled-triggers) or re-shape into the
 * `{ id, title, project_id, dept_id }` Library envelope (new
 * /api/assets/triggers).
 */
export async function listScheduledTriggersForUser(
  user: User,
  opts: ListScheduledTriggersOpts = {},
): Promise<ScheduledTrigger[]> {
  // Claim OR the user_roles table.
  // `workspace-admin` is a DB row, not a realm role, so the claim-only test this
  // replaces was false for every real workspace admin and narrowed their list.
  //
  // SEC-b: the tenant is the REQUEST-CONTEXT one (`ctxTenantId`), exactly as the
  // get / patch / delete / run-now / runs siblings in routes/scheduled-triggers.ts
  // resolve it. `user.tenantId` is the JWT HOME tenant: a super-admin switched
  // with `X-Active-Tenant` (middleware/request-context.ts) was shown their home
  // tenant's triggers while the UI showed the switched workspace. For everyone
  // else the frame tenant IS the JWT tenant (a non-super-admin's header is
  // ignored), so their list is unchanged.
  const tenantId = ctxTenantId(user.tenantId);
  const isWorkspaceAdmin = await userRolesService.isWorkspaceAdminVia(
    user,
    tenantId,
    userRolesService.hasRole,
  );

  const baseTenant = eq(scheduledTriggers.tenant_id, tenantId);
  const baseProject = opts.projectId
    ? and(baseTenant, eq(scheduledTriggers.project_id, opts.projectId))
    : baseTenant;

  if (isWorkspaceAdmin) {
    return await db.select().from(scheduledTriggers).where(baseProject);
  }

  const depts = await listDepartmentsForUser(user.id);
  if (depts.length === 0) return [];
  const memberDeptIds = depts.map((d) => d.dept_id);

  const allowedProjects = db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.dept_id, memberDeptIds));

  return await db
    .select()
    .from(scheduledTriggers)
    .where(and(baseProject, inArray(scheduledTriggers.project_id, allowedProjects)));
}

/**
 * Resolve dept_id for each trigger by joining its project. Returned in the
 * same order as the input list. Used by the Library alias surface so the
 * UI can render the source-scope pill without a second roundtrip.
 */
export async function attachProjectDept(
  rows: ScheduledTrigger[],
): Promise<Array<ScheduledTrigger & { dept_id: string | null }>> {
  if (rows.length === 0) return [];
  const projectIds = Array.from(new Set(rows.map((r) => r.project_id)));
  const projRows = await db
    .select({ id: projects.id, dept_id: projects.dept_id })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const deptByProject = new Map(projRows.map((p) => [p.id, p.dept_id]));
  return rows.map((r) => ({ ...r, dept_id: deptByProject.get(r.project_id) ?? null }));
}
