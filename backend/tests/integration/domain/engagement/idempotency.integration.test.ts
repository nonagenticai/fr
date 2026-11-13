// Integration test for E-4 idempotency store.
//
// Requires the local fr-postgres container (docker compose ... up -d) with
// migration 010 applied. Skips gracefully if the service's DB isn't reachable.
//
// Uses the *same* queryClient the service uses — one client, one URL, one
// source of truth. If the probe succeeds but runIdempotent fails, that's a
// real bug, not a test/DB-URL mismatch.

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { queryClient } from '../../../../src/db/client';
import { runIdempotent, sweepExpiredIdempotency } from '../../../../src/domain/engagement/idempotency';

import { createDbSuite } from '../../helpers/db-suite';

const sql = queryClient;
let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM action_idempotency LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[idempotency.integration] DB not reachable, skipping. Start fr-postgres with migration 010 applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

afterAll(async () => {
  // queryClient is shared with the app; do not end() it here — other tests
  // in the same process (and the app itself if co-running) may still use it.
});

// Per-run user-id prefix. `action_idempotency` is a shared table and this file
// now runs in the same process and the same database as ~70 other integration
// files, so every row it writes must be attributable to THIS run — otherwise
// the cleanup below has to be a table-wide DELETE, which destroys the other
// suites' rows (and their fixtures) as a side effect.
const RUN = randomUUID().slice(0, 8);
const OWNED = `idem-${RUN}-%`;

beforeEach(async () => {
  // Was `DELETE FROM action_idempotency` with no predicate. Harmless when CI
  // ran five integration files; a landmine now that ~70 share one database —
  // it silently wiped every other suite's idempotency rows mid-run, and the
  // damage surfaced as a failure somewhere else entirely.
  if (reachable) await sql`DELETE FROM action_idempotency WHERE user_id LIKE ${OWNED}`;
});

const { itDb } = createDbSuite('idempotency');

// Default test user — see migration 019. Cache is keyed (user_id, key); these
// tests pin a single user so existing semantics (single key collapses) are
// preserved.
const U = `idem-${RUN}-user-1`;
// Two distinct users sharing one key — see the cache-partitioning test below.
const USER_A = `idem-${RUN}-user-a`;
const USER_B = `idem-${RUN}-user-b`;

describe('runIdempotent', () => {
  itDb('first call runs fn and returns {cached:false}', async () => {
    let count = 0;
    const result = await runIdempotent(U, 'k1', 60, async () => {
      count += 1;
      return { n: 42 };
    });
    expect(count).toBe(1);
    expect(result.cached).toBe(false);
    expect(result.value).toEqual({ n: 42 });
    const rows = await sql<{ key: string }[]>`SELECT key FROM action_idempotency WHERE key = 'k1'`;
    expect(rows).toHaveLength(1);
  });

  itDb('second call within TTL returns cached value without running fn', async () => {
    let count = 0;
    const run = () =>
      runIdempotent(U, 'k2', 60, async () => {
        count += 1;
        return { n: count };
      });
    const a = await run();
    const b = await run();
    expect(count).toBe(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.value).toEqual({ n: 1 });
  });

  itDb('call after TTL expiry re-runs fn', async () => {
    let count = 0;
    await runIdempotent(U, 'k3', 60, async () => {
      count += 1;
      return count;
    });
    // Force expiry by backdating expires_at to the past.
    await sql`UPDATE action_idempotency SET expires_at = NOW() - INTERVAL '1 second' WHERE key = 'k3'`;
    const second = await runIdempotent(U, 'k3', 60, async () => {
      count += 1;
      return count;
    });
    expect(count).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.value).toBe(2);
  });

  itDb('throwing fn is NOT cached — next call re-runs', async () => {
    let attempts = 0;
    const run = () =>
      runIdempotent(U, 'k4', 60, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first-failure');
        return 'ok';
      });
    await expect(run()).rejects.toThrow('first-failure');
    // No row should have been written for the throwing call.
    const rows = await sql<{ key: string }[]>`SELECT key FROM action_idempotency WHERE key = 'k4'`;
    expect(rows).toHaveLength(0);
    const second = await run();
    expect(attempts).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.value).toBe('ok');
  });

  itDb('concurrent callers with same key serialize — fn runs exactly once', async () => {
    let count = 0;
    const run = (delayMs: number) =>
      runIdempotent(U, 'k5', 60, async () => {
        count += 1;
        await new Promise((r) => setTimeout(r, delayMs));
        return count;
      });
    const [a, b, c, d] = await Promise.all([run(30), run(30), run(30), run(30)]);
    expect(count).toBe(1);
    // Exactly one caller should report cached:false; the rest cached:true.
    const cachedFlags = [a, b, c, d].map((r) => r.cached).sort();
    expect(cachedFlags).toEqual([false, true, true, true]);
    // All observe the same value.
    expect(new Set([a.value, b.value, c.value, d.value]).size).toBe(1);
  });

  itDb('different users with same key do NOT share cache', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { call: calls };
    };
    const a = await runIdempotent(USER_A, 'shared-key', 60, fn);
    const b = await runIdempotent(USER_B, 'shared-key', 60, fn);
    expect(calls).toBe(2);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(a.value).not.toEqual(b.value);
    // Both rows present with same key, distinct user_id.
    const rows = await sql<{ user_id: string }[]>`
      SELECT user_id FROM action_idempotency
      WHERE key = 'shared-key' AND user_id LIKE ${OWNED}
      ORDER BY user_id
    `;
    expect(rows.map((r) => r.user_id)).toEqual([USER_A, USER_B]);
  });

  itDb('empty userId throws', async () => {
    await expect(runIdempotent('', 'k', 60, async () => 1)).rejects.toThrow();
  });

  itDb('empty key throws', async () => {
    await expect(runIdempotent(U, '', 60, async () => 1)).rejects.toThrow();
  });

  itDb('non-positive TTL throws', async () => {
    await expect(runIdempotent(U, 'k6', 0, async () => 1)).rejects.toThrow();
    await expect(runIdempotent(U, 'k7', -5, async () => 1)).rejects.toThrow();
  });
});

describe('sweepExpiredIdempotency', () => {
  itDb('deletes rows with expires_at in the past, leaves fresh rows', async () => {
    await runIdempotent(U, 'fresh', 600, async () => 'still-valid');
    await runIdempotent(U, 'stale', 600, async () => 'to-be-swept');
    await sql`UPDATE action_idempotency SET expires_at = NOW() - INTERVAL '10 minutes' WHERE key = 'stale'`;
    await sweepExpiredIdempotency();
    // Scoped to this run. The original read had no predicate at all, so it
    // asserted over the whole table — which only held because the beforeEach
    // above used to TRUNCATE it. Note `sweepExpiredIdempotency()` is itself
    // table-wide by design (it is the production reaper); it may therefore
    // remove other suites' ALREADY-EXPIRED rows. That is the reaper's job and
    // is left alone — what is fixed here is this file asserting over rows it
    // does not own.
    const rows = await sql<{ key: string }[]>`
      SELECT key FROM action_idempotency WHERE user_id LIKE ${OWNED} ORDER BY key
    `;
    expect(rows.map((r) => r.key)).toEqual(['fresh']);
  });
});
