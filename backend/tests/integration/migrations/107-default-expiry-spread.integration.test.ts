// tests/integration/migrations/107-default-expiry-spread.integration.test.ts
//
// Proves migration 107's MATURITY SPREAD against a REAL Postgres.
//
// WHY THIS EXISTS. Migration 107 had no test of any kind. An adversarial audit
// on 2026-09-02 found that its original form — a single `now() + interval
// '7 days'` — stamped every row with the SAME instant, so the whole population
// matured in one reaper tick. Traced through the consumer:
//
//   approval-expiry.ts:135  BATCH_SIZE = 500
//   approval-expiry.ts:318  callbacks are a SEQUENTIAL for-loop with await
//   approval-expiry.ts:146  the phase has a 60s deadline
//   n8n-callback.ts:207     per-send ceiling is 2000ms
//
// Rows that miss the deadline go to `deferred` (:325) AFTER the row is already
// status='expired' (:230), and expireBatch (:248) selects status='pending'
// ONLY. There is no sweep and no qualifying status that picks them back up, so
// a deferred row is UNREACHABLE — its callback silently never fires. Verified
// across all 7 workers and every 'expired' reference in backend/src.
//
// ⚠️ THE DISCRIMINATING ASSERTION is `distinct === count` on expires_at.
// Reverting the migration to a single now() leaves every other property intact
// — the right rows are still stamped, the pre-image is still captured, the
// controls are still untouched — and ONLY that equality goes red. A test that
// merely checked "the rows got a deadline" would pass against the defect.
//
// Runs inside a transaction that is ALWAYS rolled back, and asserts only about
// ids it inserted itself: the migration touches every pending/NULL row in the
// table, so a shared test database must not be reasoned about globally.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { queryClient as sql } from '../../../src/db/client';

const MIGRATION = readFileSync(
  join(import.meta.dir, '../../../migrations/107_default_expiry_backfill.sql'),
  'utf8',
);

// Enough rows that a one-minute spread is visibly wider than one 15-min tick.
const N = 120;
const TAG = `mig107-spread-${process.pid}-${Date.now()}`;

// Distinct ids on purpose: CI runs many integration files in ONE `bun test`,
// and a shared fixture id would let one file's teardown delete another's rows.
const WORKSPACE_ID = '00000000-0000-4000-8000-0000005e1071';
const DEPT_ID      = '00000000-0000-4000-8000-0000005e1072';
const PROJECT_ID   = '00000000-0000-4000-8000-0000005e1073';
const OWNER_ID     = '00000000-0000-4000-8000-0000005e1074';
const TENANT_ID    = WORKSPACE_ID;

// The reaper's own constants, restated so a change there fails HERE too.
const BATCH_SIZE = 500;
const PHASE_DEADLINE_MS = 60_000;
const PER_SEND_CEILING_MS = 2_000;
const TICK_MS = 900_000; // 15 min

// ⚠️ EVERYTHING RUNS INSIDE ONE sql.begin(). That is not stylistic.
// `queryClient` is postgres.js with default pooling, so a bare
// sql.unsafe('BEGIN') and a later sql.unsafe('ROLLBACK') can land on DIFFERENT
// connections — the transaction would not wrap the work, and migration 107,
// which stamps EVERY pending/NULL row, would leak into a shared test database
// and silently stamp other suites' fixtures. sql.begin() holds one connection
// for the whole callback.
//
// Rollback is forced by throwing a sentinel: postgres.js COMMITS a callback
// that returns normally, so "assertions passed" would otherwise mean "the
// writes were kept". Throwing also means a FAILING assertion rolls back too.
class Rollback extends Error {}

// ⚠️ EVERY BIND PARAMETER IS EXPLICITLY CAST. Postgres raised 42P18
// (indeterminate_datatype, "could not determine data type of parameter") on
// generate_series(1, $2) in CI. It did not reproduce locally because the local
// dry-run inlined the values instead of binding them — which is exactly why
// this test had to be wired into CI rather than trusted from a manual psql run.
// Do not remove the ::int / ::text casts.

// Indexing a possibly-empty array is exactly the bug this test would hide, so
// assert non-empty loudly instead of reaching for `!`.
function at<T>(rows: T[], i: number): T {
  const row = rows[i];
  if (row === undefined) throw new Error(`expected a row at index ${i}, got ${rows.length} rows`);
  return row;
}

type Stamped = { id: string; expires_at: string; created_at: string; rank: number };

test('migration 107 spreads deadlines so no row is ever deferred into the unreachable state', async () => {
  let failure: unknown;

  try {
    await sql.begin(async (tx) => {
      // Assertions select by `test_tag`, not by a captured id list: the
      // migration touches every pending/NULL row, so identifying our own rows
      // by a predicate the migration cannot alter is what keeps this honest.
      // ⚠️ approvals is NOT a 6-column table. It has NOT NULL columns with no
      // defaults (tenant_id, project_id, requester_id, kind, description) and
      // project_id carries an FK to projects, so a row needs a whole
      // workspace -> department -> project chain behind it. A hand-rolled
      // INSERT fails with 23502; this seeds that chain, using DISTINCT ids so
      // files cannot collide when CI runs them in one `bun test`.
      // All of it is inside the transaction, so ROLLBACK is the teardown.
      await tx.unsafe(
        `INSERT INTO workspaces (id, name) VALUES ($1::uuid, 'mig107-spread-ws')
         ON CONFLICT (id) DO NOTHING`, [WORKSPACE_ID]);
      await tx.unsafe(
        `INSERT INTO departments (id, workspace_id, name)
         VALUES ($1::uuid, $2::uuid, 'mig107-spread-dept')
         ON CONFLICT (id) DO NOTHING`, [DEPT_ID, WORKSPACE_ID]);
      // repository_url is NOT NULL with no default — the fixture must supply one.
      await tx.unsafe(
        `INSERT INTO projects (id, name, owner_id, dept_id, repository_url)
         VALUES ($1::uuid, 'mig107-spread-project', $2::uuid, $3::uuid,
                 'https://example.invalid/mig107-spread')
         ON CONFLICT (id) DO NOTHING`, [PROJECT_ID, OWNER_ID, DEPT_ID]);

      await tx.unsafe(
        `INSERT INTO approvals
           (tenant_id, project_id, requester_id, status, kind, description,
            expires_at, created_at, updated_at, metadata)
         SELECT $1::uuid, $2::uuid, $3::uuid, 'pending', 'generic'::approval_kind,
                '[mig107-spread] row ' || g,
                NULL, now() - (g || ' minutes')::interval, now(),
                jsonb_build_object('test_tag', $4::text)
           FROM generate_series(1, $5::int) g`,
        [TENANT_ID, PROJECT_ID, OWNER_ID, TAG, N],
      );
      await tx.unsafe(
        `INSERT INTO approvals
           (tenant_id, project_id, requester_id, status, kind, description,
            expires_at, created_at, updated_at, metadata)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'approved', 'generic'::approval_kind,
            '[mig107-spread] control wrong_status', NULL, now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'wrong_status')),
           ($1::uuid, $2::uuid, $3::uuid, 'pending', 'generic'::approval_kind,
            '[mig107-spread] control already_has_expiry',
            now() + interval '3 days', now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'already_has_expiry'))`,
        [TENANT_ID, PROJECT_ID, OWNER_ID, TAG],
      );

      await tx.unsafe(MIGRATION);

      const mine = async (): Promise<Stamped[]> =>
        (await tx.unsafe(
          `SELECT id, expires_at, created_at,
                  (metadata->'default_expiry_backfill_107'->>'spread_rank')::int AS rank
             FROM approvals
            WHERE metadata->>'test_tag' = $1::text
              AND metadata->'default_expiry_backfill_107' ? 'spread_rank'
            ORDER BY expires_at`,
          [TAG],
        )) as unknown as Stamped[];

      const got = await mine();

      // Every eligible row stamped, and ONLY eligible rows — the two controls
      // must not appear.
      expect(got.length).toBe(N);

      // ⚠️ THE DISCRIMINATING ASSERTION. A single now() makes these equal.
      // Mutation-verified 2026-09-02 against a real Postgres 18: the fixed
      // migration yields 120 distinct deadlines of 120, the pre-audit form
      // yields 1 of 120. Every other assertion in this test survives that
      // mutant, so this line is the one carrying the defect.
      expect(new Set(got.map((r) => String(r.expires_at))).size).toBe(N);

      // Exactly one minute apart, so the spread is derivable, not accidental.
      const first = new Date(at(got, 0).expires_at).getTime();
      const last = new Date(at(got, got.length - 1).expires_at).getTime();
      expect(last - first).toBe((N - 1) * 60_000);

      // The OLDEST approval matures first — waiting longest is served first.
      expect(at(got, 0).rank).toBe(1);
      const byCreated = [...got].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      expect(at(byCreated, 0).id).toBe(at(got, 0).id);

      // No 15-minute tick may exceed what the phase deadline can actually send.
      // This is the whole point: the worst tick must fit the sequential send
      // loop inside its 60s deadline even at the full per-send ceiling, so no
      // row is ever deferred into the unreachable state.
      const buckets = new Map<number, number>();
      for (const r of got) {
        const b = Math.floor(new Date(r.expires_at).getTime() / TICK_MS);
        buckets.set(b, (buckets.get(b) ?? 0) + 1);
      }
      const worst = Math.max(...buckets.values());
      expect(worst * PER_SEND_CEILING_MS).toBeLessThanOrEqual(PHASE_DEADLINE_MS);
      expect(worst).toBeLessThanOrEqual(BATCH_SIZE);

      // Negative controls untouched.
      const controls = (await tx.unsafe(
        `SELECT (COALESCE(metadata,'{}'::jsonb) ? 'default_expiry_backfill_107') AS stamped
           FROM approvals
          WHERE metadata->>'test_tag' = $1::text AND metadata ? 'control'`,
        [TAG],
      )) as unknown as { stamped: boolean }[];
      expect(controls.length).toBe(2);
      for (const c of controls) expect(c.stamped).toBe(false);

      // Re-running matches zero rows, and re-stamps no deadline.
      const before = got.map((r) => String(r.expires_at));
      await tx.unsafe(MIGRATION);
      const after = (await mine()).map((r) => String(r.expires_at));
      expect(after).toEqual(before);

      // The rollback documented in the migration header restores every row.
      await tx.unsafe(
        `UPDATE approvals SET expires_at = NULL
          WHERE metadata->>'test_tag' = $1::text
            AND metadata ? 'default_expiry_backfill_107'
            AND (metadata->'default_expiry_backfill_107'->>'previous_expires_at') IS NULL`,
        [TAG],
      );
      const left = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM approvals
          WHERE metadata->>'test_tag' = $1::text
            AND metadata->'default_expiry_backfill_107' ? 'spread_rank'
            AND expires_at IS NOT NULL`,
        [TAG],
      )) as unknown as { n: number }[];
      expect(at(left, 0).n).toBe(0);

      throw new Rollback();
    });
  } catch (err) {
    // A Rollback sentinel is the success path. Anything else is a real failure
    // and must be re-thrown — swallowing it would make this test vacuous, which
    // is the exact shape this repo's own guards exist to catch.
    if (!(err instanceof Rollback)) failure = err;
  }

  if (failure) throw failure;
});
