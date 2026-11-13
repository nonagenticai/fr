// src/services/workspace-admin-revoke-lock.ts
//
// Serialises workspace-admin revokes per tenant (fr#1312).
//
// The last-workspace-admin guard (`last-workspace-admin-guard.ts`) is
// check-then-act: read the admin set, decide "someone else remains", then write.
// Two admins revoking EACH OTHER concurrently both read a set of two, both pass,
// and both delete — the tenant is left with zero admins in the DB and in
// Keycloak, recoverable only by a super-admin. The fix is to make the whole
// sequence (fresh realm-admin read → guard → Keycloak write-through revoke → DB
// delete) mutually exclusive per tenant.
//
// WHY TRANSACTION-SCOPED: fr-backend reaches Postgres through pgbouncer in
// transaction-pooling mode. A session-level `pg_advisory_lock` and its later
// unlock can land on different server backends and leak the lock forever, so
// only an `_xact_` advisory lock inside one transaction is allowed (see
// `src/db/advisory-lock-keys.ts`, "Scope note"). The lock releases at
// COMMIT/ROLLBACK, i.e. when `fn` settles.
//
// WHY ONE CONNECTION PER REVOKE: pgbouncer gives each fr replica a pool of only
// 2 (+1 reserve) server connections. The lock transaction pins one of them for
// as long as `fn` runs — including its Keycloak HTTP calls. If `fn` did its DB
// reads/writes through the global `db`, every revoke would need a SECOND server
// connection while holding the first: three concurrent revokes on different
// tenants would hold all three and each wait for a fourth, deadlocking pgbouncer
// until `query_wait_timeout` (120s) and stalling every other fr request with
// them. So `fn` RECEIVES the transaction handle and must do ALL of its DB work
// through it — never through the global `db`/`queryClient`. The DB delete then
// commits together with the lock-tx commit, which is the same instant the lock
// is released, so the next holder's guard reads the post-revoke admin set.
//
// WHY A TRY-LOCK: a blocking `pg_advisory_xact_lock` waiter also pins a server
// connection for as long as it waits. With a pool of 2+1, two same-tenant
// waiters are enough to starve the replica. `pg_try_advisory_xact_lock` answers
// at once; a caller that does not get the lock gets `WorkspaceAdminRevokeBusy`
// (routes answer 503, retry shortly) and its `fn` never runs. Revokes are rare
// human actions, so "busy, retry" costs nothing, and a pinned pool costs fr.
//
// The key is `hashtext('ws-admin-revoke:' || tenantId)` — the per-row hashtext
// keyspace documented in `advisory-lock-keys.ts`, not a registered integer.

import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { AppError } from '../utils/errors';

/**
 * Another workspace-admin revoke for this tenant holds the lock right now.
 * An AppError(503) so `handleError` maps it even where a route forgets to;
 * the routes still translate it explicitly
 * to keep their own body shape.
 */
export class WorkspaceAdminRevokeBusy extends AppError {
  constructor(tenantId: string) {
    super(503, `another workspace-admin revoke is in progress for tenant ${tenantId}`);
    this.name = 'WorkspaceAdminRevokeBusy';
    this.code = 'workspace_admin_revoke_busy';
  }
}

/** The drizzle transaction handle `fn` receives. ALL of fn's DB work goes through it. */
export type WorkspaceAdminRevokeTx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

const realRunner = async <T>(
  tenantId: string,
  fn: (tx: WorkspaceAdminRevokeTx) => Promise<T>,
): Promise<T> => {
  const lockKey = `ws-admin-revoke:${tenantId}`;
  return defaultDb.transaction(async (tx) => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked`,
    );
    if (rows[0]?.locked !== true) throw new WorkspaceAdminRevokeBusy(tenantId);
    // Errors from fn propagate unchanged (and roll back, releasing the lock).
    return fn(tx);
  });
};

/**
 * Run `fn(tx)` while holding the per-tenant workspace-admin revoke lock.
 * Throws `WorkspaceAdminRevokeBusy` immediately when another revoke for the
 * tenant holds it; any error from `fn` propagates as-is. `fn` MUST do all of
 * its DB work through `tx` (see header: pool 2+1).
 */
export function withWorkspaceAdminRevokeLock<T>(
  tenantId: string,
  fn: (tx: WorkspaceAdminRevokeTx) => Promise<T>,
): Promise<T> {
  return realRunner(tenantId, fn);
}
