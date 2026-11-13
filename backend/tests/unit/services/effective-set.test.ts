// tests/unit/services/effective-set.test.ts
//
// Foundation Plan 2 — coverage for src/services/effective-set.ts. Verifies
// the W → D → P walk against the live test postgres: each test wires the
// project row directly via raw SQL (we don't want to pull in project CRUD
// here — the test only cares about dept_id resolution).
//
// Note on the projects insert: the live `projects` schema has more NOT
// NULL columns than the plan's draft test assumed (owner_id uuid, name
// text, repository_url text). We satisfy them with placeholder values; only
// `id` and `dept_id` matter for the resolver.

import { test, expect, beforeAll, beforeEach } from 'bun:test';
// Use `queryClient` (raw postgres.js tag) for cleanup + project-row
// fixtures — pre-warmed by tests/setup.ts. The drizzle `db` named export
// races with bun:test's parallel loader on full-suite runs (chained API
// observed half-linked); beforeAll runs one real query through `db` to
// fully settle it before any test executes the service modules.
import { db, queryClient, workspaces } from '../../../src/db/client';
import { ensureWorkspace } from '../../../src/services/workspaces';
import { createDepartment } from '../../../src/services/departments';
import {
  upsertOwns,
  addOverride,
  addBlock,
  listAssignmentsForAsset,
} from '../../../src/services/asset-assignments';
import { effectiveAssetIds } from '../../../src/services/effective-set';

const W = '77777777-7777-7777-7777-777777777777';
const PROJ = '88888888-8888-8888-8888-888888888888';
const OWNER = '99999999-aaaa-bbbb-cccc-dddddddddddd';
const A = '99999999-9999-9999-9999-999999999999';
const B = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const C = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Force drizzle `db` to fully link before tests run (parallel-loader race —
// see departments.test.ts for the same beforeAll comment).
beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  // Scoped delete: drop our test project row first (FK projects.dept_id
  // is NOT cascade-on-delete), then cascade everything else through the
  // workspace. Keeps us from stomping rows owned by sibling test files
  // running in parallel under bun:test.
  await queryClient`DELETE FROM projects WHERE id = ${PROJ}`;
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'eff-ws');
});

async function setup() {
  const dept = await createDepartment(W, { name: 'eng' });
  // The live `projects` table has NOT NULL columns beyond id/dept_id/name
  // (owner_id, repository_url). Satisfy them with placeholders — the
  // resolver only reads `dept_id` from this row.
  await queryClient`
    INSERT INTO projects (id, dept_id, name, owner_id, repository_url)
    VALUES (${PROJ}, ${dept.id}, 'p', ${OWNER}, 'https://example.invalid/repo')
    ON CONFLICT DO NOTHING
  `;
  return dept;
}

test('walks W→D→P, merges all owns when nothing blocks/overrides', async () => {
  const dept = await setup();
  await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'u' });
  await upsertOwns(W, 'requirement', B, {
    scope: 'department',
    target_id: dept.id,
    by: 'u',
  });
  await upsertOwns(W, 'requirement', C, {
    scope: 'project',
    target_id: PROJ,
    by: 'u',
  });

  const ids = await effectiveAssetIds(W, 'requirement', { project_id: PROJ });
  expect(new Set(ids.map((x) => x.asset_id))).toEqual(new Set([A, B, C]));
});

test('block at lower level hides higher-level owns', async () => {
  await setup();
  await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'u' });
  await addBlock(W, 'requirement', A, {
    scope: 'project',
    target_id: PROJ,
    by: 'u',
  });

  const ids = await effectiveAssetIds(W, 'requirement', { project_id: PROJ });
  expect(ids.find((x) => x.asset_id === A)).toBeUndefined();
});

test('override at lower level replaces higher-level entry', async () => {
  await setup();
  await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'u' });
  const wsRows = await listAssignmentsForAsset(W, 'requirement', A);
  expect(wsRows[0]).toBeDefined();
  await addOverride(W, 'requirement', B, {
    scope: 'project',
    target_id: PROJ,
    overrides_id: wsRows[0]!.id,
    by: 'u',
  });

  const ids = await effectiveAssetIds(W, 'requirement', { project_id: PROJ });
  // A is shadowed by the override; B replaces it as a project-source row.
  const set = new Set(ids.map((x) => x.asset_id));
  expect(set.has(A)).toBe(false);
  expect(set.has(B)).toBe(true);
});

test('source label tracks where the entry came from', async () => {
  const dept = await setup();
  await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'u' });
  await upsertOwns(W, 'requirement', B, {
    scope: 'department',
    target_id: dept.id,
    by: 'u',
  });
  await upsertOwns(W, 'requirement', C, {
    scope: 'project',
    target_id: PROJ,
    by: 'u',
  });

  const ids = await effectiveAssetIds(W, 'requirement', { project_id: PROJ });
  const map = Object.fromEntries(ids.map((x) => [x.asset_id, x.source]));
  expect(map[A]).toBe('workspace');
  expect(map[B]).toBe('department');
  expect(map[C]).toBe('project');
});

// ---------------------------------------------------------------------------
// A malformed `?project_id=` must THROW, never resolve to an empty set.
//
// ⚠️ MEASURED IN PRODUCTION 2026-09-04. `opts.project_id` is caller-supplied
// (the `?project_id=` query param on the asset-list routes) and lands in a
// `uuid` column, so a non-uuid raised SQLSTATE 22P02 and escaped as a bare 500.
// 5 of the 13 HTTP 500s in a 37-minute pod window came through here, on
// /api/assets/{workflows,requirements,procedures,principles,kag-documents}.
//
// ⚠️ AND THE OBVIOUS FIX WOULD HAVE BEEN WORSE THAN THE DEFECT. The caller
// `routes/assets/_lib/effective-query.ts` does
// `visible = new Set(eff.map(...)); return upstream.filter(...)`, so returning
// `[]` here would answer 200 with an empty asset list — turning a loud outage
// into a confident, silent "you own nothing". It must throw.
// ---------------------------------------------------------------------------
test('a malformed project_id throws a 400 and does NOT resolve to an empty set', async () => {
  let threw: unknown;
  try {
    await effectiveAssetIds(W, 'workflow', { project_id: 'stream:9b9fc446-3fff-4587-be44-68908427ea32' });
  } catch (err) {
    threw = err;
  }

  // The load-bearing half: it threw at all. `[]` here is the silent lie.
  expect(threw).toBeDefined();
  expect((threw as { statusCode?: number }).statusCode).toBe(400);
  expect(Array.isArray(threw)).toBe(false);
});

test('a well-formed project_id is unaffected by the guard', async () => {
  // The control. Without it, "throws on everything" would satisfy the test above.
  const eff = await effectiveAssetIds(W, 'workflow', { project_id: PROJ });
  expect(Array.isArray(eff)).toBe(true);
});
