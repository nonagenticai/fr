/**
 * Plan 3 follow-up — userId → tenantId resolver for the agent path.
 *
 * The agent JWT today carries `sub: userId` but no tenant claim (see
 * services/agent-session.ts:signAccessToken). To layer foundation Plan 2's
 * `applyEffectiveFilter` onto AG-UI actions we need the user's
 * tenant/workspace UUID. The cheap path: pick any active row in
 * `user_roles` for this userId — single-tenant users (the common case)
 * resolve unambiguously; multi-tenant users get their first row, which is
 * deterministic for repeat calls within a session.
 *
 * FUTURE: when issueAgentSession learns to pin a tenant per session, swap
 * this for a session-row read instead of a per-call lookup. Until then,
 * the lookup is a single indexed query (`user_roles.uniq_user_tenant_role`
 * index) and is safe in hot paths.
 */

import { eq } from 'drizzle-orm';

import { db as defaultDb } from '../db/client';
import { userRoles, workspaces } from '../db/schema';

export type UserTenantDb = typeof defaultDb;

export interface UserTenant {
  id: string;
  /** workspaces.name when the row exists; `null` for tenants whose workspace
   * row hasn't been lazy-provisioned yet (handlers fall back to id-as-name). */
  name: string | null;
}

/**
 * Resolve a user's tenant (id + workspace name). Returns `null` when the user
 * has no `user_roles` row. The workspace row may not yet exist for some
 * tenants — the LEFT JOIN yields `name=null` in that case, which downstream
 * `ensureWorkspace` callers treat as "fall back to id-as-name".
 */
export async function getUserTenant(
  userId: string,
  db: UserTenantDb = defaultDb,
): Promise<UserTenant | null> {
  if (!userId) return null;
  const rows = await db
    .select({
      tenant_id: userRoles.tenant_id,
      workspace_name: workspaces.name,
    })
    .from(userRoles)
    .leftJoin(workspaces, eq(workspaces.id, userRoles.tenant_id))
    .where(eq(userRoles.user_id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.tenant_id, name: row.workspace_name ?? null };
}

export async function getUserTenantId(
  userId: string,
  db: UserTenantDb = defaultDb,
): Promise<string | null> {
  const tenant = await getUserTenant(userId, db);
  return tenant?.id ?? null;
}
