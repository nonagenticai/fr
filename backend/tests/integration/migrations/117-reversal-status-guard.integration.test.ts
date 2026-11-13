// tests/integration/migrations/117-reversal-status-guard.integration.test.ts
//
// Pins the ONE way migration 117 differs from the rollback migration 107
// published in its own header: `AND status = 'pending'`.
//
// WHY THIS NEEDS A TEST AND NOT A COMMENT
// ---------------------------------------
// 107's header (lines 34-38) prints a rollback with no `status` term. Copied
// verbatim it clears `expires_at` on every row 107 ever touched, including rows
// that have since been approved or voided. Measured on the production standby
// 2026-09-09: the guarded predicate matches 191 rows, the published one matches
// 925 — 734 already-decided rows (327 approved, 407 voided) whose deadline is
// now historical record, in a table with no history table, no audit trigger and
// no `updated_at` trigger.
//
// A header comment saying "we added a status guard" is not a control. The next
// author to touch this file is exactly the person who would delete the term to
// "make the rollback complete", and the only thing that can stop them is a test
// that goes RED when the decided rows lose their deadline.
//
// ⛔ THE CONTROL ROWS ARE THE POINT OF THIS FILE. An assertion that the 'pending'
// row was cleared passes under BOTH predicates — the guarded one and the
// defective one — so on its own it proves nothing about the guard. The
// approved/voided rows are the only assertions here that can tell the two
// apart, and they are what a mutation of the `status` term has to kill.
//
// ⚠️ EVERYTHING RUNS INSIDE ONE sql.begin() THAT ALWAYS ROLLS BACK. Migration
// 117's UPDATE is not scoped to this test's fixtures — it reverses every
// 107-stamped pending row in the database — and this database is shared. A bare
// unsafe('BEGIN')/unsafe('ROLLBACK') can land on different pooled connections,
// so the writes would escape. Rollback is forced by throwing a sentinel, because
// postgres.js COMMITS a callback that returns normally: without the throw,
// "assertions passed" would mean "the writes were kept".
//
// ⚠️ EVERY BIND PARAMETER IS EXPLICITLY CAST (::uuid / ::text). Postgres raised
// 42P18 on an uncast parameter in CI for the sibling 107 test while the local
// dry-run inlined the values and passed. Do not remove the casts.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';

const MIGRATION = readFileSync(
  join(import.meta.dir, '../../../migrations/117_reverse_default_expiry_backfill.sql'),
  'utf8',
);

// Unique per run so a re-used database and a parallel worker cannot collide.
const TAG = `mig117-guard-${process.pid}-${Date.now()}`;

// Distinct from the 107 test's fixture ids so `bun test` can run both in one
// process without either one's ON CONFLICT DO NOTHING silently adopting the
// other's chain.
const WORKSPACE_ID = '00000000-0000-4000-8000-0000005e1171';
const DEPT_ID = '00000000-0000-4000-8000-0000005e1172';
const PROJECT_ID = '00000000-0000-4000-8000-0000005e1173';
const OWNER_ID = '00000000-0000-4000-8000-0000005e1174';
const TENANT_ID = WORKSPACE_ID;

class Rollback extends Error {}

// Indexing a possibly-empty array is exactly the defect this test would
// otherwise hide, so assert non-empty loudly rather than reaching for `!`.
function at<T>(rows: T[], i: number): T {
  const row = rows[i];
  if (row === undefined) {
    throw new Error(`expected a row at index ${i}, got ${rows.length} rows`);
  }
  return row;
}

async function deadlineOf(
  tx: postgres.TransactionSql<Record<string, never>>,
  control: string,
): Promise<string | null> {
  const rows = (await tx.unsafe(
    `SELECT expires_at FROM approvals
      WHERE metadata->>'test_tag' = $1::text
        AND metadata->>'control'  = $2::text`,
    [TAG, control],
  )) as unknown as { expires_at: string | null }[];
  expect(rows.length).toBe(1);
  return at(rows, 0).expires_at;
}

test('migration 117 clears the manufactured deadline on pending rows ONLY', async () => {
  let failure: unknown;

  try {
    await sql.begin(async (tx) => {
      // ⚠️ `approvals` is a 29-column table with NOT NULL columns that have no
      // defaults (tenant_id, project_id, requester_id, kind, description), and
      // project_id carries an FK to projects. A hand-rolled INSERT fails 23502,
      // so the whole workspace -> department -> project chain is seeded here.
      // All of it is inside the transaction, so ROLLBACK is the teardown.
      await tx.unsafe(
        `INSERT INTO workspaces (id, name) VALUES ($1::uuid, 'mig117-guard-ws')
         ON CONFLICT (id) DO NOTHING`,
        [WORKSPACE_ID],
      );
      await tx.unsafe(
        `INSERT INTO departments (id, workspace_id, name)
         VALUES ($1::uuid, $2::uuid, 'mig117-guard-dept')
         ON CONFLICT (id) DO NOTHING`,
        [DEPT_ID, WORKSPACE_ID],
      );
      // repository_url is NOT NULL with no default.
      await tx.unsafe(
        `INSERT INTO projects (id, name, owner_id, dept_id, repository_url)
         VALUES ($1::uuid, 'mig117-guard-project', $2::uuid, $3::uuid,
                 'https://example.invalid/mig117-guard')
         ON CONFLICT (id) DO NOTHING`,
        [PROJECT_ID, OWNER_ID, DEPT_ID],
      );

      // Four rows, all carrying the 107 stamp with previous_expires_at = NULL,
      // all carrying a deadline. They differ ONLY in `status`, so `status` is
      // the only thing any difference in outcome can be attributed to.
      //
      // The fifth row is the OTHER half of the migration's scope claim: a
      // pending row with a deadline and NO 107 stamp, standing in for the 797
      // caller-set `source='n8n'` deadlines on prod that must survive untouched.
      await tx.unsafe(
        `INSERT INTO approvals
           (tenant_id, project_id, requester_id, status, kind, description,
            expires_at, created_at, updated_at, metadata)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'pending', 'generic'::approval_kind,
            '[mig117] target pending', now() + interval '1 day', now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'pending',
              'default_expiry_backfill_107',
              jsonb_build_object('previous_expires_at', NULL))),
           ($1::uuid, $2::uuid, $3::uuid, 'approved', 'generic'::approval_kind,
            '[mig117] control approved', now() + interval '1 day', now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'approved',
              'default_expiry_backfill_107',
              jsonb_build_object('previous_expires_at', NULL))),
           ($1::uuid, $2::uuid, $3::uuid, 'voided', 'generic'::approval_kind,
            '[mig117] control voided', now() + interval '1 day', now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'voided',
              'default_expiry_backfill_107',
              jsonb_build_object('previous_expires_at', NULL))),
           ($1::uuid, $2::uuid, $3::uuid, 'pending', 'generic'::approval_kind,
            '[mig117] control had a real previous deadline',
            now() + interval '1 day', now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'had_previous',
              'default_expiry_backfill_107',
              jsonb_build_object('previous_expires_at', '2026-01-01T00:00:00Z'))),
           ($1::uuid, $2::uuid, $3::uuid, 'pending', 'generic'::approval_kind,
            '[mig117] control caller-set deadline, no 107 stamp',
            now() + interval '14 days', now(), now(),
            jsonb_build_object('test_tag', $4::text, 'control', 'unstamped'))`,
        [TENANT_ID, PROJECT_ID, OWNER_ID, TAG],
      );

      // Positive control: every fixture starts WITH a deadline. Without this the
      // assertions below could all pass on rows that never had one, and the test
      // would be measuring nothing.
      const before = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM approvals
          WHERE metadata->>'test_tag' = $1::text AND expires_at IS NOT NULL`,
        [TAG],
      )) as unknown as { n: number }[];
      expect(at(before, 0).n).toBe(5);

      // ⚠️ THE RECEIPT MUST BE CLEARED FIRST, INSIDE THE TRANSACTION, OR THE
      // COUNT ASSERTION BELOW MEASURES SOMEBODY ELSE'S APPLY. The migration
      // runner already applied 117 at boot on any database this suite runs
      // against, and on a fresh CI database it correctly reversed ZERO rows
      // (approvals is empty). The INSERT is ON CONFLICT DO NOTHING, so a
      // re-apply here would keep that stale `reversed_rows: 0` and the receipt
      // would say nothing about the rows THIS test just seeded — the assertion
      // would fail for a reason that has nothing to do with the status guard.
      // Deleting it makes the count our own. The transaction rolls back, so the
      // real receipt is restored.
      await tx.unsafe(
        `DELETE FROM _migration_effects
          WHERE migration = '117_reverse_default_expiry_backfill.sql'`,
      );

      await tx.unsafe(MIGRATION);

      // THE FIX: the undecided row is decidable again — the reaper's predicate
      // `status='pending' AND expires_at <= now()` cannot match NULL.
      expect(await deadlineOf(tx, 'pending')).toBeNull();

      // ⛔ THE GUARD. These two are the assertions 107's published rollback
      // fails. A decided approval's deadline is historical record and this
      // migration must not touch it.
      expect(await deadlineOf(tx, 'approved')).not.toBeNull();
      expect(await deadlineOf(tx, 'voided')).not.toBeNull();

      // A row whose stamp records a REAL prior deadline was not manufactured out
      // of nothing, so NULL is not its correct restoration and it is out of
      // scope. Measured 0 such rows on prod, but the term is the guarantee.
      expect(await deadlineOf(tx, 'had_previous')).not.toBeNull();

      // The 797-row control, in miniature: a caller-set deadline with no 107
      // stamp survives. This is what makes the migration surgical rather than a
      // blanket "clear all pending deadlines".
      expect(await deadlineOf(tx, 'unstamped')).not.toBeNull();

      // The receipt proves the statement RAN — the one probe shape
      // `drizzle-kit push` cannot fake, since push cannot INSERT A ROW. The
      // count is `>= 1` and not `=== 1` deliberately: this database is shared
      // and may hold other 107-stamped pending rows, which this migration
      // legitimately reverses too. Pinning an exact number here would make the
      // test fail for other suites' fixtures rather than for a real defect.
      const receipt = (await tx.unsafe(
        `SELECT detail->>'reversed_rows' AS reversed
           FROM _migration_effects
          WHERE migration = '117_reverse_default_expiry_backfill.sql'`,
      )) as unknown as { reversed: string }[];
      expect(receipt.length).toBe(1);
      expect(Number(at(receipt, 0).reversed)).toBeGreaterThanOrEqual(1);

      // Idempotence, proven rather than asserted: a second apply must be a
      // no-op. `ON CONFLICT DO NOTHING` also means the receipt keeps its
      // ORIGINAL count instead of being overwritten with the re-run's zero.
      const firstCount = Number(at(receipt, 0).reversed);
      await tx.unsafe(MIGRATION);
      const again = (await tx.unsafe(
        `SELECT detail->>'reversed_rows' AS reversed
           FROM _migration_effects
          WHERE migration = '117_reverse_default_expiry_backfill.sql'`,
      )) as unknown as { reversed: string }[];
      expect(Number(at(again, 0).reversed)).toBe(firstCount);
      expect(await deadlineOf(tx, 'approved')).not.toBeNull();

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
