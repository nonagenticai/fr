// tests/integration/migrations/140-card-version-stamps.integration.test.ts
//
// Migration 140 creates `card_version_stamps` (C1-46). What has to hold:
//   * the file is IDEMPOTENT — a second (and third) run over a database that
//     already has the table is a no-op, not an error. The runner may re-run it
//     (`reapplyIfProbeFails`), and a re-run that raised would wedge boot;
//   * the registered COLUMN_PROBES row reads FALSE without the table and TRUE
//     after the file runs — probed through `probeForMigration`, the check the
//     runner actually uses, not a copy of its query;
//   * the constraints the route relies on: card_id PK (the ON CONFLICT arbiter),
//     non-empty card_id, 64-hex sha256, project FK with ON DELETE CASCADE.
//
// 140 is NOT in schema.ts, so in CI the table is built by THIS file (the probe
// keeps it pending on the push-built database) — one emitter, no second arm.
//
// ── ONE sql.begin() THAT ALWAYS ROLLS BACK ───────────────────────────────────
// Same discipline as the 127/131 tests: the database is shared, so the DROP,
// every re-run and every fixture are undone by a sentinel throw (postgres.js
// COMMITS a callback that returns normally). A statement EXPECTED to fail runs
// inside `tx.savepoint()` so the transaction is not aborted (25P02).

import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const MIGRATION_NAME = '140_card_version_stamps.sql';
const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, '../../../migrations', MIGRATION_NAME),
  'utf8',
);
const OWNER = '00000000-0000-4000-8000-0000140b0010';
const SHA = 'a'.repeat(64);

class Rollback extends Error {}

const { itDb } = createDbSuite('140-card-version-stamps');

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

/** SQLSTATE of the statement, run in a savepoint; null when it succeeded. */
async function sqlState(tx: postgres.Sql, stmt: () => Promise<unknown>): Promise<string | null> {
  try {
    await (tx as unknown as postgres.TransactionSql).savepoint(async () => {
      await stmt();
    });
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function seedProject(tx: postgres.Sql): Promise<string> {
  const rows = (await tx.unsafe(
    `INSERT INTO public.projects (owner_id, name, repository_url)
     VALUES ($1::uuid, $2::text, 'https://example.invalid/mig140.git')
     RETURNING id`,
    [OWNER, `mig140-${process.pid}-${Date.now()}`],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

const probe = probeForMigration(MIGRATION_NAME);

itDb('140 has a registered probe', async () => {
  expect(typeof probe).toBe('function');
});

itDb('probe FALSE without the table; the file creates it; re-runs are no-ops', async () => {
  await rolledBack(async (tx) => {
    // Whatever built this database, start from "140 never ran".
    await tx.unsafe('DROP TABLE IF EXISTS public.card_version_stamps');
    expect(await probe!(tx)).toBe(false);

    await tx.unsafe(MIGRATION_SQL);
    expect(await probe!(tx)).toBe(true);

    // IDEMPOTENCE: two more runs over the existing table raise nothing …
    expect(await sqlState(tx, () => tx.unsafe(MIGRATION_SQL))).toBeNull();
    expect(await sqlState(tx, () => tx.unsafe(MIGRATION_SQL))).toBeNull();
    expect(await probe!(tx)).toBe(true);

    // … and leave exactly one table and one secondary index, not duplicates.
    const [idx] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'card_version_stamps'
    `;
    // PK index + card_version_stamps_project_idx.
    expect(Number(idx!.n)).toBe(2);
  });
});

itDb('a re-run preserves existing rows (no destructive statement)', async () => {
  await rolledBack(async (tx) => {
    await tx.unsafe(MIGRATION_SQL); // ensure present (no-op if already)
    const projectId = await seedProject(tx);
    await tx`
      INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
      VALUES ('mig140-keep', ${projectId}::uuid, '{"k":1}'::jsonb, ${SHA})
    `;
    await tx.unsafe(MIGRATION_SQL);
    const rows = await tx`SELECT stamp FROM card_version_stamps WHERE card_id = 'mig140-keep'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stamp).toEqual({ k: 1 });
  });
});

itDb('constraints: PK arbiter, non-empty card_id, hex sha256, project FK cascade', async () => {
  await rolledBack(async (tx) => {
    await tx.unsafe(MIGRATION_SQL);
    const projectId = await seedProject(tx);

    const first = await tx`
      INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
      VALUES ('mig140-c1', ${projectId}::uuid, '{"v":1}'::jsonb, ${SHA})
      ON CONFLICT (card_id) DO NOTHING RETURNING card_id
    `;
    expect(first).toHaveLength(1);
    // The route's arbiter: a second stamp for the same card is a no-op.
    const second = await tx`
      INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
      VALUES ('mig140-c1', ${projectId}::uuid, '{"v":2}'::jsonb, ${SHA})
      ON CONFLICT (card_id) DO NOTHING RETURNING card_id
    `;
    expect(second).toHaveLength(0);
    const kept = await tx`SELECT stamp FROM card_version_stamps WHERE card_id = 'mig140-c1'`;
    expect(kept[0]!.stamp).toEqual({ v: 1 });

    expect(
      await sqlState(tx, () => tx`
        INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
        VALUES ('', ${projectId}::uuid, '{}'::jsonb, ${SHA})
      `),
    ).toBe('23514');
    expect(
      await sqlState(tx, () => tx`
        INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
        VALUES ('mig140-badsha', ${projectId}::uuid, '{}'::jsonb, 'NOT-HEX')
      `),
    ).toBe('23514');
    expect(
      await sqlState(tx, () => tx`
        INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
        VALUES ('mig140-noproj', ${crypto.randomUUID()}::uuid, '{}'::jsonb, ${SHA})
      `),
    ).toBe('23503');

    await tx`DELETE FROM public.projects WHERE id = ${projectId}::uuid`;
    const after = await tx`SELECT 1 FROM card_version_stamps WHERE card_id = 'mig140-c1'`;
    expect(after).toHaveLength(0);
  });
});
