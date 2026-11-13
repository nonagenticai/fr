// services/github-app-installations.ts
//
// Persistence for `github_app_installations` (migration 125). Every read and
// write is tenant-scoped by an explicit argument; nothing here reads ambient
// request context.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db as defaultDb, githubAppInstallations } from '../db/client';
import type { GithubAppInstallation } from '../db/schema';

type Db = typeof defaultDb;

export interface BindInput {
  tenantId: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  installedByUserId: string;
  githubUserLogin: string;
}

export type BindResult =
  | { outcome: 'bound'; row: GithubAppInstallation }
  | { outcome: 'bound_to_other_tenant' };

/**
 * Bind an installation to a tenant, atomically.
 *
 * One statement: INSERT … ON CONFLICT (installation_id) WHERE revoked_at IS NULL
 * DO UPDATE … WHERE the existing ACTIVE row belongs to the SAME tenant. When it
 * belongs to another tenant the DO UPDATE is skipped, RETURNING yields no row,
 * and the caller refuses — the existing binding is never touched. Two
 * concurrent callbacks for one installation therefore cannot both win.
 *
 * A same-tenant re-install refreshes the GitHub-side facts and
 * `last_verified_at`; `installed_by_user_id` / `created_at` keep the original.
 */
export async function bindInstallation(input: BindInput, db: Db = defaultDb): Promise<BindResult> {
  const t = githubAppInstallations;
  const rows = await db
    .insert(t)
    .values({
      tenant_id: input.tenantId,
      installation_id: input.installationId,
      account_login: input.accountLogin,
      account_type: input.accountType,
      installed_by_user_id: input.installedByUserId,
      github_user_login: input.githubUserLogin,
    })
    .onConflictDoUpdate({
      target: t.installation_id,
      targetWhere: sql`${t.revoked_at} IS NULL`,
      set: {
        account_login: sql`excluded.account_login`,
        account_type: sql`excluded.account_type`,
        github_user_login: sql`excluded.github_user_login`,
        last_verified_at: sql`now()`,
      },
      setWhere: sql`${t.tenant_id} = excluded.tenant_id`,
    })
    .returning();
  const row = rows[0];
  if (!row) return { outcome: 'bound_to_other_tenant' };
  return { outcome: 'bound', row };
}

export async function listTenantInstallations(
  tenantId: string,
  opts: { includeRevoked: boolean },
  db: Db = defaultDb,
): Promise<GithubAppInstallation[]> {
  const t = githubAppInstallations;
  const where = opts.includeRevoked
    ? eq(t.tenant_id, tenantId)
    : and(eq(t.tenant_id, tenantId), isNull(t.revoked_at));
  return db.select().from(t).where(where).orderBy(desc(t.created_at));
}

/** Revoke one ACTIVE binding of this tenant. null when there is none to revoke. */
export async function revokeTenantInstallation(
  tenantId: string,
  id: string,
  db: Db = defaultDb,
): Promise<GithubAppInstallation | null> {
  const t = githubAppInstallations;
  const rows = await db
    .update(t)
    .set({ revoked_at: sql`now()` })
    .where(and(eq(t.id, id), eq(t.tenant_id, tenantId), isNull(t.revoked_at)))
    .returning();
  return rows[0] ?? null;
}

/** The ACTIVE binding for (tenant, owner), owner matched case-insensitively. */
export async function findActiveBinding(
  tenantId: string,
  owner: string,
  db: Db = defaultDb,
): Promise<{ installation_id: number; account_login: string } | null> {
  const t = githubAppInstallations;
  const rows = await db
    .select({ installation_id: t.installation_id, account_login: t.account_login })
    .from(t)
    .where(
      and(
        eq(t.tenant_id, tenantId),
        sql`lower(${t.account_login}) = lower(${owner})`,
        isNull(t.revoked_at),
      ),
    )
    .orderBy(desc(t.last_verified_at))
    .limit(1);
  return rows[0] ?? null;
}
