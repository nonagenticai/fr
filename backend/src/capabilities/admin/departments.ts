// fr-agui SPEC §13 P4c part 1 — spec drain: the nine /api/admin/departments routes
// (routes/admin/{departments,department-members}.ts), the request tenant's
// departments and their members, re-expressed with NO behaviour change
// (`legacyHandler`). Tenant-admin surface; tenancy `tenant`.
//
// Gates, every one after validateAuth (thrown to the central catch) and
// `ctxTenantId(user.tenantId)` (the frame tenant, else the JWT one; neither → 500):
//   * list / get a department: any caller with a resolved tenant
//     (`isAuthenticatedUserInResolvedTenant`);
//   * create / patch / archive: `requireWorkspaceAdmin` — `isWorkspaceAdminVia` of
//     that tenant (a user_roles workspace-admin row, or a realm tenant_admin pinned
//     to it; a super_admin alone does NOT pass): the route-aware `workspace-admin`
//     rule;
//   * the member routes: the department must belong to the tenant (an opaque 404
//     first — the route's RESOURCE check), then workspace-admin of the tenant OR
//     `dept-admin` of that department (`getMemberRole`): the `workspace-admin` rule
//     with `deptAdminOf: 'id'` (P4c part 1).
// No tenant is ever a parameter.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { isoTime, pathId, routeRule, settingsCapabilities, standardResponses, workspaceAdminRule } from '../observe/_shared';

const DEPT_ROLE = z.enum(['dept-admin', 'dept-manager', 'dept-member', 'dept-viewer']);

const department = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  description: z.string(),
  is_default: z.boolean(),
  default_landing: z.boolean(),
  created_at: isoTime,
  archived_at: isoTime.nullable(),
});

const dept = z.object({ id: pathId('Department id (a uuid; anything else answers the same 404 as an absent department)') });
/** The member routes read the department WITHOUT a uuid-shape check: a malformed id reaches the driver (22P02 → 400). */
const memberDept = z.object({ id: pathId("Department id (a uuid; a malformed one is a 400 'invalid request parameter')") });
const member = memberDept.extend({ userId: pathId('The member (Keycloak user id)') });

const NOT_FOUND = "404: `error` 'department not found' — absent, not a uuid, or another workspace's (indistinguishable). ";
const MEMBER_NOT_FOUND =
  "404: `error` 'department not found' — absent or another workspace's (indistinguishable). 400: `error` 'invalid request parameter' (a malformed department id). ";
const ADMIN_403 = "403: `error` 'workspace-admin role required' (not a workspace-admin of the request tenant; a super_admin alone is not). ";
const DEPT_ADMIN_403 = (what: string) => `403: \`error\` '${what}' (neither a workspace-admin of the request tenant nor dept-admin of this department). `;
const BAD_BODY = "400: `error` 'invalid JSON body', 'body must be an object' or the field's own message. ";
const ROLE_400 = "400: `error` 'role must be one of: dept-admin, dept-manager, dept-member, dept-viewer'. ";
const responses = (extra: string) => standardResponses(extra, { noTenant500: true });

export const DEPARTMENT_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'departments', tag: 'Departments', tenancy: 'tenant',
    module: 'src/routes/admin/departments.ts', load: () => import('../../routes/admin/departments'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'departments.list', method: 'GET', path: '/api/admin/departments', handler: 'handleListDepartments',
      summary: "The request tenant's departments", effect: 'read',
      input: z.object({ include_archived: z.string().optional().describe("'true' includes archived departments; any other value does not.") }),
      output: z.object({ data: z.array(department) }),
      responses: responses(''),
    },
    {
      id: 'departments.create', method: 'POST', path: '/api/admin/departments', handler: 'handleCreateDepartment',
      summary: 'Create a department in the request tenant (workspace-admin)', effect: 'write', successStatus: 201,
      input: z.object({ name: z.string().min(1), description: z.string().optional() }),
      output: z.object({ data: department }),
      rule: workspaceAdminRule(),
      responses: responses(ADMIN_403 + BAD_BODY + "500 also for a name the workspace already uses (the unique index; not mapped to 409). "),
    },
    {
      id: 'departments.get', method: 'GET', path: '/api/admin/departments/:id', handler: 'handleGetDepartment',
      summary: 'One department of the request tenant', effect: 'read',
      input: dept,
      output: z.object({ data: department }),
      responses: responses(NOT_FOUND),
    },
    {
      id: 'departments.update', method: 'PATCH', path: '/api/admin/departments/:id', handler: 'handlePatchDepartment',
      summary: 'Rename / re-describe a department, or set its default landing (workspace-admin)', effect: 'write',
      description: 'Partial: omitted fields are unchanged; an empty patch answers the department as it is.',
      input: dept.extend({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        default_landing: z.boolean().optional(),
      }),
      output: z.object({ data: department }),
      rule: workspaceAdminRule(),
      responses: responses(ADMIN_403 + BAD_BODY + NOT_FOUND),
    },
    {
      id: 'departments.archive', method: 'POST', path: '/api/admin/departments/:id/archive', handler: 'handleArchiveDepartment',
      summary: 'Archive a department (workspace-admin)', effect: 'destructive',
      description: 'No request body.',
      input: dept,
      output: z.object({ ok: z.literal(true) }),
      rule: workspaceAdminRule(),
      responses: responses(ADMIN_403 + NOT_FOUND),
    },
  ],
).concat(
  settingsCapabilities(
    {
      area: 'departments', tag: 'Departments', tenancy: 'tenant',
      module: 'src/routes/admin/department-members.ts', load: () => import('../../routes/admin/department-members'),
      rule: workspaceAdminRule({ deptAdminOf: 'id' }),
    },
    [
      {
        id: 'departments.list_members', method: 'GET', path: '/api/admin/departments/:id/members', handler: 'handleListDepartmentMembers',
        summary: "A department's members with their directory names (workspace-admin or dept-admin)", effect: 'read',
        input: memberDept,
        output: z.object({
          data: z.array(
            z.object({
              id: z.string(),
              dept_id: z.string(),
              user_id: z.string(),
              role: DEPT_ROLE,
              joined_at: isoTime,
              name: z.string().nullable().describe('null: the directory did not resolve the user.'),
              email: z.string().nullable(),
              resolved: z.boolean(),
            }),
          ),
          directory_error: z.string().nullable().describe('Set when the name resolution threw; the rows are kept.'),
        }),
        responses: responses(MEMBER_NOT_FOUND + DEPT_ADMIN_403('workspace-admin or dept-admin role required')),
      },
      {
        id: 'departments.add_member', method: 'POST', path: '/api/admin/departments/:id/members', handler: 'handleAddDepartmentMember',
        summary: 'Add (or re-role) a member of a department (workspace-admin or dept-admin)', effect: 'write', successStatus: 201,
        description: 'An upsert: an existing member gets the new role.',
        input: memberDept.extend({ user_id: z.string().min(1).describe('The member (Keycloak user id).'), role: DEPT_ROLE }),
        output: z.object({ ok: z.literal(true) }),
        responses: responses(MEMBER_NOT_FOUND + DEPT_ADMIN_403('dept-admin role required') + BAD_BODY + ROLE_400),
      },
      {
        id: 'departments.update_member', method: 'PATCH', path: '/api/admin/departments/:id/members/:userId', handler: 'handlePatchDepartmentMember',
        summary: "Change a department member's role (workspace-admin or dept-admin)", effect: 'write',
        input: member.extend({ role: DEPT_ROLE }),
        output: z.object({ ok: z.literal(true) }),
        responses: responses(MEMBER_NOT_FOUND + "404 also `error` 'member not found'. " + DEPT_ADMIN_403('dept-admin role required') + BAD_BODY + ROLE_400),
      },
      {
        id: 'departments.remove_member', method: 'DELETE', path: '/api/admin/departments/:id/members/:userId', handler: 'handleDeleteDepartmentMember',
        summary: 'Remove a member from a department (workspace-admin or dept-admin)', effect: 'destructive', successStatus: 204,
        description: 'Idempotent: removing a non-member is the same 204.',
        input: member,
        output: z.null(),
        responses: responses(MEMBER_NOT_FOUND + DEPT_ADMIN_403('dept-admin role required')),
      },
    ],
  ),
);
