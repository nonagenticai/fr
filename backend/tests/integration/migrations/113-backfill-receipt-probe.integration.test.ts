// tests/integration/migrations/113-backfill-receipt-probe.integration.test.ts
//
// Proves that migration 113's COLUMN_PROBES entry cannot be satisfied by
// `drizzle-kit push`, against a REAL Postgres.
//
// WHAT WENT WRONG, AND WHY A TEST WAS THE ONLY WAY TO NOTICE
// ----------------------------------------------------------
// The migration runner stamps an unprobed migration APPLIED WITHOUT RUNNING IT
// when `_migrations` is empty and `projects` exists — exactly what CI's
// `drizzle-kit push` -> ci-seed -> migrate bootstrap produces. A probe is the
// only thing that forces the file to actually run, so a probe that push can
// satisfy is a probe that silently does nothing.
//
// 113 was probed on its CHECK constraint, justified in three separate comments
// (migration-runner.ts, schema.ts, and 113's own header) by the claim that
// "drizzle has no CHECK primitive and push emits none".
//
//   ⛔ THE CLAIM IS FALSE. `check` is imported at src/db/schema.ts:18 and used
//   25 times. MEASURED 2026-09-06 on a scratch postgres:18: `drizzle-kit push`
//   against an empty database emitted 31 CHECK constraints.
//
// `approvals_callback_resolution_check` was absent from a push-built database
// for one reason only — nobody had declared THAT check in schema.ts. And
// schema.ts and tests/integration/services/db-invariants.integration.test.ts
// instruct the next author to declare every hand-written CHECK there, for
// CI/prod parity. The first author who obeyed would have turned 113 into
// "stamped applied, never run", dropping its backfill, on a green CI.
//
// It is declared there now (parity, as instructed), so that is not hypothetical:
// the old probe would be vacuous TODAY. This file pins the replacement.
//
// ⭐ THE PROBE IS NOW THE BACKFILL'S OWN RECEIPT. `push` builds a schema — it
// creates tables, columns, indexes and CHECK constraints, every one of which has
// at some point been used as a probe here, and every one of which goes vacuous
// the moment somebody declares it in schema.ts. It has no mechanism that can
// INSERT A ROW. The receipt in `_migration_effects` is written by the SAME
// data-modifying CTE as the backfill UPDATE, so it cannot exist unless the
// UPDATE ran to completion.
//
// ⚠️ THE PROBE ASKS WHETHER THE STATEMENT RAN, NOT WHAT IT TOUCHED — and the
// third case below is why. On a fresh database `approvals` is empty, so the
// backfill correctly updates ZERO rows: a `count(*) > 0` probe would be FALSE
// after a perfectly good apply and would hard-fail every boot from then on
// (probes are re-evaluated on EVERY startup and must stay true once true).
//
// ⚠️ IT EXERCISES THE REGISTERED PROBE (`probeForMigration`), not a local copy
// of its query. Re-point 113's entry at a constraint / column / table and this
// file goes RED; a test that called the helper directly would not.
//
// Everything runs inside ONE sql.begin() that is ALWAYS rolled back — the
// migration's UPDATE touches every matching row in the table, and this database
// is shared.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const MIGRATION_NAME = '113_approval_callback_effect_marker.sql';
const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, '../../../migrations', MIGRATION_NAME),
  'utf8',
);

/** Sentinel that forces postgres.js to roll back — a callback that returns COMMITS. */
class Rollback extends Error {}

// Postgres reachability comes from the SHARED harness, not a local probe: it
// runs at MODULE LOAD (before any test registers), so the database-backed cases
// below register as `test.skipIf` and print a visible `skip` rather than a body
// that returns early and counts as a pass.
//
// ⚠️ The fail-loud property is now CONDITIONAL, and that is a real change. Each
// DB case used to open with `expect(reachable).toBe(true)`, which failed the
// file whatever the environment. The harness throws at import when
// `DATABASE_URL` is set or `CI=true` and Postgres is unreachable — CI always
// takes that branch — but a developer with neither set now gets a visible SKIP
// where they previously got a failure. A body that RUNS without asserting still
// fails: `itDb` wraps each one in `expect.hasAssertions()`.
const { itDb } = createDbSuite('113-backfill-receipt-probe');

async function rolledBack(fn: (tx: postgres.Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as postgres.Sql);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/**
 * Clear 113's receipt row, on a database that may not have the receipt TABLE.
 *
 * ⛔ FIXED 2026-09-06 — every case below opened with a bare
 * `DELETE FROM _migration_effects`, which is the one ordering this file must not
 * assume: `_migration_effects` is CREATED BY THE MIGRATION UNDER TEST. On the
 * database this suite is FOR — a push-built CI database where 113 has never run
 * — that DELETE raises `relation "_migration_effects" does not exist` and the
 * case fails on its setup, before reaching a single assertion. It passed only
 * because the developer database it was written against had already run 113.
 *
 * The guarded DELETE, rather than a copy of the CREATE TABLE: duplicating the
 * DDL here would be a second definition free to drift from the migration's, and
 * the whole point of this file is that the migration is the only thing that may
 * produce the receipt. `to_regclass` returns NULL instead of raising for a table
 * that does not exist, so the no-table case is a no-op and the probe below
 * correctly reads FALSE — which is exactly the state under test.
 */
async function clearReceipt(tx: postgres.Sql): Promise<void> {
  await tx.unsafe(`
    DO $$
    BEGIN
      IF to_regclass('_migration_effects') IS NOT NULL THEN
        DELETE FROM _migration_effects
         WHERE migration = '113_approval_callback_effect_marker.sql';
      END IF;
    END
    $$;
  `);
}

test('113 has a registered probe at all', () => {
  expect(typeof probeForMigration(MIGRATION_NAME)).toBe('function');
});

itDb('the CHECK constraint push emits is NOT what the probe reads', async () => {
  const probe = probeForMigration(MIGRATION_NAME)!;

  await rolledBack(async (tx) => {
    // The push-shaped database: schema present (this DB has it), the CHECK
    // constraint present — `drizzle-kit push` emits it now that schema.ts
    // declares it, MEASURED on a scratch DB — and the migration never run.
    const [c] = await tx<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'approvals'
           AND c.conname = 'approvals_callback_resolution_check'
      ) AS present
    `;
    // ⭐ THE OLD PROBE, AND IT IS TRUE. This is the vacuity: on a push-built CI
    // database this reads true and 113 is stamped applied without running.
    expect(c!.present).toBe(true);

    await clearReceipt(tx);

    // ⭐ THE ASSERTION. Same database, same constraint, and the registered probe
    // says NO. MUTANT: re-point 113's COLUMN_PROBES entry at
    // constraintExists(approvals, approvals_callback_resolution_check) and this
    // goes RED.
    expect(await probe(tx)).toBe(false);
  });
});

itDb('running the migration is what makes the probe true', async () => {
  const probe = probeForMigration(MIGRATION_NAME)!;

  await rolledBack(async (tx) => {
    await clearReceipt(tx);
    expect(await probe(tx)).toBe(false);

    await tx.unsafe(MIGRATION_SQL);

    expect(await probe(tx)).toBe(true);
  });
});

itDb('the receipt records the row count but the probe does not depend on it', async () => {
  const probe = probeForMigration(MIGRATION_NAME)!;

  await rolledBack(async (tx) => {
    await clearReceipt(tx);

    // Make the backfill a genuine no-op, the way it is on any fresh database:
    // nothing left to copy from callback_delivered_at into callback_acked_at.
    await tx`
      UPDATE approvals SET callback_acked_at = callback_delivered_at
       WHERE callback_delivered_at IS NOT NULL AND callback_acked_at IS NULL
    `;
    const [pending] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM approvals
       WHERE callback_delivered_at IS NOT NULL AND callback_acked_at IS NULL
    `;
    expect(pending!.n).toBe('0');

    await tx.unsafe(MIGRATION_SQL);

    // ⭐ ZERO ROWS TOUCHED, AND THE PROBE IS STILL TRUE. A probe written against
    // the backfill's OUTCOME (`no row left to copy`, or `count(*) > 0`) is
    // either true before the migration ran or false after it did — vacuous in
    // one direction and a permanent boot failure in the other.
    const [receipt] = await tx<{ detail: { backfilled_rows: number } }[]>`
      SELECT detail FROM _migration_effects WHERE migration = ${MIGRATION_NAME}
    `;
    expect(receipt!.detail.backfilled_rows).toBe(0);
    expect(await probe(tx)).toBe(true);
  });
});
