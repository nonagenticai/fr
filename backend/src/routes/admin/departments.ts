// src/routes/admin/departments.ts
//
// Foundation Plan 2 — Task 10. Department CRUD HTTP surface scoped to the
// caller's workspace (tenant). Authentication uses the existing
// `validateAuth` middleware; authorization is enforced at the handler
// level since `agui/rbac.ts::assertRbac` is action-oriented (AG-UI) and
// not a fit for vanilla HTTP routes.
//
// RBAC summary (Spec 1 §11):
//   * GET    /api/admin/departments         — any authenticated tenant member
//   * GET    /api/admin/departments/:id     — any authenticated tenant member
//   * POST   /api/admin/departments         — workspace-admin
//   * PATCH  /api/admin/departments/:id     — workspace-admin
//   * POST   /api/admin/departments/:id/archive — workspace-admin
//
// Wave 3 RBAC follow-up: the parallel `plan2-w3-rbac-and-list` lane is
// adding the `'dept-role'` rule kind to assertRbac. This file does NOT
// rely on it (the routes are HTTP, not actions). The dept-member sub-
// resource lives in `department-members.ts`.

import { and, eq } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from '../../utils/errors';
import { db, departments } from '../../db/client';
import {
  archiveDepartment,
  createDepartment,
  listDepartments,
} from '../../services/departments';
import { userRolesService } from '../../services/user-roles';
import { isUuidShape } from '../../lib/uuid-shape';

/**
 * Workspace-admin gate — delegates to `isWorkspaceAdminVia` (THE RULE lives
 * there): realm `tenant_admin` / `admin` pinned to the raw `tenant_id` claim,
 * or a `user_roles` row with role='workspace-admin' for the caller's tenant.
 */
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

async function requireWorkspaceAdmin(
  req: Request,
): Promise<{ id: string; tenantId: string }> {
  const user = await validateAuth(req);
  if (!(await isWorkspaceAdmin(user))) {
    throw new AppError(403, 'workspace-admin role required');
  }
  return { id: user.id, tenantId: ctxTenantId(user.tenantId) };
}

async function getDepartmentScoped(
  deptId: string,
  workspaceId: string,
): Promise<typeof departments.$inferSelect | null> {
  // `departments.id` is a `uuid` column (schema.ts:1100). A non-UUID `:id` does
  // not select zero rows — it aborts with 22P02 `invalid input syntax for type
  // uuid`, which escapes GET / PATCH / archive as a bare 500 instead of the 404
  // they promise. `null` is this function's OWN miss value, so all three
  // callers keep throwing the existing `NotFoundError('department not found')`
  // and a malformed id is indistinguishable from one naming another
  // workspace's department — the same deliberate 404-leak-prevention this
  // helper's `workspace_id` filter already implements (and the contract at
  // routes/approvals.ts:~408-438).
  //
  // The single seam is enough: handlePatchDepartment parses its body BEFORE
  // calling here, so a bad body still answers 400 for malformed and absent
  // alike. `isUuidShape`, not `isValidUuid` (utils/tenant) — the latter pins
  // the version nibble to 1-8 and the variant to [89ab] and would 404 real rows.
  if (!isUuidShape(deptId)) return null;

  const [row] = await db
    .select()
    .from(departments)
    .where(and(eq(departments.id, deptId), eq(departments.workspace_id, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** GET /api/admin/departments — list departments in the caller's workspace. */
export async function handleListDepartments(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get('include_archived') === 'true';
  const rows = await listDepartments(ctxTenantId(user.tenantId), { includeArchived });
  return jsonResponse({ data: rows });
}

const CreateDeptSchema = (
  body: unknown,
): { name: string; description?: string } => {
  if (!body || typeof body !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.length === 0) {
    throw new BadRequestError('name is required');
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    throw new BadRequestError('description must be a string');
  }
  return { name: b.name, description: b.description as string | undefined };
};

/** POST /api/admin/departments — workspace-admin only. */
export async function handleCreateDepartment(req: Request): Promise<Response> {
  const user = await requireWorkspaceAdmin(req);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const body = CreateDeptSchema(raw);
  const dept = await createDepartment(ctxTenantId(user.tenantId), body);
  return jsonResponse({ data: dept }, 201);
}

/** GET /api/admin/departments/:id — any tenant member. */
export async function handleGetDepartment(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const dept = await getDepartmentScoped(id, ctxTenantId(user.tenantId));
  if (!dept) throw new NotFoundError('department not found');
  return jsonResponse({ data: dept });
}

const PatchDeptSchema = (
  body: unknown,
): {
  name?: string;
  description?: string;
  default_landing?: boolean;
} => {
  if (!body || typeof body !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const b = body as Record<string, unknown>;
  const out: { name?: string; description?: string; default_landing?: boolean } = {};
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.length === 0) {
      throw new BadRequestError('name must be a non-empty string');
    }
    out.name = b.name;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string') {
      throw new BadRequestError('description must be a string');
    }
    out.description = b.description;
  }
  if (b.default_landing !== undefined) {
    if (typeof b.default_landing !== 'boolean') {
      throw new BadRequestError('default_landing must be a boolean');
    }
    out.default_landing = b.default_landing;
  }
  return out;
};

/** PATCH /api/admin/departments/:id — workspace-admin only. */
export async function handlePatchDepartment(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await requireWorkspaceAdmin(req);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const patch = PatchDeptSchema(raw);
  // Ensure the dept belongs to the caller's workspace (404 leak prevention).
  const existing = await getDepartmentScoped(id, ctxTenantId(user.tenantId));
  if (!existing) throw new NotFoundError('department not found');
  if (Object.keys(patch).length === 0) {
    return jsonResponse({ data: existing });
  }
  const [updated] = await db
    .update(departments)
    .set(patch)
    .where(eq(departments.id, id))
    .returning();
  return jsonResponse({ data: updated });
}

/** POST /api/admin/departments/:id/archive — workspace-admin only. */
export async function handleArchiveDepartment(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await requireWorkspaceAdmin(req);
  const existing = await getDepartmentScoped(id, ctxTenantId(user.tenantId));
  if (!existing) throw new NotFoundError('department not found');
  await archiveDepartment(id);
  return jsonResponse({ ok: true });
}
