// tests/unit/routes/assets/effective-query.test.ts
//
// Foundation Plan 2 §Task 7 — `applyEffectiveFilter` is the seam every
// upstream-aggregated asset-list route uses to honour `?project_id=`.
// Three cases:
//
//   1. No project_id → upstream list passes through unchanged.
//   2. With project_id → first call lazily writes workspace-owns rows for
//      every upstream id; result still contains all upstream rows because
//      no override / block exists yet.
//   3. With project_id and a pre-seeded project block → the blocked id is
//      filtered out of the response.
//
// Test pattern mirrors tests/unit/services/effective-set.test.ts: scoped
// DELETE on the workspace + project UUID, beforeAll warms drizzle, raw
// `INSERT INTO projects` to satisfy the NOT NULL columns the schema adds
// beyond id/dept_id/name.

import { test, expect, beforeAll, beforeEach } from 'bun:test';

import { db, queryClient, workspaces } from '../../../../src/db/client';
import { ensureWorkspace } from '../../../../src/services/workspaces';
import { createDepartment } from '../../../../src/services/departments';
import {
  upsertOwns,
  addBlock,
} from '../../../../src/services/asset-assignments';
import { applyEffectiveFilter } from '../../../../src/routes/assets/_lib/effective-query';

const W = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PROJ = '99999999-1111-2222-3333-444444444444';
const OWNER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeefff';

beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  // Scoped delete in dependency order — projects has a FK to departments
  // that is NOT cascade-on-delete, so we drop the project row first, then
  // let the workspace cascade clean everything else.
  await queryClient`DELETE FROM projects WHERE id = ${PROJ}`;
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'eff-query-ws');
});

async function seedProject(): Promise<string> {
  const dept = await createDepartment(W, { name: 'eng' });
  await queryClient`
    INSERT INTO projects (id, dept_id, name, owner_id, repository_url)
    VALUES (${PROJ}, ${dept.id}, 'p', ${OWNER}, 'https://example.invalid/repo')
    ON CONFLICT DO NOTHING
  `;
  return dept.id;
}

test('without project_id, returns the upstream list unchanged', async () => {
  const upstream = [{ id: A, label: 'first' }, { id: B, label: 'second' }];
  const out = await applyEffectiveFilter(W, 'requirement', upstream, undefined);
  expect(out).toEqual(upstream);

  // Sanity: no rows seeded when projectId absent.
  const rows = await queryClient`
    SELECT count(*)::int AS c FROM asset_assignments
    WHERE workspace_id = ${W}
  `;
  expect(rows[0]?.c).toBe(0);
});

test('with project_id, lazily owns first-seen ids at workspace scope', async () => {
  await seedProject();

  const upstream = [{ id: A }, { id: B }];
  const out = await applyEffectiveFilter(W, 'requirement', upstream, PROJ);

  // No overrides/blocks → both ids remain visible after the lazy seed.
  expect(out.map((x) => x.id).sort()).toEqual([A, B].sort());

  // Workspace-scope `owns` rows now exist for each upstream id.
  const cnt = await queryClient`
    SELECT count(*)::int AS c FROM asset_assignments
    WHERE workspace_id = ${W}
      AND asset_type = 'requirement'
      AND scope_kind = 'workspace'
      AND link_kind = 'owns'
  `;
  expect(cnt[0]?.c).toBe(2);

  // Idempotent: a second call doesn't double-insert (ON CONFLICT DO NOTHING
  // in upsertOwns).
  await applyEffectiveFilter(W, 'requirement', upstream, PROJ);
  const cnt2 = await queryClient`
    SELECT count(*)::int AS c FROM asset_assignments
    WHERE workspace_id = ${W}
      AND asset_type = 'requirement'
      AND scope_kind = 'workspace'
      AND link_kind = 'owns'
  `;
  expect(cnt2[0]?.c).toBe(2);
});

test('with project_id, a project block hides a workspace-owned asset', async () => {
  await seedProject();

  // Pre-seed: A is workspace-owned, then blocked at project scope. B has
  // no rows yet — applyEffectiveFilter will lazy-own it on the call below.
  await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'seed' });
  await addBlock(W, 'requirement', A, {
    scope: 'project',
    target_id: PROJ,
    by: 'seed',
  });

  const upstream = [{ id: A }, { id: B }];
  const out = await applyEffectiveFilter(W, 'requirement', upstream, PROJ);
  expect(out.map((x) => x.id)).toEqual([B]);
});

test('preserves order from the upstream list', async () => {
  await seedProject();

  const upstream = [{ id: B }, { id: A }];
  const out = await applyEffectiveFilter(W, 'requirement', upstream, PROJ);
  expect(out.map((x) => x.id)).toEqual([B, A]);
});

// ── strict tenant separation: the lazy seed records only the caller's rows ──
//
// The seed used to write `owns` for everything the upstream returned, so a
// system-tenant decision in a customer's upstream list became a permanent
// "customer owns <system decision>" row (assigned_by='system-lazy') — measured
// on netcare.

const SYSTEM = '0195f48b-d000-7000-8000-000000000001';
const OTHER = '0195f48b-d000-7000-8000-0000000000aa';
const C = 'dddddddd-dddd-dddd-dddd-ddddddddd00c';

async function ownedIds(): Promise<string[]> {
  const rows = await queryClient<{ asset_id: string }[]>`
    SELECT asset_id FROM asset_assignments
    WHERE workspace_id = ${W} AND link_kind = 'owns'
    ORDER BY asset_id
  `;
  return rows.map((r) => r.asset_id);
}

test('a system-tenant row in a customer tenant\'s upstream list is never recorded as owned, nor returned', async () => {
  await seedProject();
  const upstream = [
    { id: A, tenant_id: W },
    { id: B, tenant_id: SYSTEM },
  ];
  const out = await applyEffectiveFilter(W, 'decision', upstream, PROJ);
  expect(await ownedIds()).toEqual([A]);
  expect(out.map((x) => x.id)).toEqual([A]);
});

test('a row owned by ANOTHER tenant is never recorded as owned by the caller', async () => {
  await seedProject();
  const upstream = [
    { id: A, tenant_id: W },
    { id: C, tenant_id: OTHER },
  ];
  const out = await applyEffectiveFilter(W, 'decision', upstream, PROJ);
  expect(await ownedIds()).toEqual([A]);
  expect(out.map((x) => x.id)).toEqual([A]);
});

test('a system row a pre-fix seed ALREADY owned for a customer is still not returned', async () => {
  await seedProject();
  await upsertOwns(W, 'decision', B, { scope: 'workspace', by: 'system-lazy' });
  const out = await applyEffectiveFilter(
    W,
    'decision',
    [{ id: A, tenant_id: W }, { id: B, tenant_id: SYSTEM }],
    PROJ,
  );
  expect(out.map((x) => x.id)).toEqual([A]);
});

test('rows with no tenant_id keep the old lazy-own behaviour', async () => {
  await seedProject();
  const out = await applyEffectiveFilter(W, 'workflow', [{ id: A }, { id: B }], PROJ);
  expect((await ownedIds()).sort()).toEqual([A, B].sort());
  expect(out.map((x) => x.id)).toEqual([A, B]);
});

// ── platform tenants DO inherit system rows ──
//
// The execution, AA-conveyor and improvement tenants run system procedures and
// see system decisions by design. Refusing ownership of a system-tenant row for
// them made newly inherited system rows vanish from their `?project_id=` lists
// (validator repro: origin/main [A, B] vs the first strict-separation cut [A]).

const EXEC = '0195f48b-d000-7000-8000-000000000003';
const EXEC_PROJ = '99999999-1111-2222-3333-4444444444ee';

test('a PLATFORM tenant (execution) still lazily owns and returns an inherited system-tenant row', async () => {
  // Other files read this shared row by name; create it only if absent and
  // remove it again in that case, so this file leaves the DB as it found it.
  const existed =
    (await queryClient`SELECT 1 FROM workspaces WHERE id = ${EXEC}`).length > 0;
  if (!existed) await ensureWorkspace(EXEC, 'eff-query-exec-ws');
  const dept = await createDepartment(EXEC, { name: 'eff-query-exec-dept' });
  try {
    await queryClient`
      INSERT INTO projects (id, dept_id, name, owner_id, repository_url)
      VALUES (${EXEC_PROJ}, ${dept.id}, 'p-exec', ${OWNER}, 'https://example.invalid/repo-exec')
      ON CONFLICT DO NOTHING
    `;
    const out = await applyEffectiveFilter(
      EXEC,
      'decision',
      [{ id: A, tenant_id: EXEC }, { id: B, tenant_id: SYSTEM }],
      EXEC_PROJ,
    );
    expect(out.map((x) => x.id)).toEqual([A, B]);
    const owned = await queryClient<{ asset_id: string }[]>`
      SELECT asset_id FROM asset_assignments
      WHERE workspace_id = ${EXEC} AND link_kind = 'owns' AND asset_type = 'decision'
        AND asset_id IN (${A}, ${B})
      ORDER BY asset_id
    `;
    expect(owned.map((r) => r.asset_id).sort()).toEqual([A, B].sort());
  } finally {
    await queryClient`
      DELETE FROM asset_assignments
      WHERE workspace_id = ${EXEC} AND asset_id IN (${A}, ${B})
    `;
    await queryClient`DELETE FROM projects WHERE id = ${EXEC_PROJ}`;
    await queryClient`DELETE FROM departments WHERE id = ${dept.id}`;
    if (!existed) await queryClient`DELETE FROM workspaces WHERE id = ${EXEC}`;
  }
});

// ── FR-1: the UNSCOPED branch applies the same strict-separation rule ──
//
// `projectId === undefined` used to `return upstream` verbatim, so the drop
// above held only when a project was named. Direct callers (artifacts,
// channels, kag, kag-documents, triggers, workflows) list without a project.

test('without project_id, a CUSTOMER never receives a system-tenant row (tenant_id marker)', async () => {
  const out = await applyEffectiveFilter(
    W,
    'decision',
    [{ id: A, tenant_id: W }, { id: B, tenant_id: SYSTEM }, { id: C }],
    undefined,
  );
  expect(out.map((x) => x.id)).toEqual([A, C]);
  // Still no writes on the unscoped path.
  expect(await ownedIds()).toEqual([]);
});

test('without project_id, a CUSTOMER never receives an is_system row (artifact_service marker, no tenant_id)', async () => {
  const out = await applyEffectiveFilter(
    W,
    'artifact',
    [{ id: A, is_system: false }, { id: B, is_system: true }],
    undefined,
  );
  expect(out.map((x) => x.id)).toEqual([A]);
});

test('with project_id, an is_system row with no tenant_id is neither owned nor returned for a customer', async () => {
  await seedProject();
  const out = await applyEffectiveFilter(
    W,
    'artifact',
    [{ id: A }, { id: B, is_system: true }],
    PROJ,
  );
  expect(await ownedIds()).toEqual([A]);
  expect(out.map((x) => x.id)).toEqual([A]);
});

test('without project_id, a PLATFORM tenant gets the upstream list unchanged (same array)', async () => {
  const upstream = [{ id: A, tenant_id: EXEC }, { id: B, tenant_id: SYSTEM }, { id: C, is_system: true }];
  const out = await applyEffectiveFilter(EXEC, 'decision', upstream, undefined);
  expect(out).toBe(upstream);
});
