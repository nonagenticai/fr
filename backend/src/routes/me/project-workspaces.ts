// src/routes/me/project-workspaces.ts
//
// GET /api/me/project-workspaces — the data behind the projects page's
// EMPTY-STATE hint (fr row 14b): "No projects in this workspace. Switch
// workspace →".
//
// Since fr row 14b a project is visible only in the workspace its own tag
// names, so a super-admin's cold home view (and any user's wrong-workspace view)
// can be legitimately empty while their projects live one switch away. This
// endpoint says WHERE — but ONLY for PLATFORM workspaces.
//
// ⛔ PLATFORM ONLY, ENFORCED TWICE, for every caller INCLUDING a super_admin
// (owner ruling "the system never reads customer data"): a customer
// workspace's name or project count must never reach this response.
//   1. Candidates are the caller's switchable workspaces (`listAccessibleTenants`,
//      the same list the header switcher shows) filtered by `isPlatformTenant`.
//   2. The count query itself additionally requires the project's own tag to be
//      in `PLATFORM_TENANT_IDS`, so even a dept-lane row or a future widening
//      of the shared filter cannot count a customer-tagged project.
//
// Each count is the SAME visibility the caller would get after switching —
// it reuses `tenantScopedProjectFilter` with the candidate as the active
// tenant (switched view for a super-admin, the owner branch otherwise), and
// excludes archived rows like the default list.

import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { db, projects, departments } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { listAccessibleTenants } from '../../lib/accessible-tenants';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import {
  PROJECT_KC_TENANT,
  licenceProjectScope,
  tenantScopedProjectFilter,
} from '../../lib/project-access';
import { isPlatformTenant, PLATFORM_TENANT_IDS } from '../assets/_lib/system-union';
import { jsonResponse } from '../../utils/response';
import { projectIsVisible } from '../../lib/project-live-status';

export interface ProjectWorkspaceHintEntry {
  id: string;
  name: string;
  project_count: number;
}

/**
 * Barrier 1 (pure, exported so it is tested on its own — barrier 2 in the
 * count query would otherwise mask its removal): only PLATFORM workspaces,
 * never the active one, never an archived one.
 */
export function projectHintCandidates<T extends { id: string; archived_at: Date | null }>(
  tenants: readonly T[],
  activeTenantId: string,
): T[] {
  return tenants.filter(
    (t) => isPlatformTenant(t.id) && t.id !== activeTenantId && !t.archived_at,
  );
}

export async function handleListMyProjectWorkspaces(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status =
      (e as { status?: number; statusCode?: number }).statusCode ??
      (e as { status?: number }).status ??
      401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  const activeTenantId = ctxTenantId(user.tenantId);
  const platformIds = [...PLATFORM_TENANT_IDS];
  const tenants = await listAccessibleTenants(user);
  const candidates = projectHintCandidates(tenants, activeTenantId);

  const out: ProjectWorkspaceHintEntry[] = [];
  const superAdmin = isSuperAdmin(user);
  for (const t of candidates) {
    const switched = t.id !== user.tenantId;
    const rows = await db
      .select({ n: count() })
      .from(projects)
      .leftJoin(departments, eq(projects.dept_id, departments.id))
      .where(
        and(
          // The SAME lane the caller gets after switching to `t`: a
          // super-admin switched away gets `includeAllOwners`; a super-admin
          // whose candidate is their HOME gets the home-view read lane
          // (`crossTenantReadOnly` = every owner, tag == home — exactly what
          // `handleListProjects` serves via `isSuperAdminHomeView`). Without
          // the second flag that candidate fell through to the owner-only
          // branch and UNDERCOUNTED (fr row 14b fixer, item 5). Both lanes are
          // tag-predicated; barrier 2 below still applies to each.
          tenantScopedProjectFilter(user.id, t.id, user.tenantId, {
            includeAllOwners: switched && superAdmin,
            crossTenantReadOnly: !switched && superAdmin,
            ...licenceProjectScope(user),
          }),
          // ⛔ The second, independent platform barrier (see header).
          inArray(PROJECT_KC_TENANT, platformIds),
          // Openable projects only: a request's pending/cancelled pre-approval
          // row is not a project the user can open; a DELIVERED hunt (173) is.
          projectIsVisible(),
        ),
      );
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) out.push({ id: t.id, name: t.name, project_count: n });
  }

  return jsonResponse({ items: out });
}
