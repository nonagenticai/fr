// tests/integration/helpers/db-suite.ts
//
// A Postgres-backed integration suite that CANNOT silently pass.
//
// The problem this exists to kill
// ------------------------------
// The `let reachable = false; … if (!reachable) return;` idiom that most of
// tests/integration/ uses reports a file with N tests as `N pass, 0 fail,
// 0 expect() calls` when Postgres is missing. That is a green light on
// nothing: a HIPAA right-to-delete proof that "passes" without ever touching
// the code under test is worse than no test, because it advertises coverage
// nobody is enforcing.
//
// Three guarantees (top-level-await probe +
// test.skipIf, which makes Bun print a real `skip` line instead of a fake pass):
//
//  1. HARD FAIL when the developer clearly intended to run against a database.
//     `DATABASE_URL` set but Postgres unreachable → throw at import time, so
//     the file errors out instead of skipping. Same for `CI=true`, whatever
//     the env looks like. CI's Postgres dying must never read as green.
//  2. VISIBLE SKIP as the ONLY opt-out. No `DATABASE_URL` and not CI = the
//     developer genuinely has no database; the tests register via
//     `test.skipIf(true)` so Bun prints `(skip)` per test and the reason is
//     warned once to stderr. Not a pass.
//  3. NO VACUOUS RUN. Every wrapped body calls `expect.hasAssertions()`, so a
//     test that executes without asserting anything FAILS; and an `afterAll`
//     fails the file if the suite was supposed to run but zero bodies did.
//
// Usage:
//   const { itDb } = createDbSuite('admin-projects-delete');
//   itDb('…', async () => { … });

import { afterAll, expect, test } from 'bun:test';

import { drainDetachedWork } from '../../../src/lib/detached-work';

import { db } from '../../../src/db/client';
import { projects } from '../../../src/db/schema';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const IS_CI = process.env.CI === 'true';

/**
 * Probe at module-load time (top-level await) so the answer is known BEFORE any
 * `test()` is registered — that is what allows `test.skipIf`, and therefore a
 * visible `skip` in the output, rather than a body that returns early and
 * counts as a pass.
 */
const probe: { ok: true } | { ok: false; error: Error } = await (async () => {
  try {
    await db.select().from(projects).limit(0);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err as Error };
  }
})();

// fr-agui P4d-2e: tests/setup-env.ts REFUSES any connection outside CI when DATABASE_URL is unset (no
// DATABASE_URL ⇒ a sentinel URL + every connection throws). That is not "no database, skip": the
// developer ran a database-backed suite without saying which database. Fail with that sentence.
if (!probe.ok && process.env.FR_TEST_DATABASE_URL_REFUSED === '1') {
  throw new Error(
    `[db-suite] ${probe.error.message} (database-backed suite: set DATABASE_URL to a throwaway postgres:18 ` +
      'migrated per the "Bootstrap schema + seed + migrations" CI step).',
  );
}

if (!probe.ok && (DATABASE_URL || IS_CI)) {
  // Fail LOUDLY. `DATABASE_URL` set means the developer asked for a database;
  // CI=true means the pipeline owes us one. Skipping here is how a right-to-
  // delete regression ships green.
  throw new Error(
    '[db-suite] Postgres is NOT reachable, but ' +
      (DATABASE_URL ? `DATABASE_URL is set (${redact(DATABASE_URL)})` : 'CI=true') +
      ' — refusing to silently skip database-backed integration tests. ' +
      `Underlying error: ${probe.error.message}. ` +
      'Start a Postgres (see the "Bootstrap schema + seed + migrations" CI step: ' +
      'drizzle-kit push + scripts/ci-seed.ts + bun run migrate), or unset ' +
      'DATABASE_URL to opt out explicitly.',
  );
}

if (!probe.ok) {
  console.warn(
    '[db-suite] ⚠️  SKIPPING all database-backed integration tests in this run: ' +
      'no DATABASE_URL and CI is not true, and Postgres is unreachable ' +
      `(${probe.error.message}). These tests prove HIPAA right-to-delete behaviour ` +
      'and are NOT being enforced right now.',
  );
}

function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

/** True when a real, queryable Postgres is behind `db`. */
export const dbReachable: boolean = probe.ok;

export interface DbSuite {
  /** `test()` that skips visibly without a database and can never pass vacuously. */
  itDb: (name: string, fn: () => Promise<void> | void, timeoutMs?: number) => void;
  dbReachable: boolean;
}

/**
 * Per-file suite. The counter is per-call (not module-global) so the
 * zero-tests-ran guard is scoped to the file that created it — the helper
 * module itself is evaluated once and shared.
 */
export function createDbSuite(label: string): DbSuite {
  let registered = 0;
  let ran = 0;

  const itDb = (name: string, fn: () => Promise<void> | void, timeoutMs?: number): void => {
    registered += 1;
    const body = async (): Promise<void> => {
      // A body that asserts nothing is not a proof. Fails the test rather than
      // contributing a hollow pass.
      expect.hasAssertions();
      await fn();
      ran += 1;
    };
    if (timeoutMs === undefined) test.skipIf(!dbReachable)(name, body);
    else test.skipIf(!dbReachable)(name, body, timeoutMs);
  };

  // Detached side effects a handler did not await (src/lib/detached-work.ts) must
  // finish inside THIS file: bun runs every file in one process, so one left in
  // flight resolves inside the next file and hits its fetch mocks.
  afterAll(async () => {
    await drainDetachedWork();
  });

  afterAll(() => {
    if (!dbReachable) return; // legitimately skipped, already warned above
    if (registered === 0) {
      throw new Error(
        `[db-suite:${label}] registered ZERO tests — the file is not proving anything.`,
      );
    }
    if (ran === 0) {
      throw new Error(
        `[db-suite:${label}] Postgres was reachable and ${registered} test(s) were ` +
          'registered, but ZERO test bodies completed. The suite reported no real ' +
          'coverage — treating that as a failure rather than a green run.',
      );
    }
  });

  return { itDb, dbReachable };
}
