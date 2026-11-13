// tests/unit/workers/idempotency-sweep.test.ts
//
// The `action_idempotency` TTL reaper. `sweepExpiredIdempotency()` shipped with
// migration 010 and then had ZERO production callers for three months — prod
// (worker4, db `fr`) held 6209 rows, none unexpired, none ever reaped.
//
// Requires a live test DB. Skips gracefully when Postgres is unreachable
// (local dev without Docker), matching tests/unit/workers/dedup.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { LOCK_KEYS } from '../../../src/db/advisory-lock-keys';
import { queryClient } from '../../../src/db/client';
import {
  IDEMPOTENCY_SWEEP_BATCH_SIZE,
  sweepExpiredIdempotency,
} from '../../../src/domain/engagement/idempotency';
import { runIdempotencySweepTick } from '../../../src/workers/idempotency-sweep';

const TENANT = 'sweep-test-tenant';
/** The key the sweep actually takes. Read from the registry — the ONE place an
 *  integer advisory-lock key may be declared (src/db/advisory-lock-keys.ts).
 *
 *  This was a hand-copied `912349` literal until 2026-09-05, carrying the note
 *  "stated as a literal so a silent key change fails this test". That property
 *  has not been given up, it has MOVED: the same copy-paste habit is what let
 *  approval-expiry and scheduled-trigger-run-prune both claim 912350, and a
 *  literal here would have been the last surviving instance of it. The exact
 *  integers are now pinned by tests/unit/db/advisory-lock-keys.test.ts, so a
 *  silent renumber still reddens a test — while this file gets what it actually
 *  needs, which is the key the code under test really uses. */
const SWEEP_ADVISORY_LOCK_KEY = LOCK_KEYS.idempotencySweep;

let reachable = false;

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM action_idempotency LIMIT 1`;
    reachable = true;
    // Warm a second pooled connection: the lock-contention case below holds one
    // connection open while the sweep tick needs another, and postgres.js opens
    // sockets lazily (~1-2s cold through Docker Desktop on a dev Mac).
    await Promise.all(Array.from({ length: 4 }, () => queryClient`SELECT 1`));
  } catch (err) {
    console.warn(
      '[idempotency-sweep.test] postgres unreachable or action_idempotency missing — skipping:',
      (err as Error).message,
    );
  }
}, 60_000);

// The sweep is deliberately GLOBAL (it is garbage collection for the whole
// table), so a row left expired by any other suite would land in this file's
// deleted-count assertions. Clear both our tenant and any foreign expired row
// before each case, with plain SQL rather than the function under test.
async function wipe(): Promise<void> {
  await queryClient`DELETE FROM action_idempotency WHERE user_id = ${TENANT}`;
  await queryClient`DELETE FROM action_idempotency WHERE expires_at <= NOW()`;
}

beforeEach(async () => {
  if (reachable) await wipe();
}, 30_000);

afterAll(async () => {
  if (reachable) await wipe();
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

/** Insert a row directly with an explicit expiry offset (seconds from now). */
async function seed(key: string, expiresInSeconds: number): Promise<void> {
  await queryClient`
    INSERT INTO action_idempotency (user_id, key, value_json, expires_at)
    VALUES (${TENANT}, ${key}, 'true'::jsonb,
            NOW() + make_interval(secs => ${expiresInSeconds}))
  `;
}

async function remainingKeys(): Promise<string[]> {
  const rows = await queryClient<{ key: string }[]>`
    SELECT key FROM action_idempotency WHERE user_id = ${TENANT} ORDER BY key
  `;
  return rows.map((r) => r.key);
}

// ---------------------------------------------------------------------------
// Wiring guard.
//
// The original defect was NOT a wrong function — `sweepExpiredIdempotency()`
// was correct on the day it shipped. It simply had nobody calling it, for three
// months, silently. A behaviour test cannot see that, so pin the call site.
// DB-free, so it runs even without Postgres.
// ---------------------------------------------------------------------------
describe('sweep worker is actually wired into the server', () => {
  const serverSrc = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'src', 'server.ts'),
    'utf8',
  );

  test('server.ts imports the sweep worker', () => {
    expect(serverSrc).toContain(
      "import { startIdempotencySweepWorker } from './workers/idempotency-sweep'",
    );
  });

  test('server.ts CALLS startIdempotencySweepWorker()', () => {
    expect(serverSrc).toContain('startIdempotencySweepWorker();');
  });

  test('the only guard on the call is the documented opt-out env var', () => {
    expect(serverSrc).toContain("process.env.IDEMPOTENCY_SWEEP_DISABLED !== 'true'");
  });
});

describe('sweepExpiredIdempotency', () => {
  ifReachable('deletes ONLY expired rows and leaves unexpired ones', async () => {
    await seed('stale-a', -600);
    await seed('stale-b', -1);
    await seed('fresh-a', 600);
    await seed('fresh-b', 86_400);

    const deleted = await sweepExpiredIdempotency();

    expect(deleted).toBe(2);
    // Frozen expectation, not a re-derivation of the query under test.
    expect(await remainingKeys()).toEqual(['fresh-a', 'fresh-b']);
  });

  ifReachable('honours the batch limit', async () => {
    // One more expired row than a batch holds, inserted in one statement.
    await queryClient`
      INSERT INTO action_idempotency (user_id, key, value_json, expires_at)
      SELECT ${TENANT}, 'stale-' || g, 'true'::jsonb, NOW() - interval '10 minutes'
        FROM generate_series(1, ${IDEMPOTENCY_SWEEP_BATCH_SIZE + 1}::int) AS g
    `;

    expect(await sweepExpiredIdempotency()).toBe(IDEMPOTENCY_SWEEP_BATCH_SIZE);
    expect((await remainingKeys()).length).toBe(1);
    expect(await sweepExpiredIdempotency()).toBe(1);
    expect(await remainingKeys()).toEqual([]);
  });

  ifReachable('is a no-op when nothing is expired', async () => {
    await seed('fresh-only', 600);
    expect(await sweepExpiredIdempotency()).toBe(0);
    expect(await remainingKeys()).toEqual(['fresh-only']);
  });
});

describe('runIdempotencySweepTick — multi-replica singleton', () => {
  ifReachable('acquires the lock, reaps expired rows, reports the count', async () => {
    await seed('stale-a', -600);
    await seed('stale-b', -600);
    await seed('fresh-a', 600);

    const r = await runIdempotencySweepTick();

    expect(r.outcome).toBe('ok');
    expect(r.acquiredLock).toBe(true);
    expect(r.deleted).toBe(2);
    expect(r.more).toBe(false);
    expect(await remainingKeys()).toEqual(['fresh-a']);
  });

  ifReachable(
    'a second replica SKIPS while another holds the advisory lock — and deletes nothing',
    async () => {
      await seed('stale-a', -600);
      await seed('stale-b', -600);

      // Stand in for replica A: hold the same transaction-scoped advisory lock
      // on a different pooled connection for the duration of the tick.
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let locked!: (v: unknown) => void;
      const lockAcquired = new Promise((r) => {
        locked = r;
      });

      const holder = queryClient.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${SWEEP_ADVISORY_LOCK_KEY})`;
        locked(null);
        await held;
      });

      try {
        await lockAcquired;
        const r = await runIdempotencySweepTick();

        expect(r.acquiredLock).toBe(false);
        expect(r.outcome).toBe('skipped');
        expect(r.deleted).toBe(0);
        // The contended replica must not have reaped behind the lock holder.
        expect(await remainingKeys()).toEqual(['stale-a', 'stale-b']);
      } finally {
        release();
        await holder;
      }

      // Lock released → the next tick proceeds normally.
      const after = await runIdempotencySweepTick();
      expect(after.acquiredLock).toBe(true);
      expect(after.deleted).toBe(2);
      expect(await remainingKeys()).toEqual([]);
    },
    30_000,
  );
});
