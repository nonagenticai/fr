// tests/integration/db/project-vocabulary-checks.integration.test.ts
//
// The DB-backed half of migration 185 (the text half is
// tests/unit/db/project-vocabulary-checks.test.ts). `projects.project_phase` and
// `projects.project_type` carry NO vocabulary CHECK any more: both are the
// tenant's requirements_management vocabulary, validated in the app (design:
// fr consumes RM vocabulary, George 2026-10-12).
//
//   * on CI's drizzle-push database (schema.ts) an RM-only name is storable —
//     a push DB that still declared either CHECK would refuse it with 23514;
//   * migration 185 EXECUTED drops both constraints, twice (idempotent), and
//     its runner probe reads FALSE while either exists and TRUE after.
// The DDL case runs inside a transaction that is ALWAYS rolled back.

import { afterEach, describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('project-vocabulary-checks');

// A literal owner unique to this file, so cleanup can never touch other rows.
const OWNER = '0195f48b-1165-7000-8000-00000000c165';

afterEach(async () => {
  await queryClient`DELETE FROM projects WHERE owner_id = ${OWNER}::uuid`;
});

async function insertCode(cols: { project_phase?: string; project_type?: string | null; status?: string }): Promise<string | null> {
  try {
    await queryClient`
      INSERT INTO projects (owner_id, name, repository_url, status, project_phase, project_type)
      VALUES (${OWNER}::uuid, 'vocab-probe', '', ${cols.status ?? 'active'},
              ${cols.project_phase ?? 'request'}, ${cols.project_type ?? null})
    `;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function constraintCount(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conrelid = 'projects'::regclass
       AND conname IN ('projects_project_phase_check', 'projects_project_type_check')
  `;
  return rows[0]!.n;
}

describe('no project_phase / project_type vocabulary CHECK (migration 185)', () => {
  itDb('an RM-only phase and type on a LIVE project are storable (no 23514)', async () => {
    expect(await insertCode({ project_phase: 'scope_v3', project_type: 'bug_hunt_fix', status: 'active' })).toBeNull();
    expect(await insertCode({ project_phase: 'unassigned', project_type: 'feature_new', status: 'submitted' })).toBeNull();
  });

  itDb('the push-built database holds neither constraint', async () => {
    expect(await constraintCount(queryClient as unknown as postgres.Sql)).toBe(0);
  });
});

class Rollback extends Error {}

describe('185 EXECUTED drops both constraints; its probe reads FALSE → TRUE', () => {
  itDb('plant 165 + 166 → probe FALSE → run 185 twice → both gone, probe TRUE', async () => {
    const probe = probeForMigration('185_drop_project_vocabulary_checks.sql');
    expect(typeof probe).toBe('function');
    const read = (f: string) => readFileSync(join(import.meta.dir, '../../../migrations', f), 'utf8');
    try {
      await queryClient.begin(async (tx) => {
        const t = tx as unknown as postgres.Sql;
        // Re-create what prod carries today by EXECUTING the real 165 + 166.
        await t.unsafe(read('165_project_phase_check.sql'));
        await t.unsafe(read('166_project_type_check.sql'));
        expect(await constraintCount(t)).toBe(2);
        expect(await probe!(t)).toBe(false);

        const body = read('185_drop_project_vocabulary_checks.sql');
        await t.unsafe(body);
        await t.unsafe(body); // idempotent replay

        expect(await constraintCount(t)).toBe(0);
        expect(await probe!(t)).toBe(true);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
