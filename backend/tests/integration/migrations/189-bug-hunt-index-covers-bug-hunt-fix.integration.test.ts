// tests/integration/migrations/189-bug-hunt-index-covers-bug-hunt-fix.integration.test.ts
//
// EXECUTES migration 189 against a real Postgres (CI otherwise only stamps it over a
// push-built schema — see 165-170-project-start-ddl.integration.test.ts for why) and
// proves, on a database carrying 173's `project_type = 'it'` index:
//   - the registered runner probe reads FALSE there (so 189 stays pending / re-applies);
//   - the file applies and re-runs idempotently (executed TWICE);
//   - the resulting indexdef EQUALS the push-built (schema.ts) one, and the probe is TRUE;
//   - the index now refuses a second live `bug_hunt_fix` hunt on the same (tenant, repo),
//     still refuses a second legacy `it` hunt, and still ignores a non-hunt type's flag.
//
// Every case runs inside ONE sql.begin() that is ALWAYS rolled back (124/127/133/165
// discipline): the DDL takes locks on `projects` that ROLLBACK releases; nothing commits.

import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('189-bug-hunt-index-covers-bug-hunt-fix');

class Rollback extends Error {}

const INDEX = 'projects_one_live_bug_hunt_per_repo_idx';
const FILE = '189_bug_hunt_index_covers_bug_hunt_fix.sql';
const OWNER = '0195f48b-1189-7000-8000-00000001c189';
const TENANT = '0195f48b-1189-7000-8000-00000002c189';
const REPO = `https://github.com/nonagenticai/mig189-fixture-${process.pid}-${Date.now()}`;

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

function readMigration(file: string): string {
  return readFileSync(join(import.meta.dir, '../../../migrations', file), 'utf8');
}

async function indexDef(tx: postgres.Sql): Promise<string | null> {
  const rows = (await tx.unsafe(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${INDEX}'`,
  )) as unknown as { indexdef: string }[];
  return rows[0]?.indexdef ?? null;
}

let seq = 0;
async function insertHunt(
  tx: postgres.Sql,
  projectType: string,
  repo: string,
  bugHunt = true,
): Promise<void> {
  seq += 1;
  const data = JSON.stringify({ keycloak_tenant_id: TENANT, it_flow: 'bug', bug_hunt: bugHunt });
  await tx.unsafe(
    `INSERT INTO projects (owner_id, name, repository_url, status, project_type, project_data)
     VALUES ($1, $2, $3, 'active', $4, $5::jsonb)`,
    [OWNER, `mig189 hunt ${seq}`, repo, projectType, data],
  );
}

/** Insert inside a SAVEPOINT; return the SQLSTATE + constraint on failure, null on success. */
async function tryInsertHunt(
  tx: postgres.Sql,
  projectType: string,
  repo: string,
  bugHunt = true,
): Promise<{ code: string; constraint: string | undefined } | null> {
  try {
    await (tx as unknown as postgres.TransactionSql).savepoint(async (sp) => {
      await insertHunt(sp as unknown as postgres.Sql, projectType, repo, bugHunt);
    });
    return null;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return { code: e.code ?? 'unknown', constraint: e.constraint_name };
  }
}

describe('migration 189 — the one-live-hunt index covers RM bug_hunt_fix (+ legacy it)', () => {
  itDb(`${FILE}: 173 shape → probe FALSE → execute ×2 → indexdef equals schema.ts, probe TRUE, refuses duplicates`, async () => {
    const probe = probeForMigration(FILE);
    expect(probe).toBeDefined();
    await rolledBack(async (tx) => {
      const pushDef = await indexDef(tx);
      expect(pushDef).not.toBeNull();
      expect(pushDef).toContain("'bug_hunt_fix'");
      expect(await probe!(tx)).toBe(true);

      // Put the database back on 173's predicate (project_type = 'it' only).
      await tx.unsafe(readMigration('173_project_delivered.sql'));
      const oldDef = await indexDef(tx);
      expect(oldDef).not.toContain("'bug_hunt_fix'");
      expect(await probe!(tx)).toBe(false);

      // Seed a live bug_hunt_fix hunt and a live legacy it hunt (separate repos) so the
      // file must build over existing hunt rows; 189 must then refuse a 2nd of each.
      await insertHunt(tx, 'bug_hunt_fix', `${REPO}-fix`);
      await insertHunt(tx, 'it', `${REPO}-legacy`);

      const body = readMigration(FILE);
      await tx.unsafe(body);
      await tx.unsafe(body); // idempotent replay (reapplyIfProbeFails / by-hand)

      // 190 later adds `repository_url IS NOT NULL` (schema.ts carries it), so 189's
      // own definition is the push one minus that clause — compared as such.
      expect(await indexDef(tx)).toBe(pushDef!.replace('WHERE ((repository_url IS NOT NULL) AND ', 'WHERE ('));
      expect(await probe!(tx)).toBe(true);

      const dupFix = await tryInsertHunt(tx, 'bug_hunt_fix', `${REPO}-fix`);
      expect(dupFix).toEqual({ code: '23505', constraint: INDEX });
      const dupLegacy = await tryInsertHunt(tx, 'it', `${REPO}-legacy`);
      expect(dupLegacy).toEqual({ code: '23505', constraint: INDEX });
      // Control: a non-hunt type is outside the predicate even with a stray flag.
      expect(await tryInsertHunt(tx, 'feature_new', `${REPO}-fix`)).toBeNull();
      // Control: a bug_hunt_fix row WITHOUT the flag is outside the predicate.
      expect(await tryInsertHunt(tx, 'bug_hunt_fix', `${REPO}-fix`, false)).toBeNull();
    });
  });
});
