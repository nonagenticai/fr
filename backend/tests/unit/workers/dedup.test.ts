// tests/unit/workers/dedup.test.ts
//
// Unit test for the claimIdempotencyKey dedup mechanism.
// Requires a live test DB (action_idempotency table). Skips gracefully
// when the DB is unreachable (local dev without Docker).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { queryClient } from '../../../src/db/client';
import {
  claimIdempotencyKey,
  releaseIdempotencyKey,
} from '../../../src/workers/scheduled-trigger-tick';

let reachable = false;

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM action_idempotency LIMIT 1`;
    reachable = true;
    // Warm the pool wide enough for the concurrency cases below (see RACERS).
    await Promise.all(Array.from({ length: 8 }, () => queryClient`SELECT 1`));
  } catch (err) {
    console.warn(
      '[dedup.test] postgres unreachable or action_idempotency table missing — skipping:',
      (err as Error).message,
    );
  }
}, 60_000);

afterAll(async () => {
  // Clean up any rows we inserted during the test run
  if (reachable) {
    await queryClient`DELETE FROM action_idempotency WHERE user_id = 'dedup-test-tenant'`;
  }
});

function ifReachable(
  name: string,
  fn: () => void | Promise<void>,
  timeoutMs?: number,
): void {
  test(
    name,
    async () => {
      if (!reachable) {
        console.warn(`skipping "${name}" — postgres unreachable`);
        return;
      }
      await fn();
    },
    timeoutMs,
  );
}

/**
 * Number of racing claimers in the concurrency cases, and the pool warm-up
 * width. postgres.js opens connections lazily and reuses ONE for sequential
 * queries, so a cold N-wide `Promise.all` opens N-1 sockets at once — ~1-2s
 * each through Docker Desktop's port forwarding on a dev Mac, which blew the
 * default 5s per-test budget. The burst is warmed in `beforeAll` instead.
 */
const RACERS = 8;

describe('claimIdempotencyKey — dedup mechanism', () => {
  ifReachable(
    'first call returns true (inserted), second call with same key returns false (conflict)',
    async () => {
      const key = `dedup-test-key-${Date.now()}`;
      const tenant = 'dedup-test-tenant';

      const first = await claimIdempotencyKey(tenant, key);
      expect(first).toBe(true);

      const second = await claimIdempotencyKey(tenant, key);
      expect(second).toBe(false);
    },
  );

  ifReachable(
    'different keys are each claimable independently',
    async () => {
      const ts = Date.now();
      const key1 = `dedup-test-key-${ts}-a`;
      const key2 = `dedup-test-key-${ts}-b`;
      const tenant = 'dedup-test-tenant';

      expect(await claimIdempotencyKey(tenant, key1)).toBe(true);
      expect(await claimIdempotencyKey(tenant, key2)).toBe(true);
      // Re-claiming either still returns false
      expect(await claimIdempotencyKey(tenant, key1)).toBe(false);
      expect(await claimIdempotencyKey(tenant, key2)).toBe(false);
    },
  );

  ifReachable(
    'same key under different tenants are independent',
    async () => {
      const key = `dedup-test-shared-key-${Date.now()}`;
      const tenantA = 'dedup-test-tenant';
      const tenantB = 'dedup-test-tenant-b';

      // Clean up tenantB rows too
      await queryClient`DELETE FROM action_idempotency WHERE user_id = ${tenantB}`;

      const firstA = await claimIdempotencyKey(tenantA, key);
      const firstB = await claimIdempotencyKey(tenantB, key);
      expect(firstA).toBe(true);
      expect(firstB).toBe(true);

      // Both should now be claimed
      expect(await claimIdempotencyKey(tenantA, key)).toBe(false);
      expect(await claimIdempotencyKey(tenantB, key)).toBe(false);

      // Clean up tenantB
      await queryClient`DELETE FROM action_idempotency WHERE user_id = ${tenantB}`;
    },
  );
});

describe('releaseIdempotencyKey — un-burn a key when nothing was delivered', () => {
  ifReachable(
    'claim → re-claim false → release → re-claim true',
    async () => {
      const key = `dedup-test-release-${Date.now()}`;
      const tenant = 'dedup-test-tenant';

      expect(await claimIdempotencyKey(tenant, key)).toBe(true);
      expect(await claimIdempotencyKey(tenant, key)).toBe(false);

      await releaseIdempotencyKey(tenant, key);

      // Without the release the key stays burned for the 7-day TTL and every
      // later tick reports status='ok', records_processed=0 — silent total
      // data loss reported as green.
      expect(await claimIdempotencyKey(tenant, key)).toBe(true);
    },
  );

  ifReachable('release is tenant-scoped and does not touch other keys', async () => {
    const ts = Date.now();
    const keep = `dedup-test-release-keep-${ts}`;
    const drop = `dedup-test-release-drop-${ts}`;
    const tenant = 'dedup-test-tenant';

    expect(await claimIdempotencyKey(tenant, keep)).toBe(true);
    expect(await claimIdempotencyKey(tenant, drop)).toBe(true);

    await releaseIdempotencyKey(tenant, drop);

    expect(await claimIdempotencyKey(tenant, keep)).toBe(false);
    expect(await claimIdempotencyKey(tenant, drop)).toBe(true);
  });

  ifReachable('releasing a key that was never claimed is a no-op', async () => {
    // This body used to be the bare `await releaseIdempotencyKey(...)` call and
    // nothing else — it asserted NOTHING, and passed on the sole strength of not
    // throwing. `releaseIdempotencyKey` issues an unconstrained
    // `DELETE ... WHERE user_id = $1 AND key = $2` (domain/engagement/
    // dedup-claim.ts:99-103); a predicate bug that widened that DELETE would
    // wipe the tenant's live claims and this test would still have been green.
    // "No-op" is a claim about what did NOT change, so it has to be measured.
    const ts = Date.now();
    const tenant = 'dedup-test-tenant';
    const live = `dedup-test-release-noop-live-${ts}`;
    const neverClaimed = `dedup-test-release-noop-absent-${ts}`;

    expect(await claimIdempotencyKey(tenant, live)).toBe(true);

    await releaseIdempotencyKey(tenant, neverClaimed);

    // The neighbouring live claim is untouched — the delete did not widen.
    expect(await claimIdempotencyKey(tenant, live)).toBe(false);
    // And the absent key was never burned by the release itself.
    expect(await claimIdempotencyKey(tenant, neverClaimed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TTL semantics.
//
// `action_idempotency` is documented as a 7-day TTL store (migration 010 even
// ships `idx_action_idempotency_expires_at` "for the sweep job"). Until
// 2026-07-30 the claim used a bare `ON CONFLICT (user_id, key) DO NOTHING`,
// which cannot see `expires_at` at all: an EXPIRED row still won the conflict,
// so the claim returned false forever and the source record was suppressed
// permanently. Measured on prod (worker4, db `fr`): 6209 rows, 0 unexpired.
//
// These cases pin BOTH directions — the takeover must happen for expired rows
// and must NOT happen for live ones, because a live-row takeover would be a
// double dispatch.
// ---------------------------------------------------------------------------

const TENANT = 'dedup-test-tenant';
/** Frozen expectation: DEDUP_TTL_SECS is 7 days. Stated as a literal on
 *  purpose — importing the constant would make the assertion tautological. */
const EXPECTED_TTL_SECONDS = 604_800;

interface Row {
  /** epoch seconds */
  expires_at: number;
  /** epoch seconds */
  created_at: number;
  /** expires_at - created_at, in seconds */
  ttl_secs: number;
  /** expires_at - NOW(), in seconds; negative means already expired */
  remaining_secs: number;
}

// postgres.js hands timestamptz back as a string here, so pull the epochs out
// in SQL rather than parsing in JS — and compare against the DB's own NOW()
// instead of the test host's clock.
async function readRow(key: string): Promise<Row | undefined> {
  const rows = await queryClient<Record<keyof Row, string>[]>`
    SELECT EXTRACT(EPOCH FROM expires_at)::text            AS expires_at,
           EXTRACT(EPOCH FROM created_at)::text            AS created_at,
           EXTRACT(EPOCH FROM (expires_at - created_at))::text AS ttl_secs,
           EXTRACT(EPOCH FROM (expires_at - NOW()))::text  AS remaining_secs
      FROM action_idempotency
     WHERE user_id = ${TENANT} AND key = ${key}
  `;
  const r = rows[0];
  if (!r) return undefined;
  return {
    expires_at: Number(r.expires_at),
    created_at: Number(r.created_at),
    ttl_secs: Number(r.ttl_secs),
    remaining_secs: Number(r.remaining_secs),
  };
}

async function rowCount(key: string): Promise<number> {
  const rows = await queryClient<{ n: string }[]>`
    SELECT count(*)::text AS n FROM action_idempotency
     WHERE user_id = ${TENANT} AND key = ${key}
  `;
  return Number(rows[0]!.n);
}

/** Force a claimed row's expiry into the past without touching the claim code. */
async function expireRow(key: string, agoSeconds = 60): Promise<void> {
  const res = await queryClient`
    UPDATE action_idempotency
       SET expires_at = NOW() - make_interval(secs => ${agoSeconds})
     WHERE user_id = ${TENANT} AND key = ${key}
  `;
  if ((res as unknown as { count?: number }).count !== 1) {
    throw new Error(`expireRow: expected to expire exactly 1 row for ${key}`);
  }
}

describe('claimIdempotencyKey — TTL semantics', () => {
  ifReachable('a fresh claim writes a 7-day expiry (not a fictional one)', async () => {
    const key = `dedup-ttl-fresh-${Date.now()}`;
    expect(await claimIdempotencyKey(TENANT, key)).toBe(true);

    const row = await readRow(key);
    expect(row).toBeDefined();
    expect(row!.ttl_secs).toBe(EXPECTED_TTL_SECONDS);
    expect(row!.remaining_secs).toBeGreaterThan(EXPECTED_TTL_SECONDS - 60);
  });

  ifReachable(
    'an UNEXPIRED row still blocks a second claim AND is not silently extended',
    async () => {
      const key = `dedup-ttl-live-${Date.now()}`;
      expect(await claimIdempotencyKey(TENANT, key)).toBe(true);

      const before = await readRow(key);
      expect(before).toBeDefined();

      // Exactly-once: this MUST stay false. A `DO UPDATE` without the
      // `expires_at <= NOW()` predicate would return true here and
      // double-dispatch a record that was already delivered.
      expect(await claimIdempotencyKey(TENANT, key)).toBe(false);

      // ...and the losing claim must not have touched the winner's row.
      const after = await readRow(key);
      expect(after!.expires_at).toBe(before!.expires_at);
      expect(after!.created_at).toBe(before!.created_at);
    },
  );

  ifReachable('an EXPIRED row does NOT block — the second claim succeeds', async () => {
    const key = `dedup-ttl-expired-${Date.now()}`;
    expect(await claimIdempotencyKey(TENANT, key)).toBe(true);
    const firstCreatedAt = (await readRow(key))!.created_at;

    await expireRow(key);

    // The whole point of the TTL. Before the fix this was `false` forever.
    expect(await claimIdempotencyKey(TENANT, key)).toBe(true);

    const row = await readRow(key);
    // Taken OVER, not duplicated: still a 7-day window, now anchored at the
    // new claim, and created_at advanced past the original claim.
    expect(row!.ttl_secs).toBe(EXPECTED_TTL_SECONDS);
    expect(row!.remaining_secs).toBeGreaterThan(EXPECTED_TTL_SECONDS - 60);
    expect(row!.created_at).toBeGreaterThan(firstCreatedAt);

    expect(await rowCount(key)).toBe(1);
  });

  ifReachable(
    'a re-claimed (taken-over) row blocks again immediately',
    async () => {
      const key = `dedup-ttl-retakeover-${Date.now()}`;
      expect(await claimIdempotencyKey(TENANT, key)).toBe(true);
      await expireRow(key);
      expect(await claimIdempotencyKey(TENANT, key)).toBe(true);
      // The takeover re-armed the TTL, so the next caller is blocked again.
      expect(await claimIdempotencyKey(TENANT, key)).toBe(false);
    },
  );

  ifReachable(
    'CONCURRENT claims on an EXPIRED row: exactly one wins',
    async () => {
      const key = `dedup-ttl-race-expired-${Date.now()}`;
      expect(await claimIdempotencyKey(TENANT, key)).toBe(true);
      await expireRow(key);

      // 8 racing takeovers. Postgres row-locks the conflicting row before
      // evaluating `DO UPDATE ... WHERE expires_at <= NOW()`, and the losers
      // re-evaluate against the WINNER'S committed row (expires_at now in the
      // future) — so the predicate is false for all but one.
      const results = await Promise.all(
        Array.from({ length: RACERS }, () => claimIdempotencyKey(TENANT, key)),
      );
      expect(results.filter(Boolean).length).toBe(1);
      expect(results.filter((r) => r === false).length).toBe(RACERS - 1);
    },
    30_000,
  );

  ifReachable(
    'CONCURRENT claims on an ABSENT key: exactly one wins',
    async () => {
      const key = `dedup-ttl-race-absent-${Date.now()}`;
      const results = await Promise.all(
        Array.from({ length: RACERS }, () => claimIdempotencyKey(TENANT, key)),
      );
      expect(results.filter(Boolean).length).toBe(1);

      expect(await rowCount(key)).toBe(1);
    },
    30_000,
  );

  ifReachable('expiry is per-(tenant,key): expiring one does not free another', async () => {
    const ts = Date.now();
    const stale = `dedup-ttl-scope-stale-${ts}`;
    const live = `dedup-ttl-scope-live-${ts}`;
    expect(await claimIdempotencyKey(TENANT, stale)).toBe(true);
    expect(await claimIdempotencyKey(TENANT, live)).toBe(true);

    await expireRow(stale);

    expect(await claimIdempotencyKey(TENANT, stale)).toBe(true);
    expect(await claimIdempotencyKey(TENANT, live)).toBe(false);
  });
});
