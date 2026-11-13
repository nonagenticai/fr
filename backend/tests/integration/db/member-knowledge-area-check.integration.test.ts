// tests/integration/db/member-knowledge-area-check.integration.test.ts
//
// The DB-backed half of migration 187 (text half:
// tests/unit/db/member-knowledge-area-check.test.ts). Knowledge areas are the
// tenant's RM capabilities, so `member_knowledge_areas.area` holds any
// capability name:
//   * on CI's push-built database an RM-only area (e.g. v3 `bdd_tdd`) is storable;
//   * 187 EXECUTED drops a planted 135-style CHECK, twice (idempotent), and its
//     runner probe reads FALSE while it exists and TRUE after.
// The DDL case runs inside a transaction that is ALWAYS rolled back.

import { afterEach, describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('member-knowledge-area-check');

const TENANT = '0195f48b-1187-7000-8000-00000000c187';

afterEach(async () => {
  await queryClient`DELETE FROM member_knowledge_areas WHERE tenant_id = ${TENANT}::uuid`;
});

async function count(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conrelid = 'member_knowledge_areas'::regclass
       AND conname = 'member_knowledge_areas_area_check'
  `;
  return rows[0]!.n;
}

describe('no knowledge-area vocabulary CHECK (migration 187)', () => {
  itDb('an RM-only capability name is storable as an area (no 23514)', async () => {
    await queryClient`
      INSERT INTO member_knowledge_areas (tenant_id, user_id, area)
      VALUES (${TENANT}::uuid, 'u-187', 'bdd_tdd'), (${TENANT}::uuid, 'u-187', 'requirements_management')
    `;
    const rows = await queryClient`SELECT area FROM member_knowledge_areas WHERE tenant_id = ${TENANT}::uuid ORDER BY area`;
    expect(rows.map((r) => r.area)).toEqual(['bdd_tdd', 'requirements_management']);
  });

  itDb('the push-built database holds no area CHECK', async () => {
    expect(await count(queryClient as unknown as postgres.Sql)).toBe(0);
  });
});

class Rollback extends Error {}

describe('187 EXECUTED drops the CHECK; its probe reads FALSE → TRUE', () => {
  itDb('plant the CHECK → probe FALSE → run 187 twice → gone, probe TRUE', async () => {
    const probe = probeForMigration('187_drop_member_knowledge_area_check.sql');
    expect(typeof probe).toBe('function');
    const body = readFileSync(
      join(import.meta.dir, '../../../migrations', '187_drop_member_knowledge_area_check.sql'),
      'utf8',
    );
    try {
      await queryClient.begin(async (tx) => {
        const t = tx as unknown as postgres.Sql;
        await t.unsafe(
          "ALTER TABLE member_knowledge_areas ADD CONSTRAINT member_knowledge_areas_area_check " +
            "CHECK (area IN ('development', 'testing')) NOT VALID",
        );
        expect(await count(t)).toBe(1);
        expect(await probe!(t)).toBe(false);
        await t.unsafe(body);
        await t.unsafe(body);
        expect(await count(t)).toBe(0);
        expect(await probe!(t)).toBe(true);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
