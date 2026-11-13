// src/services/workspaces.ts
//
// Foundation Plan 2 — workspaces are the org root for the new tenancy model.
// A workspace shares its UUID with the tenant_id used by the legacy
// `tenant_id` columns; one workspace per tenant. Surface kept minimal:
//
//   * ensureWorkspace(id, name)  — idempotent insert; returns the row
//   * getWorkspace(id)            — single-row lookup or null
//
// All other CRUD lives in routes/services that compose this with
// `departments` + `department_members`. `db` is a parameter so a caller can
// run these inside its own transaction (mirrors `services/user-roles.ts`).

import { eq } from 'drizzle-orm';
import { db as defaultDb, workspaces } from '../db/client';

export type WorkspacesDb = typeof defaultDb;

/**
 * Idempotent: returns the existing row if `id` already exists, otherwise
 * inserts and returns the new row. Safe to call on every request that
 * needs the workspace to exist (e.g. backfill of legacy tenant ids).
 */
export async function ensureWorkspace(
  id: string,
  name: string,
  db: WorkspacesDb = defaultDb,
): Promise<typeof workspaces.$inferSelect> {
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db.insert(workspaces).values({ id, name }).returning();
  if (!inserted[0]) {
    throw new Error(`ensureWorkspace: insert returned no row for id=${id}`);
  }
  return inserted[0];
}

/** Single-row lookup. Returns null when the workspace does not exist. */
export async function getWorkspace(
  id: string,
  db: WorkspacesDb = defaultDb,
): Promise<typeof workspaces.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return row ?? null;
}
