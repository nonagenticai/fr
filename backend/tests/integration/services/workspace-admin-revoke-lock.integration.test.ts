// tests/integration/services/workspace-admin-revoke-lock.integration.test.ts
//
// Proves the fr#1312 per-tenant workspace-admin revoke lock against a REAL
// Postgres, through the real `withWorkspaceAdminRevokeLock` (no seam).
//
// WHY AN INTEGRATION TEST. The whole substance of the lock is database-side:
// that `pg_try_advisory_xact_lock(hashtext(...))` inside one drizzle
// transaction really refuses a second caller for the SAME tenant while the
// first transaction is open, that a DIFFERENT tenant hashes to a different key,
// and that the lock is released at COMMIT/ROLLBACK. A mocked
// client would assert only that we wrote the strings we wrote.
//
// Tenant ids are random per test so parallel runs never contend on a key.

import { afterAll, expect } from 'bun:test';
import { and, eq } from 'drizzle-orm';

import { db, queryClient, userRoles } from '../../../src/db/client';
import {
  WorkspaceAdminRevokeBusy,
  withWorkspaceAdminRevokeLock,
} from '../../../src/services/workspace-admin-revoke-lock';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('workspace-admin-revoke-lock');

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves to 'timeout' if `p` has not settled within `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
}

const seededUsers: string[] = [];
afterAll(async () => {
  if (seededUsers.length > 0) {
    await queryClient`DELETE FROM user_roles WHERE user_id = ANY(${seededUsers})`;
  }
});

itDb('a SAME-tenant second call while the first holds the lock throws Busy IMMEDIATELY, and its fn never runs', async () => {
  const tenant = crypto.randomUUID();
  const aEntered = deferred();
  const releaseA = deferred();

  const a = withWorkspaceAdminRevokeLock(tenant, async () => {
    aEntered.resolve();
    await releaseA.promise;
    return 'a';
  });
  await aEntered.promise;

  let bRan = false;
  let caught: unknown;
  const started = Date.now();
  try {
    await withWorkspaceAdminRevokeLock(tenant, async () => {
      bRan = true;
      return 'b';
    });
  } catch (err) {
    caught = err;
  } finally {
    releaseA.resolve();
  }
  const waitedMs = Date.now() - started;

  expect(caught).toBeInstanceOf(WorkspaceAdminRevokeBusy);
  expect((caught as WorkspaceAdminRevokeBusy).statusCode).toBe(503);
  expect(bRan).toBe(false);
  // A try-lock: no waiting, so no pooled connection is pinned by a waiter.
  expect(waitedMs).toBeLessThan(2000);
  expect(await a).toBe('a');

  // Released at A's COMMIT: the next caller acquires.
  expect(await withWorkspaceAdminRevokeLock(tenant, async () => 'c')).toBe('c');
});

itDb('calls for DIFFERENT tenants run concurrently', async () => {
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const aEntered = deferred();
  const releaseA = deferred();

  const a = withWorkspaceAdminRevokeLock(tenantA, async () => {
    aEntered.resolve();
    await releaseA.promise;
    return 'a';
  });
  await aEntered.promise;

  try {
    // B completes while A is still holding ITS lock.
    const b = withWorkspaceAdminRevokeLock(tenantB, async () => 'b');
    expect(await within(b, 5000)).toBe('b');
  } finally {
    releaseA.resolve();
  }
  expect(await a).toBe('a');
});

itDb('a delete done through tx is visible to the NEXT lock holder (committed with the lock release)', async () => {
  const tenant = crypto.randomUUID();
  const user = `revoke-lock-it-${crypto.randomUUID()}`;
  seededUsers.push(user);
  await db.insert(userRoles).values({ user_id: user, tenant_id: tenant, role: 'workspace-admin' });

  const whereRow = and(
    eq(userRoles.user_id, user),
    eq(userRoles.tenant_id, tenant),
    eq(userRoles.role, 'workspace-admin'),
  );

  const deleted = deferred();
  const releaseA = deferred();
  const a = withWorkspaceAdminRevokeLock(tenant, async (tx) => {
    await tx.delete(userRoles).where(whereRow);
    deleted.resolve();
    await releaseA.promise;
  });
  await deleted.promise;

  // While A is uncommitted, a concurrent revoke for the tenant is refused —
  // it can never act on the pre-delete admin set.
  await expect(withWorkspaceAdminRevokeLock(tenant, async () => 'x')).rejects.toBeInstanceOf(
    WorkspaceAdminRevokeBusy,
  );

  releaseA.resolve();
  await a;

  const seenByNext = await withWorkspaceAdminRevokeLock(tenant, async (tx) =>
    tx.select({ id: userRoles.id }).from(userRoles).where(whereRow),
  );
  expect(seenByNext).toHaveLength(0);
});

itDb('an error thrown by fn propagates unchanged, rolls back its tx writes, and releases the lock', async () => {
  const tenant = crypto.randomUUID();
  const user = `revoke-lock-it-${crypto.randomUUID()}`;
  seededUsers.push(user);
  await db.insert(userRoles).values({ user_id: user, tenant_id: tenant, role: 'workspace-admin' });
  const boom = Object.assign(new Error('boom from fn'), { code: '55P03' });

  let caught: unknown;
  try {
    await withWorkspaceAdminRevokeLock(tenant, async (tx) => {
      await tx.delete(userRoles).where(eq(userRoles.user_id, user));
      throw boom;
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBe(boom);
  expect(caught).not.toBeInstanceOf(WorkspaceAdminRevokeBusy);

  // Rolled back: the row is still there.
  const rows = await db.select({ id: userRoles.id }).from(userRoles).where(eq(userRoles.user_id, user));
  expect(rows).toHaveLength(1);

  // Released: the next caller acquires immediately.
  expect(await withWorkspaceAdminRevokeLock(tenant, async () => 'after')).toBe('after');
});
