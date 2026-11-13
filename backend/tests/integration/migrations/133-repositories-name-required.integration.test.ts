// tests/integration/migrations/133-repositories-name-required.integration.test.ts
//
// Proves, against a REAL Postgres, that `repositories.name` can no longer be
// NULL and can no longer be BLANK — the DB half of "there are never blank
// repository names".
//
// WHY THE DATABASE AND NOT JUST THE ROUTE. There were FOUR insert paths into
// `repositories` (routes/repositories.ts, routes/projects.ts ×2,
// routes/project-repositories.ts) and three of them wrote `?? null`. A route test
// proves the path it drives; it says nothing about the fifth path someone adds
// next month, or about a seed script, or about hand-run SQL. `NOT NULL` +
// `CHECK (btrim(name) <> '')` is the only guarantee that does not depend on a
// caller remembering `lib/repository-name.ts`.
//
// ⭐ THE TWO KILLING MUTATIONS, AND WHY BOTH ARMS ARE NEEDED:
//   · delete `ALTER COLUMN name SET NOT NULL` from migration 133 → the NULL arm
//     goes GREEN (the insert succeeds) and this file goes RED.
//   · delete the `repositories_name_not_blank` CHECK → the '' and '   ' arms go
//     GREEN and this file goes RED.
// Neither mutation is caught by the other's arm: NOT NULL admits '' and '   ',
// and the CHECK admits NULL (`btrim(NULL) <> ''` is NULL, which a CHECK treats as
// satisfied). That is the entire reason the migration carries two statements, and
// a single-arm test here would have let either half be dropped in silence.
//
// ⚠️ HOW THIS FILE BEHAVES WITHOUT A POSTGRES — read it, do not assume.
// It used to open every case with `expect(reachable).toBe(true)`, i.e. a missing
// database FAILED the file unconditionally. It no longer does that. Every case
// now registers through the shared `createDbSuite` harness
// (tests/integration/helpers/db-suite.ts), which probes at module load and then:
//   · `DATABASE_URL` set, or `CI=true`, and Postgres unreachable → THROWS at
//     import, so the file errors out. This is the property the old first-line
//     assertion existed for, and CI always takes this branch.
//   · neither set (a developer with no database) → the cases register via
//     `test.skipIf(true)`, so bun prints a visible `skip` per case and warns
//     once to stderr. That is a SKIP, not a pass — but it is a skip, and this
//     header used to claim it could not happen.
// A body that runs without asserting still fails: `itDb` wraps each one in
// `expect.hasAssertions()`, and the suite fails the file if zero bodies ran
// against a reachable database. Same harness as the 131 sibling.
//
// ⚠️ EVERY CASE RUNS INSIDE ONE `sql.begin()` THAT IS ALWAYS ROLLED BACK. The
// local Postgres is shared with other sessions; nothing here commits a row.

import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const MIGRATION_NAME = '133_repositories_name_required.sql';
const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, '../../../migrations', MIGRATION_NAME),
  'utf8',
);

/** Sentinel that forces postgres.js to roll back — returning from the callback COMMITS. */
class Rollback extends Error {}

// A user id with no FK behind it (`repositories.user_id` carries none), pinned so
// a leaked row would be identifiable. Nothing here commits, so nothing leaks.
const USER_ID = '00000000-0000-4000-8000-000000133001';
const URL_BASE = 'https://github.com/mig133/probe';

const { itDb } = createDbSuite('133-repositories-name-required');

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
 * Apply 133 inside the transaction so the case measures the file under test
 * rather than whatever state the shared database happens to be in. Both of its
 * statements are existence-guarded, so on an already-migrated database this is a
 * no-op (and takes no ACCESS EXCLUSIVE lock, because the ALTER is skipped).
 */
async function applyMigration(tx: postgres.Sql): Promise<void> {
  await tx.unsafe(MIGRATION_SQL);
}

/** Insert one repositories row with an explicit `name`, returning the pg error code. */
async function insertNameAndCatch(
  tx: postgres.Sql,
  name: string | null,
  urlSuffix: string,
): Promise<{ ok: true } | { ok: false; code: string; constraint?: string }> {
  try {
    await tx`
      INSERT INTO repositories (user_id, name, url, branch)
      VALUES (${USER_ID}, ${name}, ${`${URL_BASE}-${urlSuffix}.git`}, 'main')
    `;
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return { ok: false, code: String(e.code), constraint: e.constraint_name };
  }
}

// ---------------------------------------------------------------------------
// the constraint itself
// ---------------------------------------------------------------------------

itDb('POSITIVE CONTROL — a row WITH a name still inserts', async () => {
  await rolledBack(async (tx) => {
    await applyMigration(tx);
    // Without this arm, the two rejection arms below could be passing because the
    // INSERT is malformed rather than because the constraints fired.
    const res = await insertNameAndCatch(tx, 'mig133/probe', 'control');
    expect(res).toEqual({ ok: true });
  });
});

itDb('name = NULL is REJECTED (not_null_violation)', async () => {
  await rolledBack(async (tx) => {
    await applyMigration(tx);
    const res = await insertNameAndCatch(tx, null, 'null');
    expect(res.ok).toBe(false);
    // 23502 = not_null_violation. MUTANT: drop `SET NOT NULL` → `ok: true`.
    expect((res as { code: string }).code).toBe('23502');
  });
});

itDb('name = the empty string is REJECTED (check_violation)', async () => {
  await rolledBack(async (tx) => {
    await applyMigration(tx);
    const res = await insertNameAndCatch(tx, '', 'empty');
    expect(res.ok).toBe(false);
    // 23514 = check_violation. NOT NULL does not catch this one.
    expect((res as { code: string }).code).toBe('23514');
    expect((res as { constraint?: string }).constraint).toBe('repositories_name_not_blank');
  });
});

itDb('name = whitespace only is REJECTED (check_violation)', async () => {
  await rolledBack(async (tx) => {
    await applyMigration(tx);
    // ⭐ THE VALUE A FORM ACTUALLY PRODUCES. `z.string().min(1)` accepted it and
    // `NOT NULL` accepts it; only `btrim(name) <> ''` refuses it.
    // MUTANT: drop the CHECK → `ok: true`.
    const res = await insertNameAndCatch(tx, '   ', 'blank');
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('23514');
    expect((res as { constraint?: string }).constraint).toBe('repositories_name_not_blank');
  });
});

itDb('the CHECK covers UPDATE, not only INSERT', async () => {
  await rolledBack(async (tx) => {
    await applyMigration(tx);
    await insertNameAndCatch(tx, 'mig133/probe', 'update');
    let code: string | undefined;
    try {
      await tx`
        UPDATE repositories SET name = '   '
         WHERE user_id = ${USER_ID} AND url = ${`${URL_BASE}-update.git`}
      `;
    } catch (err) {
      code = String((err as { code?: string }).code);
    }
    // A blank arriving via PUT /api/repositories/:id is the other half of the
    // original defect; the CHECK is what makes the column's invariant hold
    // regardless of which statement writes it.
    expect(code).toBe('23514');
  });
});

// ---------------------------------------------------------------------------
// the runner's own view of the file
// ---------------------------------------------------------------------------

itDb('133 has a registered probe, and it reads TRUE only once BOTH halves exist', async () => {
  const probe = probeForMigration(MIGRATION_NAME);
  expect(typeof probe).toBe('function');

  await rolledBack(async (tx) => {
    await applyMigration(tx);
    expect(await probe!(tx)).toBe(true);

    // Drop the CHECK only. The column is still NOT NULL, so a probe that looked
    // at nullability alone would keep reading TRUE and the backfill would stamp
    // 133 applied over a half-enforced schema.
    // MUTANT: remove the pg_constraint half of the registered probe → RED.
    await tx.unsafe('ALTER TABLE repositories DROP CONSTRAINT repositories_name_not_blank');
    expect(await probe!(tx)).toBe(false);
  });
});
