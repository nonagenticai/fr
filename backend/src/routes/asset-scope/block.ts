// src/routes/asset-scope/block.ts
//
// Foundation Plan 2 — Task 11. Hide an asset from the effective set at
// department or project scope by inserting a `block` row. Unlike
// `override`, block does not replace the asset — it just suppresses the
// higher-scope `owns` for the matching (asset_type, asset_id, scope,
// target).
//
// RBAC mirrors `override.ts`:
//   * Block at project P: project-member of P.
//   * Block at dept D: dept-admin or dept-manager of D (workspace-admin
//     backstop).

import { and, eq } from 'drizzle-orm';
import { canMutateProject } from './can-mutate-project';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import {
  BadRequestError,
  NotFoundError,
  AppError,
} from '../../utils/errors';
import { db, departments } from '../../db/client';
import { addBlock } from '../../services/asset-assignments';
import {
  isWorkspaceAdmin,
  isDeptManagerOrAdmin,
  parseAssetType,
} from './promote';

interface BlockBody {
  project_id?: string;
  dept_id?: string;
}

function parseBlockBody(raw: unknown): BlockBody {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const b = raw as Record<string, unknown>;
  const projectId = typeof b.project_id === 'string' ? b.project_id : undefined;
  const deptId = typeof b.dept_id === 'string' ? b.dept_id : undefined;
  if ((projectId && deptId) || (!projectId && !deptId)) {
    throw new BadRequestError(
      'exactly one of project_id or dept_id must be provided',
    );
  }
  return { project_id: projectId, dept_id: deptId };
}

/** POST /api/asset-scope/:asset_type/:asset_id/block */
export async function handleBlock(
  req: Request,
  assetTypeRaw: string,
  assetId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const assetType = parseAssetType(assetTypeRaw);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const body = parseBlockBody(raw);

  let scope: 'department' | 'project';
  let targetId: string;

  if (body.dept_id) {
    scope = 'department';
    targetId = body.dept_id;
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
    scope = 'project';
    targetId = body.project_id as string;
    if (
      !(await isWorkspaceAdmin(user)) &&
      !(await canMutateProject(targetId, user))
    ) {
      throw new AppError(403, 'project-member role required');
    }
  }

  await addBlock(ctxTenantId(user.tenantId), assetType, assetId, {
    scope,
    target_id: targetId,
    by: user.id,
  });
  return jsonResponse({ ok: true });
}
