// src/routes/asset-scope/override.ts
//
// Foundation Plan 2 — Task 11. Replace a higher-scope `owns` of `:asset_id`
// at department or project scope with a lower-scope `override` row whose
// asset_id is `candidate_asset_id`. The CHECK constraint on the SQL side
// enforces `link_kind='override' iff overrides_id IS NOT NULL`, so this
// route MUST resolve the parent owns row before calling addOverride.
//
// RBAC (Spec 1 §11):
//   * Override at project P: project-member of P = any member of P's tenant
//     (P1-TEAM-a). Asked of `getProjectMembershipProvider()` (production:
//     agui/tenant-member-provider.ts), falling back to the tenant-scoped seam.
//   * Override at dept D: dept-admin or dept-manager of D
//     (workspace-admin is the operational backstop).
//   * ⛔ P2-b (George 2026-10-16): an override row never makes an asset
//     member-writable (routes/assets/_lib/governed-asset-write-gate.ts), and
//     this route also refuses the laundering shapes outright:
//       - `candidate_asset_id` equal to the path asset (a self-override) → 400;
//       - a NON-admin (not workspace-admin, not super-admin) recording, at
//         project P, a governed-kind candidate NOT created in P
//         (`origin_kind` 'project', `origin_project_id` = P) → 403
//         `project_copy_member_only`. `project_assets.edit`'s copies pass.

import { and, eq, sql } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import {
  BadRequestError,
  NotFoundError,
  AppError,
} from '../../utils/errors';
import { db, departments, assetAssignments } from '../../db/client';
import { canMutateProject } from './can-mutate-project';
import {
  addOverride,
  type AssetType,
} from '../../services/asset-assignments';
import {
  isWorkspaceAdmin,
  isDeptManagerOrAdmin,
  parseAssetType,
} from './promote';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { assertOverrideCandidateCreatedInProject, isGovernedKind } from '../assets/_lib/governed-asset-write-gate';

interface OverrideBody {
  project_id?: string;
  dept_id?: string;
  candidate_asset_id: string;
}

function parseOverrideBody(raw: unknown): OverrideBody {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const b = raw as Record<string, unknown>;
  if (
    typeof b.candidate_asset_id !== 'string' ||
    b.candidate_asset_id.length === 0
  ) {
    throw new BadRequestError('candidate_asset_id is required');
  }
  const projectId = typeof b.project_id === 'string' ? b.project_id : undefined;
  const deptId = typeof b.dept_id === 'string' ? b.dept_id : undefined;
  if ((projectId && deptId) || (!projectId && !deptId)) {
    throw new BadRequestError(
      'exactly one of project_id or dept_id must be provided',
    );
  }
  return {
    candidate_asset_id: b.candidate_asset_id,
    project_id: projectId,
    dept_id: deptId,
  };
}

/**
 * Is this the ONE database error the dept_id lookup is allowed to tolerate —
 * the column/table not existing in this DB revision?
 *
 * 42703 = undefined_column, 42P01 = undefined_table (Postgres SQLSTATE). Any
 * other failure means the lookup did not happen, which is not the same fact as
 * "this project has no department" and must not be recorded as one.
 */
function isMissingRelationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42703' || code === '42P01';
}

/**
 * Look up the parent `owns` row that this override replaces. The override
 * lives at (scope, target); the parent owns row lives at any *higher*
 * scope for the same (workspace, asset_type, asset_id).
 *
 * Resolution:
 *   - Department-scope override → parent is the workspace owns.
 *   - Project-scope override   → prefer a department owns matching the
 *     project's dept (if `projects.dept_id` exists in this DB rev), else
 *     fall back to the workspace owns.
 *
 * Plan 2 Task 6 is still blocked on `projects.dept_id` being added; until
 * then the dept-preference branch is unreachable and this helper happily
 * returns the workspace owns id. The catch on the dept_id lookup means
 * the function still works on DBs where the column genuinely is missing.
 *
 * Returns null when no parent exists — caller 400s (an override has no
 * meaning without a row to override).
 */
async function findParentOwnsId(
  workspaceId: string,
  assetType: AssetType,
  assetId: string,
  overrideScope: 'department' | 'project',
  overrideTargetId: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(assetAssignments)
    .where(
      and(
        eq(assetAssignments.workspace_id, workspaceId),
        eq(assetAssignments.asset_type, assetType),
        eq(assetAssignments.asset_id, assetId),
        eq(assetAssignments.link_kind, 'owns'),
      ),
    );

  // Department-scope override: parent is workspace owns.
  if (overrideScope === 'department') {
    const ws = rows.find((r) => r.scope_kind === 'workspace');
    return ws?.id ?? null;
  }

  // Project-scope override: try the dept owns of the project's dept (if
  // any). The column may not exist in this DB rev (Plan 2 Task 6 backfill
  // is blocked) — tolerate THAT and fall through to workspace.
  //
  // ⚠️ The catch used to be un-narrowed while the comment described one cause.
  // Intent documented, implementation wider — so ANY db failure (transient
  // error, timeout, pool exhaustion) also produced `projectDeptId = null` and
  // the code fell through to the WORKSPACE owns row instead of the DEPARTMENT
  // one. That is not a display degrade: `parentId` is persisted as
  // `overrides_id` (:226) and the caller is answered `{ ok: true }`, so a
  // transient blip silently writes an override anchored to the wrong, BROADER
  // scope and nothing anywhere records that it happened.
  //
  // Narrowed to the documented case only: 42703 undefined_column / 42P01
  // undefined_table. Everything else propagates and the request fails loudly
  // rather than persisting a wrong row.
  let projectDeptId: string | null = null;
  try {
    const projectRow = await db.execute<{ dept_id: string | null }>(
      sql`SELECT dept_id FROM projects WHERE id = ${overrideTargetId} LIMIT 1`,
    );
    if (Array.isArray(projectRow) && projectRow.length > 0) {
      projectDeptId = (projectRow[0] as { dept_id: string | null }).dept_id;
    }
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    projectDeptId = null;
  }
  if (projectDeptId) {
    const dept = rows.find(
      (r) => r.scope_kind === 'department' && r.target_id === projectDeptId,
    );
    if (dept) return dept.id;
  }
  const ws = rows.find((r) => r.scope_kind === 'workspace');
  return ws?.id ?? null;
}

/** POST /api/asset-scope/:asset_type/:asset_id/override */
export async function handleOverride(
  req: Request,
  assetTypeRaw: string,
  assetId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const assetType = parseAssetType(assetTypeRaw);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const body = parseOverrideBody(raw);
  if (body.candidate_asset_id.toLowerCase() === assetId.toLowerCase()) {
    throw new BadRequestError('candidate_asset_id must differ from the asset it overrides');
  }

  let scope: 'department' | 'project';
  let targetId: string;

  if (body.dept_id) {
    scope = 'department';
    targetId = body.dept_id;
    // Verify dept belongs to caller's workspace.
    const [deptRow] = await db
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.id, targetId),
          eq(departments.workspace_id, ctxTenantId(user.tenantId)),
        ),
      )
      .limit(1);
    if (!deptRow) throw new NotFoundError('department not found');
    if (
      !(await isWorkspaceAdmin(user)) &&
      !(await isDeptManagerOrAdmin(targetId, user.id))
    ) {
      throw new AppError(403, 'dept-manager role required');
    }
  } else {
    // project_id branch — the parser guarantees exactly one is set.
    scope = 'project';
    targetId = body.project_id as string;
    const wsAdmin = await isWorkspaceAdmin(user);
    if (!wsAdmin && !(await canMutateProject(targetId, user))) {
      throw new AppError(403, 'project-member role required');
    }
    // A member may record as P's override only a copy CREATED in P.
    if (!wsAdmin && !isSuperAdmin(user) && isGovernedKind(assetType)) {
      await assertOverrideCandidateCreatedInProject(assetType, body.candidate_asset_id, targetId);
    }
  }

  const parentId = await findParentOwnsId(
    ctxTenantId(user.tenantId),
    assetType,
    assetId,
    scope,
    targetId,
  );
  if (!parentId) {
    throw new BadRequestError(
      'no higher-scope owns row exists for this asset; nothing to override',
    );
  }

  await addOverride(ctxTenantId(user.tenantId), assetType, body.candidate_asset_id, {
    scope,
    target_id: targetId,
    overrides_id: parentId,
    by: user.id,
  });
  return jsonResponse({ ok: true });
}
