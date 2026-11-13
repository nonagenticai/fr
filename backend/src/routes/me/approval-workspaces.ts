// src/routes/me/approval-workspaces.ts
//
// GET /api/me/approval-workspaces — the data behind the approvals page's
// "switch workspace" hint (fr row 14d), the twin of 14b's
// GET /api/me/project-workspaces.
//
// Since fr row 14d every approvals lane reads `approvals.tenant_id = <active
// tenant>` — a super-admin's home view no longer lists every tenant's queue. A
// super-admin whose active workspace has nothing pending therefore needs to be
// told WHERE the pending work is, so it never silently disappears. This
// endpoint says where — but ONLY for PLATFORM workspaces.
//
// ⛔ SUPER-ADMIN ONLY, PLATFORM ONLY, ENFORCED TWICE (owner ruling "the system
// never reads customer data"): a customer workspace's name or pending count
// must never reach this response.
//   1. Candidates are the caller's accessible workspaces (`listAccessibleTenants`,
//      the switcher's list) filtered by `isPlatformTenant` — every platform
//      tenant is a switch target the X-Active-Tenant gate admits with no lookup
//      (lib/super-admin-switch-target.ts), so a workspace offered here is one
//      the one-click switch will be admitted to.
//   2. The count query itself additionally requires `approvals.tenant_id` to be
//      in `PLATFORM_TENANT_IDS`.
// A non-super-admin gets `{ items: [] }` (200, not 403): the page asks on every
// empty queue and an ordinary user has no switch to offer.
//
// Each count is the pending population of that workspace as a switched
// super-admin sees it: pending rows with no project, or on a non-archived
// project tagged for that workspace (an approval whose tenant_id disagrees
// with its project's tag is invisible from either side, so it is not counted).

import { and, count, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db, approvals, projects } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { listAccessibleTenants } from '../../lib/accessible-tenants';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { PROJECT_KC_TENANT } from '../../lib/project-access';
import { isPlatformTenant, PLATFORM_TENANT_IDS } from '../../middleware/internal-tenant-only';
import { jsonResponse } from '../../utils/response';

export interface ApprovalWorkspaceHintEntry {
  id: string;
  name: string;
  pending_count: number;
}

/**
 * Barrier 1 (pure, exported so it is tested on its own — barrier 2 in the
 * count query would otherwise mask its removal): only PLATFORM workspaces the
 * switch gate admits, never the active one, never an archived one.
 */
export function approvalHintCandidates<T extends { id: string; archived_at: Date | null }>(
  tenants: readonly T[],
  activeTenantId: string,
): T[] {
  return tenants.filter((t) => isPlatformTenant(t.id) && t.id !== activeTenantId && !t.archived_at);
}

export async function handleListMyApprovalWorkspaces(req: Request): Promise<Response> {
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

  if (!isSuperAdmin(user)) return jsonResponse({ items: [] });

  const activeTenantId = ctxTenantId(user.tenantId);
  const platformIds = [...PLATFORM_TENANT_IDS];
  const tenants = await listAccessibleTenants(user);
  const candidates = approvalHintCandidates(tenants, activeTenantId);

  const out: ApprovalWorkspaceHintEntry[] = [];
  for (const t of candidates) {
    const rows = await db
      .select({ n: count() })
      .from(approvals)
      .leftJoin(projects, eq(approvals.project_id, projects.id))
      .where(
        and(
          eq(approvals.tenant_id, t.id),
          // ⛔ The second, independent platform barrier (see header).
          inArray(approvals.tenant_id, platformIds),
          eq(approvals.status, 'pending'),
          or(
            isNull(approvals.project_id),
            and(eq(PROJECT_KC_TENANT, t.id), ne(projects.status, 'archived')),
          ),
        ),
      );
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) out.push({ id: t.id, name: t.name, pending_count: n });
  }

  return jsonResponse({ items: out });
}
