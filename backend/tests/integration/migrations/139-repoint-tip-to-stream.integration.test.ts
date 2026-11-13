// tests/integration/migrations/139-repoint-tip-to-stream.integration.test.ts
//
// Migration 139 repoints a `tenant_improvement_projects` row at the Planka
// project its (tenant, kind) stream uses. It must:
//   * repoint a TIP row whose (tenant, kind) has EXACTLY ONE stream that
//     disagrees with it;
//   * leave a TIP row with ZERO streams alone (nothing to derive from);
//   * leave a TIP row with TWO disagreeing streams alone (ambiguous);
//   * leave a TIP row that already agrees with its stream alone;
//   * be idempotent — a second run changes nothing.
//
// Runs the SQL file directly (CI builds with drizzle-kit push, so the runner
// stamps 139 applied without running it — see the file's NOT PROBED note).
//
// ⚠️ ONE sql.begin() THAT ALWAYS ROLLS BACK: the migration is not scoped to this
// test's fixtures, and the database is shared. Rollback is forced by throwing a
// sentinel — postgres.js COMMITS a callback that returns normally. Bind
// parameters are explicitly cast (42P18 in CI otherwise; see the 117 test).
//
// Fixtures use the asset kinds (principle/requirement/decision/...), which
// `streams_kind_tenant_check` admits on any tenant; workflow/prompt/procedure
// are pinned to the reserved system tenants and would collide with real rows.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';

const MIGRATION = readFileSync(
  join(import.meta.dir, '../../../migrations/139_repoint_tip_to_stream_project.sql'),
  'utf8',
);

const TAG = `mig139-${process.pid}-${Date.now()}`;
const TENANT = '00000000-0000-4000-8000-0000139b0001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000139b0002';

class Rollback extends Error {}

type Tx = postgres.TransactionSql<Record<string, never>>;

async function seedTip(tx: Tx, tenant: string, kind: string, project: string): Promise<void> {
  await tx.unsafe(
    `INSERT INTO tenant_improvement_projects (tenant_id, kind, planka_project_id)
     VALUES ($1::uuid, $2::text::stream_kind, $3::text)`,
    [tenant, kind, project],
  );
}

async function seedStream(
  tx: Tx,
  tenant: string,
  kind: string,
  project: string,
  n: number,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO streams (tenant_id, kind, name, slug, planka_project_id, planka_board_id)
     VALUES ($1::uuid, $2::text::stream_kind, $3::text, $3::text, $4::text, $5::text)`,
    [tenant, kind, `${TAG}-${kind}-${n}`, project, `board-${TAG}-${kind}-${n}`],
  );
}

async function tip(tx: Tx, tenant: string, kind: string): Promise<string | undefined> {
  const rows = (await tx.unsafe(
    `SELECT planka_project_id FROM tenant_improvement_projects
      WHERE tenant_id = $1::uuid AND kind = $2::text::stream_kind`,
    [tenant, kind],
  )) as unknown as { planka_project_id: string }[];
  return rows[0]?.planka_project_id;
}

test('migration 139 repoints only TIP rows with exactly one disagreeing stream, idempotently', async () => {
  let failure: unknown;
  try {
    await sql.begin(async (tx) => {
      // One stream, disagrees → the target.
      await seedTip(tx, TENANT, 'principle', 'X-dead');
      await seedStream(tx, TENANT, 'principle', 'Y-live', 1);

      // Zero streams → untouched.
      await seedTip(tx, TENANT, 'requirement', 'X-no-stream');

      // Two streams, both disagreeing → ambiguous, untouched.
      await seedTip(tx, TENANT, 'decision', 'X-ambiguous');
      await seedStream(tx, TENANT, 'decision', 'Y-one', 1);
      await seedStream(tx, TENANT, 'decision', 'Y-two', 2);

      // One stream that already agrees → untouched. Same kind as the target
      // on a different tenant, so the join must key on tenant as well as kind.
      await seedTip(tx, OTHER_TENANT, 'principle', 'Z-agrees');
      await seedStream(tx, OTHER_TENANT, 'principle', 'Z-agrees', 1);

      // Positive control: the target starts disagreeing.
      expect(await tip(tx, TENANT, 'principle')).toBe('X-dead');

      await tx.unsafe(MIGRATION);

      expect(await tip(tx, TENANT, 'principle')).toBe('Y-live');
      expect(await tip(tx, TENANT, 'requirement')).toBe('X-no-stream');
      expect(await tip(tx, TENANT, 'decision')).toBe('X-ambiguous');
      expect(await tip(tx, OTHER_TENANT, 'principle')).toBe('Z-agrees');

      // Idempotent: a second run is a no-op on every row.
      const before = (await tx.unsafe(
        `SELECT tenant_id::text, kind::text, planka_project_id
           FROM tenant_improvement_projects
          WHERE tenant_id IN ($1::uuid, $2::uuid) ORDER BY 1, 2`,
        [TENANT, OTHER_TENANT],
      )) as unknown as object[];
      await tx.unsafe(MIGRATION);
      const after = (await tx.unsafe(
        `SELECT tenant_id::text, kind::text, planka_project_id
           FROM tenant_improvement_projects
          WHERE tenant_id IN ($1::uuid, $2::uuid) ORDER BY 1, 2`,
        [TENANT, OTHER_TENANT],
      )) as unknown as object[];
      expect(after).toEqual(before);
      expect(before.length).toBe(4);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) failure = err;
  }
  if (failure) throw failure;
});
