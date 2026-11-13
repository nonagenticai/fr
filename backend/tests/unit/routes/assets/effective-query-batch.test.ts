// tests/unit/routes/assets/effective-query-batch.test.ts
//
// The lazy-own seed on the `?project_id=` read path (batched upsertOwnsMany)
// against the real Postgres: semantics, idempotence, empty input, chunk size.

import { test, expect, beforeAll, beforeEach } from 'bun:test';

import { db, queryClient, workspaces } from '../../../../src/db/client';
import { ensureWorkspace } from '../../../../src/services/workspaces';
import { createDepartment } from '../../../../src/services/departments';
import {
  upsertOwnsMany,
  UPSERT_OWNS_MANY_CHUNK_SIZE,
} from '../../../../src/services/asset-assignments';
import { applyEffectiveFilter } from '../../../../src/routes/assets/_lib/effective-query';

const W = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const PROJ = '77777777-0000-4000-8000-777777777777';
const OWNER = '88888888-0000-4000-8000-888888888888';

/** Ids the seed will insert; deliberately more than a handful. */
function upstreamIds(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `wf-${String(i).padStart(4, '0')}`,
  }));
}

beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  await queryClient`DELETE FROM projects WHERE id = ${PROJ}`;
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'eff-query-batch-ws');
  const dept = await createDepartment(W, { name: 'eng' });
  await queryClient`
    INSERT INTO projects (id, dept_id, name, owner_id, repository_url)
    VALUES (${PROJ}, ${dept.id}, 'p', ${OWNER}, 'https://example.invalid/repo')
    ON CONFLICT DO NOTHING
  `;
});

async function ownsRows(): Promise<{ asset_id: string; assigned_by: string; scope_kind: string; target_id: string | null; link_kind: string }[]> {
  return queryClient`
    SELECT asset_id, assigned_by, scope_kind, target_id, link_kind
    FROM asset_assignments
    WHERE workspace_id = ${W} AND asset_type = 'workflow'
    ORDER BY asset_id
  ` as unknown as Promise<
    { asset_id: string; assigned_by: string; scope_kind: string; target_id: string | null; link_kind: string }[]
  >;
}

// ---------------------------------------------------------------------------
// Semantics preserved.
// ---------------------------------------------------------------------------

test('batched rows carry the same scope / by / link_kind as the per-row path', async () => {
  const upstream = upstreamIds(5);
  await applyEffectiveFilter(W, 'workflow', upstream, PROJ);
  const rows = await ownsRows();
  expect(rows.length).toBe(5);
  for (const r of rows) {
    expect(r.scope_kind).toBe('workspace');
    expect(r.target_id).toBeNull();
    expect(r.link_kind).toBe('owns');
    expect(r.assigned_by).toBe('system-lazy');
  }
});

test('numeric upstream ids are still string-coerced into the text column', async () => {
  const out = await applyEffectiveFilter(W, 'workflow', [{ id: 7 }, { id: 8 }], PROJ);
  expect(out.map((x) => x.id)).toEqual([7, 8]);
  expect((await ownsRows()).map((r) => r.asset_id)).toEqual(['7', '8']);
});

test('re-running is idempotent', async () => {
  const upstream = upstreamIds(20);
  await applyEffectiveFilter(W, 'workflow', upstream, PROJ);
  expect((await ownsRows()).length).toBe(20);

  const out = await applyEffectiveFilter(W, 'workflow', upstream, PROJ);
  expect(out.length).toBe(20);
  expect((await ownsRows()).length).toBe(20);
});

test('duplicate ids inside one list do not throw and collapse to one row', async () => {
  const out = await applyEffectiveFilter(
    W,
    'workflow',
    [{ id: 'dup' }, { id: 'dup' }, { id: 'other' }],
    PROJ,
  );
  expect(out.map((x) => x.id)).toEqual(['dup', 'dup', 'other']);
  expect((await ownsRows()).map((r) => r.asset_id)).toEqual(['dup', 'other']);
});

// ---------------------------------------------------------------------------
// Empty case — drizzle's `.values([])` throws, so it must be skipped.
// ---------------------------------------------------------------------------

test('empty upstream does not throw and writes no row', async () => {
  const out = await applyEffectiveFilter(W, 'workflow', [], PROJ);
  expect(out).toEqual([]);
  expect(await ownsRows()).toEqual([]);
});

test('upsertOwnsMany with an empty id list does not throw and writes no row', async () => {
  await upsertOwnsMany(W, 'workflow', [], { scope: 'workspace', by: 'system-lazy' });
  expect(await ownsRows()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Bind-parameter ceiling.
// ---------------------------------------------------------------------------

test('the chunk size stays under Postgres 65535 bind parameters at 8 cols/row', () => {
  expect(UPSERT_OWNS_MANY_CHUNK_SIZE * 8).toBeLessThan(65535);
  // Headroom: still safe if the row grows to 13 bound columns.
  expect(UPSERT_OWNS_MANY_CHUNK_SIZE * 13).toBeLessThan(65535);
});
