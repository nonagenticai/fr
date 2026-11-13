// src/routes/admin/department-members.ts
//
// Foundation Plan 2 — Task 10. Department membership CRUD nested under
// /api/admin/departments/:id/members.
//
// RBAC summary (Spec 1 §11):
//   * GET    /:deptId/members              — workspace-admin OR dept-admin of :deptId
//   * POST   /:deptId/members              — dept-admin of :deptId
//   * PATCH  /:deptId/members/:user_id     — dept-admin of :deptId
//   * DELETE /:deptId/members/:user_id     — dept-admin of :deptId
//
// Wave 3 RBAC follow-up (`plan2-w3-rbac-and-list` lane): the dept-role
// rule kind in `agui/rbac.ts` will cover the AG-UI side. This HTTP layer
// resolves dept-admin directly via `getMemberRole` (no rbac.ts change
// required). Workspace-admin is a backstop for the GET path so an
// org-wide admin can audit any dept's members without joining first.
//
// All endpoints require the dept to belong to the caller's workspace —
// cross-workspace access returns 404 (not 403) to avoid existence leaks.
//
// GET response: `{ data: DepartmentMemberEntry[], directory_error }`. The
// rows carry Keycloak display fields resolved server-side so the admin UI
// never has to render a bare subject UUID under a column headed "User" —
// see "Member identity hydration" below for the failure semantics.

import { and, eq } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse, noContentResponse } from '../../utils/response';
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from '../../utils/errors';
import { db, departments } from '../../db/client';
import {
  addMember,
  getMemberRole,
  listMembers,
  removeMember,
} from '../../services/department-members';
import { userRolesService } from '../../services/user-roles';
import { keycloak } from '../../services/keycloak';
import type { DeptRole } from '../../db/schema';

// --- Member identity hydration -----------------------------------------
//
// `department_members.user_id` is a bare Keycloak subject UUID and there is
// no local `users` table in fr, so the admin member table had nothing to
// render but the raw uuid under a column headed "User". Hydrate it here,
// server-side, with the SAME batch primitive `routes/admin/users.ts` and
// `routes/admin/licenses-admin.ts` use — do NOT add a second resolver.
//
// The chunk size doubles as the per-call cap: `keycloak.resolveUsers`
// SLICES anything past its cap and says nothing, so passing a cap larger
// than the chunk would silently drop ids. Chunking instead of capping is
// deliberate and matches `routes/admin/users.ts`: a department roster is a
// bounded, admin-only, non-polled list, so resolving *everyone* is right —
// unlike `routes/approvals.ts`, which accepts truncation because it is
// polled every 30s.
const RESOLVE_CHUNK = 50;

type MemberIdentity = { id: string; email: string | null; name: string };
type MemberIdentityMap = Record<string, MemberIdentity>;

/**
 * Resolve a batch of member ids, best-effort.
 *
 * ⚠️ `directory_error` is NOT a complete outage detector, and the caller
 * must not treat it as one. `keycloak.getUserById` swallows timeouts,
 * non-2xx and absent admin creds and returns `null`, so `resolveUsers`
 * only throws on something genuinely unexpected. A plain Keycloak outage
 * therefore comes back as an all-miss batch with `directory_error: null`,
 * indistinguishable *here* from "every one of these accounts was deleted".
 * The UI closes that gap with the one piece of evidence this layer cannot
 * have: if any OTHER member in the same batch resolved, the directory
 * answered, so an unresolved row is genuinely deleted; if none did, it
 * says "unavailable" rather than accusing every member of being deleted.
 *
 * Partial results are kept on throw: names already resolved are still
 * better than none, and the rows themselves are never dropped — a
 * directory hiccup must not empty an admin member list.
 */
async function resolveMemberIdentities(
  ids: string[],
): Promise<{ identities: MemberIdentityMap; directoryError: string | null }> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { identities: {}, directoryError: null };
  const identities: MemberIdentityMap = {};
  try {
    for (let i = 0; i < unique.length; i += RESOLVE_CHUNK) {
      Object.assign(
        identities,
        await keycloak.resolveUsers(
          unique.slice(i, i + RESOLVE_CHUNK),
          RESOLVE_CHUNK,
        ),
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[department-members] identity resolve failed (${unique.length} ids): ${reason}`,
    );
    return { identities, directoryError: reason };
  }
  return { identities, directoryError: null };
}

const DEPT_ROLES: readonly DeptRole[] = [
  'dept-admin',
  'dept-manager',
  'dept-member',
  'dept-viewer',
] as const;

function parseDeptRole(raw: unknown): DeptRole {
  if (typeof raw !== 'string' || !DEPT_ROLES.includes(raw as DeptRole)) {
    throw new BadRequestError(
      `role must be one of: ${DEPT_ROLES.join(', ')}`,
    );
  }
  return raw as DeptRole;
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

async function isDeptAdmin(deptId: string, userId: string): Promise<boolean> {
  const role = await getMemberRole(deptId, userId);
  return role === 'dept-admin';
}

/** Resolve the dept and assert it belongs to the caller's workspace. */
async function getDeptScoped(
  deptId: string,
  workspaceId: string,
): Promise<typeof departments.$inferSelect> {
  const [row] = await db
    .select()
    .from(departments)
    .where(and(eq(departments.id, deptId), eq(departments.workspace_id, workspaceId)))
    .limit(1);
  if (!row) throw new NotFoundError('department not found');
  return row;
}

/** GET /api/admin/departments/:id/members — workspace-admin OR dept-admin. */
export async function handleListDepartmentMembers(
  req: Request,
  deptId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await getDeptScoped(deptId, ctxTenantId(user.tenantId));
  const wsAdmin = await isWorkspaceAdmin(user);
  if (!wsAdmin) {
    if (!(await isDeptAdmin(deptId, user.id))) {
      throw new AppError(403, 'workspace-admin or dept-admin role required');
    }
  }
  const rows = await listMembers(deptId);
  const { identities, directoryError } = await resolveMemberIdentities(
    rows.map((r) => r.user_id),
  );
  // Spread the row first: `user_id`/`role`/`joined_at` stay byte-identical
  // (joined_at keeps its Date→ISO serialisation), the identity fields are
  // purely ADDITIVE, and the id remains authoritative for every mutation.
  const data = rows.map((r) => {
    const person = identities[r.user_id];
    return {
      ...r,
      name: person?.name.trim() || null,
      email: person?.email ?? null,
      resolved: person !== undefined,
    };
  });
  return jsonResponse({ data, directory_error: directoryError });
}

/** POST /api/admin/departments/:id/members — dept-admin of :id. */
export async function handleAddDepartmentMember(
  req: Request,
  deptId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await getDeptScoped(deptId, ctxTenantId(user.tenantId));
  // Workspace-admin is also allowed to bootstrap the first dept-admin —
  // otherwise a freshly-created dept would have no admin and nobody
  // could promote the first member. This matches the bootstrap pattern
  // in user-roles.ts.
  const wsAdmin = await isWorkspaceAdmin(user);
  if (!wsAdmin && !(await isDeptAdmin(deptId, user.id))) {
    throw new AppError(403, 'dept-admin role required');
  }
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.user_id !== 'string' || body.user_id.length === 0) {
    throw new BadRequestError('user_id is required');
  }
  const role = parseDeptRole(body.role);
  await addMember(deptId, body.user_id, role);
  return jsonResponse({ ok: true }, 201);
}

/** PATCH /api/admin/departments/:id/members/:user_id — dept-admin of :id. */
export async function handlePatchDepartmentMember(
  req: Request,
  deptId: string,
  userIdParam: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await getDeptScoped(deptId, ctxTenantId(user.tenantId));
  const wsAdmin = await isWorkspaceAdmin(user);
  if (!wsAdmin && !(await isDeptAdmin(deptId, user.id))) {
    throw new AppError(403, 'dept-admin role required');
  }
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const role = parseDeptRole((raw as Record<string, unknown>).role);
  // Ensure the member exists (404 vs. silently-upserting a new member).
  const existing = await getMemberRole(deptId, userIdParam);
  if (existing === null) throw new NotFoundError('member not found');
  await addMember(deptId, userIdParam, role);
  return jsonResponse({ ok: true });
}

/** DELETE /api/admin/departments/:id/members/:user_id — dept-admin of :id. */
export async function handleDeleteDepartmentMember(
  req: Request,
  deptId: string,
  userIdParam: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await getDeptScoped(deptId, ctxTenantId(user.tenantId));
  const wsAdmin = await isWorkspaceAdmin(user);
  if (!wsAdmin && !(await isDeptAdmin(deptId, user.id))) {
    throw new AppError(403, 'dept-admin role required');
  }
  await removeMember(deptId, userIdParam);
  return noContentResponse();
}
