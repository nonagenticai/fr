// tests/helpers/destructive-hatch.ts
//
// THE ONE PLACE A TEST FIXTURE DECLARES DESTRUCTIVE INTENT.
//
// migrations/142_destructive_statement_guard.sql attaches two statement
// triggers to every protected table: `BEFORE TRUNCATE` refuses
// unconditionally, and `AFTER DELETE` refuses a statement that either emptied
// a table holding >= 50 rows or removed > 2000 rows. Its only escape hatch is
// the GUC `fr.allow_destructive = 'on'`.
//
// ── WHY THE TEST PATH MAY DO THIS AND PRODUCTION MAY NOT ──────────────────
// The guard exists because fr's protected tables have NO regeneration path:
// per the 2026-09-28 ruling, system assets live in postgres and are recovered
// by RESTORE, never by re-seeding, so a wrongly-wiped table is unrecoverable
// rows. A TEST fixture inverts every term of that: its tables hold rows the
// fixture itself created seconds earlier, in a throwaway database (a
// per-file `docker run postgres:18`, or CI's ephemeral `postgres:18` service),
// and "recovery" is re-running the fixture. Resetting between tests is not a
// destructive accident the guard should catch — it is the fixture's ENTIRE
// PURPOSE, stated up front.
//
// ⛔ What must NOT happen instead, and why this file exists rather than any of
// them: dropping the table from `protected_tables`, adding a `NODE_ENV` /
// `CI` / env-var bypass inside fr_refuse_truncate(), or raising EMPTIED_MIN
// above the fixture's row count. Each of those disarms the guard in
// PRODUCTION to make a test convenient — a guard that switches itself off
// wherever it is inconvenient is precisely the defect class fr#1283 removes.
// The guard is not weakened here; the CALLER declares intent, per statement,
// and every other statement in the suite still meets the full refusal.
//
// ── WHY A TRANSACTION IS NOT OPTIONAL ─────────────────────────────────────
// `SET LOCAL` is reverted at the transaction boundary, which is the whole
// reason it is safe: fr reaches postgres through PgBouncer in TRANSACTION
// pooling, where a session-level `SET fr.allow_destructive = 'on'` outlives
// the setter's transaction on that server backend and is handed to the NEXT
// client, recycling only at `server_lifetime` (3600s). That exact mistake — an
// auditor's "safe" read-only SET — cost this estate 15 procedure writes and
// ~300 inserts on 2026-09-22.
//
// The corollary for fixtures: `SET LOCAL` issued OUTSIDE a transaction is a
// no-op with a warning, so a fixture that simply prepends the SET to its
// existing autocommit statement is still refused. The reset has to be
// RE-ISSUED inside one transaction, which is what `sql.begin()` below does.
// Never offer a variant of these helpers that sets the GUC at session level.

import type { Sql, TransactionSql } from 'postgres';

/** Postgres unquoted-identifier shape. Anything else is rejected, not quoted. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Run `fn` in ONE transaction that has the fr#1283 hatch armed.
 *
 * The callback receives the transaction handle and MUST use it — a statement
 * issued on the outer `sql` runs on a different connection, outside this
 * transaction, and is refused exactly as if the hatch were never armed.
 */
export async function withDestructiveHatch(
  sql: Sql,
  fn: (tx: TransactionSql) => Promise<unknown>,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Literal, not a bound parameter: SET does not take parameters. `SET LOCAL`
    // (never a bare `SET`) — see the header.
    await tx`SET LOCAL fr.allow_destructive = 'on'`;
    await fn(tx);
  });
}

/**
 * `TRUNCATE TABLE <t> RESTART IDENTITY CASCADE` for each table, in one armed
 * transaction — the fixture-reset shape migration 142 refuses unconditionally.
 *
 * One statement for all tables so a CASCADE between them cannot order-fail.
 */
export async function truncateForTests(sql: Sql, ...tables: string[]): Promise<void> {
  if (tables.length === 0) {
    throw new Error('[destructive-hatch] truncateForTests called with no tables');
  }
  for (const t of tables) {
    // `tx.unsafe` is the only way to put an identifier in a TRUNCATE, so the
    // identifier is validated here rather than trusted. Test-only code, but a
    // fixture that interpolated a computed name would be a real injection.
    if (!SAFE_IDENT.test(t)) {
      throw new Error(`[destructive-hatch] refusing unsafe table identifier: ${JSON.stringify(t)}`);
    }
  }
  const list = tables.map((t) => `"${t}"`).join(', ');
  await withDestructiveHatch(sql, (tx) =>
    tx.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`),
  );
}
