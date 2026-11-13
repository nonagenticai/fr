// tests/integration/migrations/190-project-repository-url-optional.integration.test.ts
//
// EXECUTES migration 190 against a real Postgres (CI otherwise only stamps it over a
// push-built schema) and proves, on a table carrying 189's shape (repository_url
// NOT NULL + the hunt index without the IS NOT NULL clause):
//   - the registered runner probe reads FALSE there (so 190 stays pending / re-applies);
//   - the file applies and re-runs idempotently (executed TWICE);
//   - the column is nullable, the indexdef EQUALS the push-built (schema.ts) one, and
//     the probe is TRUE;
//   - a project with NO repository inserts; two repo-less live hunts in one tenant do
//     not collide (no repo ⇒ the one-live-hunt rule does not apply); a second live
//     hunt on the SAME repo is still refused.
//
// ⛔ NEVER DDL ON THE SHARED public.projects. This file used to `ALTER TABLE projects
// ALTER COLUMN repository_url SET NOT NULL` on the real table (inside a rolled-back
// transaction) to rebuild 189's shape. That statement scans every row, so it went
// red whenever ANY sibling test had left a repo-less project behind — and it took an
// ACCESS EXCLUSIVE lock on the table every other suite uses. Now:
//   - public.projects is only READ (catalog + the registered probe, unmodified);
//   - 189's shape is rebuilt on a SCRATCH copy, `<scratch schema>.projects`
//     (`LIKE public.projects INCLUDING ALL EXCLUDING INDEXES`, so it carries the
//     real columns/defaults/CHECKs but none of the real rows), with `search_path`
//     pinned to that schema so the migration files' unqualified `projects` and
//     index names resolve there and never fall through to public;
//   - the REGISTERED probe is run against the scratch schema by retargeting its
//     `'public'` schema literal (retargetedProbe — it fails the test if the probe
//     text no longer contains that literal, so it can never silently read public).
// Everything still runs inside ONE sql.begin() that is ALWAYS rolled back, so the
// scratch schema never commits.
//
// Why it still fails if 190 is reverted: the post-execution assertions read the
// scratch table's catalog (is_nullable, indexdef) and the registered probe; a body
// without `DROP NOT NULL` leaves is_nullable = 'NO' and the probe FALSE — the
// third case executes exactly that mutated body to prove the assertions discriminate.
// A schema.ts revert flips the read-only public assertions (nullable / indexdef).

import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('190-project-repository-url-optional');

class Rollback extends Error {}

const INDEX = 'projects_one_live_bug_hunt_per_repo_idx';
const FILE = '190_project_repository_url_optional.sql';
const OWNER = '0195f48b-1190-7000-8000-00000001c190';
const TENANT = '0195f48b-1190-7000-8000-00000002c190';
const REPO = `https://github.com/nonagenticai/mig190-fixture-${process.pid}-${Date.now()}`;

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

let schemaSeq = 0;
/**
 * Create `<schema>.projects` as an EMPTY structural copy of public.projects and pin
 * `search_path` to it (SET LOCAL — dies with the rolled-back transaction).
 * EXCLUDING INDEXES: the copied hunt index would carry a generated name and shadow
 * the one the migrations (re)create; no other index matters to this file.
 */
async function scratchProjects(tx: postgres.Sql): Promise<string> {
  schemaSeq += 1;
  const schema = `mig190_scratch_${process.pid}_${schemaSeq}`;
  await tx.unsafe(`CREATE SCHEMA ${schema}`);
  await tx.unsafe(`CREATE TABLE ${schema}.projects (LIKE public.projects INCLUDING ALL EXCLUDING INDEXES)`);
  await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
  const rows = (await tx.unsafe(`SELECT count(*)::int AS n FROM ${schema}.projects`)) as unknown as { n: number }[];
  expect(rows[0]?.n).toBe(0);
  return schema;
}

/**
 * The REGISTERED probe, run against `schema` instead of public. The probe is a
 * tagged-template function over `sql`; we hand it a tag that rewrites its
 * `'public'` schema literals and executes the result on `tx`. Throws if no literal
 * was rewritten — a probe that stopped naming 'public' must not be read silently.
 */
function retargetedProbe(tx: postgres.Sql, schema: string): () => Promise<boolean> {
  const probe = probeForMigration(FILE);
  if (!probe) throw new Error(`no probe registered for ${FILE}`);
  return async () => {
    let rewrites = 0;
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (values.length > 0) throw new Error('retargetedProbe: probe interpolates values; extend the shim');
      const text = strings.join('').replace(/'public'/g, () => {
        rewrites += 1;
        return `'${schema}'`;
      });
      return tx.unsafe(text);
    };
    const result = await probe(tag as unknown as postgres.Sql);
    if (rewrites === 0) throw new Error("retargetedProbe: probe SQL no longer names 'public'; cannot retarget");
    return result;
  };
}

async function indexDef(tx: postgres.Sql, schema = 'public'): Promise<string | null> {
  const rows = (await tx.unsafe(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = '${schema}' AND indexname = '${INDEX}'`,
  )) as unknown as { indexdef: string }[];
  return rows[0]?.indexdef ?? null;
}

let seq = 0;
async function insertHunt(
  tx: postgres.Sql,
  projectType: string,
  repo: string | null,
  bugHunt = true,
): Promise<void> {
  seq += 1;
  const data = JSON.stringify({ keycloak_tenant_id: TENANT, it_flow: 'bug', bug_hunt: bugHunt });
  await tx.unsafe(
    `INSERT INTO projects (owner_id, name, repository_url, status, project_type, project_data)
     VALUES ($1, $2, $3, 'active', $4, $5::jsonb)`,
    [OWNER, `mig190 hunt ${seq}`, repo, projectType, data],
  );
}

/** Insert inside a SAVEPOINT; return the SQLSTATE + constraint on failure, null on success. */
async function tryInsertHunt(
  tx: postgres.Sql,
  projectType: string,
  repo: string | null,
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

async function repoNullable(tx: postgres.Sql, schema = 'public'): Promise<string | null> {
  const rows = (await tx.unsafe(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = 'projects' AND column_name = 'repository_url'`,
  )) as unknown as { is_nullable: string }[];
  return rows[0]?.is_nullable ?? null;
}

describe('migration 190 — projects.repository_url optional; hunt index skips repo-less rows', () => {
  itDb(`${FILE}: 189 shape → probe FALSE → execute ×2 → nullable + indexdef equals schema.ts, probe TRUE`, async () => {
    const probe = probeForMigration(FILE);
    expect(probe).toBeDefined();
    await rolledBack(async (tx) => {
      // READ-ONLY on the shared table: push-built (schema.ts) shape + real probe TRUE.
      const pushDef = await indexDef(tx);
      expect(pushDef).toContain('repository_url IS NOT NULL');
      expect(await repoNullable(tx)).toBe('YES');
      expect(await probe!(tx)).toBe(true);

      // 189's shape on the scratch copy: NOT NULL column + 189's index.
      const schema = await scratchProjects(tx);
      const scratchProbe = retargetedProbe(tx, schema);
      await tx.unsafe(`ALTER TABLE projects ALTER COLUMN repository_url SET NOT NULL`);
      await tx.unsafe(readMigration('189_bug_hunt_index_covers_bug_hunt_fix.sql'));
      expect(await repoNullable(tx, schema)).toBe('NO');
      const def189 = await indexDef(tx, schema);
      expect(def189).not.toBeNull();
      expect(def189).not.toContain('repository_url IS NOT NULL');
      expect(await scratchProbe()).toBe(false);
      // …and the shared table was not touched by any of it.
      expect(await indexDef(tx)).toBe(pushDef);
      expect(await repoNullable(tx)).toBe('YES');

      const body = readMigration(FILE);
      await insertHunt(tx, 'bug_hunt_fix', `${REPO}-a`);
      await tx.unsafe(body);
      await tx.unsafe(body); // idempotent replay (reapplyIfProbeFails / by-hand)

      expect(await repoNullable(tx, schema)).toBe('YES');
      expect(await indexDef(tx, schema)).toBe(pushDef!.replace(' ON public.projects ', ` ON ${schema}.projects `));
      expect(await scratchProbe()).toBe(true);
      expect(await indexDef(tx)).toBe(pushDef);

      // A project with NO repository inserts …
      expect(await tryInsertHunt(tx, 'feature_new', null, false)).toBeNull();
      // … two repo-less live hunts do not collide (the guard does not apply) …
      expect(await tryInsertHunt(tx, 'bug_hunt_fix', null)).toBeNull();
      expect(await tryInsertHunt(tx, 'bug_hunt_fix', null)).toBeNull();
      // … and a second live hunt on the SAME repo is still refused.
      expect(await tryInsertHunt(tx, 'bug_hunt_fix', `${REPO}-a`)).toEqual({ code: '23505', constraint: INDEX });
    });
  });

  itDb(`${FILE}: the column half alone reverted ⇒ probe FALSE`, async () => {
    await rolledBack(async (tx) => {
      const schema = await scratchProjects(tx);
      const scratchProbe = retargetedProbe(tx, schema);
      await tx.unsafe(readMigration(FILE));
      expect(await scratchProbe()).toBe(true); // control: fully applied reads TRUE
      await tx.unsafe(`ALTER TABLE projects ALTER COLUMN repository_url SET NOT NULL`);
      expect(await indexDef(tx, schema)).toContain('repository_url IS NOT NULL');
      expect(await scratchProbe()).toBe(false);
    });
  });

  itDb(`${FILE}: mutation control — a body without DROP NOT NULL leaves the column NOT NULL and the probe FALSE`, async () => {
    const body = readMigration(FILE);
    const mutated = body.replace(/^ALTER TABLE projects ALTER COLUMN repository_url DROP NOT NULL;$/m, '');
    expect(mutated).not.toBe(body);
    await rolledBack(async (tx) => {
      const schema = await scratchProjects(tx);
      const scratchProbe = retargetedProbe(tx, schema);
      await tx.unsafe(`ALTER TABLE projects ALTER COLUMN repository_url SET NOT NULL`);
      await tx.unsafe(mutated);
      expect(await repoNullable(tx, schema)).toBe('NO');
      expect(await scratchProbe()).toBe(false);
    });
  });
});
