// src/routes/asset-scope/promote.ts
//
// Foundation Plan 2 — Task 11. Promote an asset to a higher scope by
// inserting an additional `owns` row at workspace or department scope.
// The `upsertOwns` service is idempotent at the partial-unique-index
// level, so re-promotion is a safe no-op.
//
// RBAC (Spec 1 §11):
//   * Promote to workspace: `tenant-role` workspace-admin.
//   * Promote to dept X: `dept-role` deptId=X min='dept-manager'. The
//     parallel `plan2-w3-rbac-and-list` lane adds the dept-role rule
//     to assertRbac; this HTTP route does the dept-manager check
//     directly (assertRbac is action-oriented and not a fit for HTTP
//     routes — same shape as routes/admin/department-members.ts).

import { and, eq } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import {
  BadRequestError,
  NotFoundError,
  AppError,
} from '../../utils/errors';
import { db, departments } from '../../db/client';
import {
  upsertOwns,
  type AssetType,
} from '../../services/asset-assignments';
import { getMemberRole } from '../../services/department-members';
import { userRolesService } from '../../services/user-roles';

const ASSET_TYPES: readonly AssetType[] = [
  'requirement',
  'principle',
  'decision',
  'kag_document',
  'workflow',
  'trigger',
  'artifact',
  'channel',
] as const;

function parseAssetType(raw: string): AssetType {
  if (!ASSET_TYPES.includes(raw as AssetType)) {
    throw new BadRequestError(
      `unknown asset_type: ${raw}; must be one of ${ASSET_TYPES.join(', ')}`,
    );
  }
  return raw as AssetType;
}

async function isWorkspaceAdmin(user: {
  id: string;
  roles: string[];
  tenantId: string;
}): Promise<boolean> {
  // Delegates to the single canonical implementation. This used to be an
  // inline copy of it; four files carried near-identical copies and a fifth
  // (routes/assets/kag.ts) carried a copy that had lost the DB fallback
  // entirely, which is how six destructive verbs ended up gated on a claim
  // nobody holds. One implementation, so the next drift has nowhere to hide.
  return userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
}

/** True iff the user is dept-admin or dept-manager of `deptId`. */
async function isDeptManagerOrAdmin(deptId: string, userId: string): Promise<boolean> {
  const role = await getMemberRole(deptId, userId);
  return role === 'dept-admin' || role === 'dept-manager';
}

/** Workspace-admin OR dept-admin of any dept in the workspace can also promote
 *  to dept (workspace-admin is the operational backstop for org-wide promotion).
 */
async function canPromoteToDept(
  user: { id: string; roles: string[]; tenantId: string },
  deptId: string,
  workspaceId: string,
): Promise<boolean> {
  if (await isWorkspaceAdmin(user)) return true;
  // Verify the dept belongs to this workspace before allowing the
  // dept-role check — otherwise a dept-manager of dept-X in workspace-A
  // could assert rights on dept-Y of workspace-B by id-spoofing.
  const [deptRow] = await db
    .select()
    .from(departments)
    .where(and(eq(departments.id, deptId), eq(departments.workspace_id, workspaceId)))
    .limit(1);
  if (!deptRow) return false;
  return isDeptManagerOrAdmin(deptId, user.id);
}

interface PromoteToWorkspaceBody {
  to: 'workspace';
}
interface PromoteToDeptBody {
  to: { dept_id: string };
}
type PromoteBody = PromoteToWorkspaceBody | PromoteToDeptBody;

function parsePromoteBody(raw: unknown): PromoteBody {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const b = raw as Record<string, unknown>;
  if (b.to === 'workspace') return { to: 'workspace' };
  if (b.to && typeof b.to === 'object') {
    const dept = (b.to as Record<string, unknown>).dept_id;
    if (typeof dept === 'string' && dept.length > 0) {
      return { to: { dept_id: dept } };
    }
  }
  throw new BadRequestError(
    "body.to must be 'workspace' or { dept_id: string }",
  );
}

/** POST /api/asset-scope/:asset_type/:asset_id/promote */
export async function handlePromote(
  req: Request,
  assetTypeRaw: string,
  assetId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const assetType = parseAssetType(assetTypeRaw);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const body = parsePromoteBody(raw);

  if (body.to === 'workspace') {
    if (!(await isWorkspaceAdmin(user))) {
      throw new AppError(403, 'workspace-admin role required to promote to workspace');
    }
    await upsertOwns(ctxTenantId(user.tenantId), assetType, assetId, {
      scope: 'workspace',
      by: user.id,
    });
    return jsonResponse({ ok: true });
  }

  // Dept promotion.
  const deptId = body.to.dept_id;
  if (!(await canPromoteToDept(user, deptId, ctxTenantId(user.tenantId)))) {
    // 404 if dept doesn't belong to caller's workspace, 403 otherwise.
    const [deptRow] = await db
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.id, deptId),
          eq(departments.workspace_id, ctxTenantId(user.tenantId)),
        ),
      )
      .limit(1);
    if (!deptRow) throw new NotFoundError('department not found');
    throw new AppError(403, 
      'dept-manager role on the target department required',
    );
  }
  await upsertOwns(ctxTenantId(user.tenantId), assetType, assetId, {
    scope: 'department',
    target_id: deptId,
    by: user.id,
  });
  return jsonResponse({ ok: true });
}

// Re-export helpers used by sibling routes (override.ts, block.ts).
export { isWorkspaceAdmin, isDeptManagerOrAdmin, parseAssetType };
