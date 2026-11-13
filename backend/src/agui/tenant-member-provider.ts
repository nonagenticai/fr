/**
 * ⭐ THE PRODUCTION `ProjectMembershipProvider` (fr-agui P1-TEAM-a, George
 * 2026-10-15: "all members of a tenant [get] access to all projects of the
 * tenant … all actions are able to be done by all members of the tenant").
 *
 * Before this, production registered NO provider, so `agui/rbac.ts` kept its
 * module-level deny-all and every `project-member` / `project-role` action was
 * refused `rbac_provider_not_registered` — for the owner too.
 *
 * The answer: `editor` when the project is tagged for the caller's RESOLVED
 * tenant, else `null` (not a member). The tenant is resolved by `rbac.ts`
 * exactly as the routes resolve it (the request-context frame's tenant — the
 * accepted `X-Active-Tenant` of a switched super-admin, the licence's pinned
 * tenant — else the JWT tenant on `ActionContext.tenantId`) and handed in as
 * the third argument. The predicate is the routes' own tenant-member lane
 * (`tenantScopedProjectFilter` with active = home = that tenant: the project's
 * tag equals the tenant, the selection hook, the dept conditions), so the two
 * gates cannot drift — tests/unit/agui/tenant-member-provider-parity.test.ts.
 *
 * ⛔ No tenant ⇒ `null`. An unresolvable tenant never becomes membership.
 * ⛔ `editor`, never `owner`: no action in this codebase is `project-role
 *    'owner'` today, and the ruling grants members "all actions", not ownership.
 *    Ownership (`projects.owner_id`) stays a fact about who created the row.
 *
 * ⛔ SWITCHED VIEW (the caller acts OUTSIDE its own tenant: `homeTenantId` set
 *    and ≠ the resolved tenant — a super-admin's accepted `X-Active-Tenant`
 *    switch). It is NOT a member there, so the ruling's widening does not reach
 *    it: `viewer` (read-only; rbac.ts refuses a write below `editor`) on a project
 *    tagged for the switched tenant, `editor` only on one it OWNS — exactly the
 *    pre-P1-TEAM owner pin that `projectWriteSelfScope` keeps. Reads match the
 *    routes' switched read lane (`includeAllOwners`: the tag). A switched frame
 *    the request-context middleware did not accept from a header is not a
 *    switch fr knows about ⇒ `null` (fail closed).
 *    ⭐ EXCEPT a SIGNED super-admin switched into that tenant (George 2026-10-27,
 *    lib/super-admin-switch.ts): it acts there as a tenant-admin, so it gets the
 *    member lane (`editor` on every project tagged for the tenant).
 *
 * Kept OUT of `agui/rbac.ts` on purpose: rbac.ts is imported by env-free guards,
 * and this module needs the db client.
 */
import { and, eq } from 'drizzle-orm';

import { db, departments, projects } from '../db/client';
import { tryGetRequestContext } from '../integrations/_lib/context';
import { projectTaggedForTenant, tenantScopedProjectFilter } from '../lib/project-access';
import { isUuidShape } from '../lib/uuid-shape';
import { frameIsSuperAdminSwitchedInto } from '../lib/super-admin-switch';
import type { ProjectMembershipProvider, ProjectRole } from './rbac';

/** The role every member of the project's tenant holds on it. */
export const TENANT_MEMBER_PROJECT_ROLE: ProjectRole = 'editor';

/** The read-only role of a caller acting outside its own tenant on a project it does not own. */
export const SWITCHED_VIEW_PROJECT_ROLE: ProjectRole = 'viewer';

export const tenantMemberProjectMembershipProvider: ProjectMembershipProvider = {
  async getRole(projectId, userId, tenantId, homeTenantId) {
    if (!userId || !isUuidShape(projectId)) return null;
    if (typeof tenantId !== 'string' || !tenantId.trim()) return null;
    // ⭐ George 2026-10-27: a super-admin SWITCHED into `tenantId` acts there as a
    // tenant-admin (lib/super-admin-switch.ts), i.e. as a member: the member lane
    // below, not the read-only switched-view `viewer`.
    const switchedSuperAdmin = frameIsSuperAdminSwitchedInto(userId, tenantId);
    if (
      !switchedSuperAdmin &&
      typeof homeTenantId === 'string' &&
      homeTenantId.length > 0 &&
      homeTenantId !== tenantId
    ) {
      if (tryGetRequestContext()?.activeTenantSource !== 'header') return null;
      const rows = await db
        .select({ owner_id: projects.owner_id })
        .from(projects)
        .where(and(eq(projects.id, projectId), projectTaggedForTenant(tenantId)))
        .limit(1);
      if (rows.length === 0) return null;
      return rows[0]!.owner_id === userId ? TENANT_MEMBER_PROJECT_ROLE : SWITCHED_VIEW_PROJECT_ROLE;
    }
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(departments, eq(projects.dept_id, departments.id))
      .where(and(eq(projects.id, projectId), tenantScopedProjectFilter(userId, tenantId, tenantId)))
      .limit(1);
    return rows.length > 0 ? TENANT_MEMBER_PROJECT_ROLE : null;
  },
};
