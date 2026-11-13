// tests/unit/services/asset-assignments.test.ts
//
// Foundation Plan 2 — coverage for src/services/asset-assignments.ts. Hits
// the live test postgres; we scrub state in beforeEach. Keeps the tests
// strictly to the service surface (insert / list / remove) — the
// effective-set computation has its own dedicated test file.

import { test, expect, beforeAll, beforeEach } from 'bun:test';
// Use `queryClient` (raw postgres.js tag) for cleanup — pre-warmed by
// tests/setup.ts. The drizzle `db` named export races with bun:test's
// parallel loader on full-suite runs (chained API observed half-linked);
// beforeAll runs one real query through `db` to fully settle it before
// any test executes the service modules.
import { db, queryClient, workspaces } from '../../../src/db/client';
import { ensureWorkspace } from '../../../src/services/workspaces';
import { createDepartment } from '../../../src/services/departments';
import {
  upsertOwns,
  addOverride,
  addBlock,
  listAssignmentsForAsset,
  listAssignmentsByScope,
  removeAssignment,
} from '../../../src/services/asset-assignments';

// Per-file unique workspace UUID — sibling tests/unit/agui/rbac-dept-role.test.ts
// also used 22222222-…; collisions on workspaces_pkey block dropping --isolate.
const W = 'a1000007-0000-0000-0000-000000000007';
// A DIFFERENT workspace id, used only by the cross-workspace delete test. It is
// deliberately NOT provisioned: the point is that removeAssignment's predicate
// must not match, and a workspace id that does not own the row demonstrates that
// whether or not the workspace itself exists. Creating it in beforeEach would
// double this file's per-test setup for the benefit of one assertion — which is
// exactly what timed the hook out at 5s on the CI runner.
const OTHER_W = 'a1000008-0000-0000-0000-000000000008';
const ASSET = '33333333-3333-3333-3333-333333333333';
const USER = 'user-asg';

// Force drizzle `db` to fully link before tests run (parallel-loader race —
// see departments.test.ts for the same beforeAll comment).
beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  // Scoped delete: cascade through this workspace only — the workspace FK
  // chain (workspaces → departments → department_members /
  // asset_assignments) drops everything we created. Avoids stomping rows
  // owned by other test files running in parallel under bun:test.
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'asg-ws');
});

test('upsertOwns at workspace scope creates a single row', async () => {
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  const rows = await listAssignmentsForAsset(W, 'requirement', ASSET);
  expect(rows.length).toBe(1);
  expect(rows[0]?.link_kind).toBe('owns');
  expect(rows[0]?.scope_kind).toBe('workspace');
  expect(rows[0]?.target_id).toBeNull();
});

test('upsertOwns is idempotent at workspace scope', async () => {
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  const rows = await listAssignmentsForAsset(W, 'requirement', ASSET);
  expect(rows.length).toBe(1);
});

test('addOverride requires overrides_id and links to the parent', async () => {
  const dept = await createDepartment(W, { name: 'eng' });
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  const wsRows = await listAssignmentsForAsset(W, 'requirement', ASSET);
  expect(wsRows[0]).toBeDefined();
  const child = '44444444-4444-4444-4444-444444444444';
  await addOverride(W, 'requirement', child, {
    scope: 'department',
    target_id: dept.id,
    overrides_id: wsRows[0]!.id,
    by: USER,
  });
  const all = await listAssignmentsForAsset(W, 'requirement', child);
  expect(all.length).toBe(1);
  expect(all[0]?.link_kind).toBe('override');
  expect(all[0]?.overrides_id).toBe(wsRows[0]!.id);
});

test('addBlock at project scope hides without replacing', async () => {
  const proj = '55555555-5555-5555-5555-555555555555';
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  await addBlock(W, 'requirement', ASSET, {
    scope: 'project',
    target_id: proj,
    by: USER,
  });
  const blocks = (await listAssignmentsForAsset(W, 'requirement', ASSET)).filter(
    (r) => r.link_kind === 'block',
  );
  expect(blocks.length).toBe(1);
  expect(blocks[0]?.target_id).toBe(proj);
});

test('CHECK rejects channel asset at project scope', async () => {
  const proj = '66666666-6666-6666-6666-666666666666';
  await expect(
    upsertOwns(W, 'channel', ASSET, {
      scope: 'project',
      target_id: proj,
      by: USER,
    }),
  ).rejects.toThrow();
});

test('listAssignmentsByScope filters to (workspace, type, scope, target)', async () => {
  const dept = await createDepartment(W, { name: 'eng' });
  // Two assets owned at workspace, one at the dept — the dept query must
  // only return the dept-scoped row.
  const a2 = 'aaaa1111-aaaa-1111-aaaa-aaaaaaaaaaaa';
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  await upsertOwns(W, 'requirement', a2, {
    scope: 'department',
    target_id: dept.id,
    by: USER,
  });
  const ws = await listAssignmentsByScope(W, 'requirement', 'workspace', null);
  const dp = await listAssignmentsByScope(
    W,
    'requirement',
    'department',
    dept.id,
  );
  expect(ws.length).toBe(1);
  expect(ws[0]?.asset_id).toBe(ASSET);
  expect(dp.length).toBe(1);
  expect(dp[0]?.asset_id).toBe(a2);
});

test('removeAssignment deletes by id', async () => {
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  const [row] = await listAssignmentsForAsset(W, 'requirement', ASSET);
  expect(row).toBeDefined();
  await removeAssignment(W, row!.id);
  expect((await listAssignmentsForAsset(W, 'requirement', ASSET)).length).toBe(0);
});

test("removeAssignment does not delete another workspace's row", async () => {
  // The row belongs to W; OTHER_W must not be able to erase it by id alone.
  await upsertOwns(W, 'requirement', ASSET, { scope: 'workspace', by: USER });
  const [row] = await listAssignmentsForAsset(W, 'requirement', ASSET);
  expect(row).toBeDefined();
  expect(row!.workspace_id).toBe(W);

  await removeAssignment(OTHER_W, row!.id);

  const after = await listAssignmentsForAsset(W, 'requirement', ASSET);
  expect(after.length).toBe(1);
  expect(after[0]?.id).toBe(row!.id);
});
