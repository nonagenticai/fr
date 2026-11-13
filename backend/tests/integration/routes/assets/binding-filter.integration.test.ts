// tests/integration/routes/assets/binding-filter.integration.test.ts
//
// Plan: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase C)

import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';

import { applyBindingFilter } from '../../../../src/routes/assets/_lib/binding-filter';
import {
  db,
  queryClient,
  assetBindings,
  workspaces,
} from '../../../../src/db/client';
import { ensureWorkspace } from '../../../../src/services/workspaces';
import { eq, inArray } from 'drizzle-orm';

import { createDbSuite } from '../../helpers/db-suite';

const { itDb } = createDbSuite('binding-filter');

const W = 'a1000033-7000-7000-8000-000000000033';
const PROJ_A = '99999933-7000-7000-8000-000000000033';
const PROJ_B = '99999934-7000-7000-8000-000000000034';
const OWNER = '00000000-0000-0000-0000-000000000033';

const REQ_BOUND_A = '33333333-7333-7333-8333-333333333301';
const REQ_BOUND_B = '33333333-7333-7333-8333-333333333302';
const REQ_BOTH = '33333333-7333-7333-8333-333333333303';
const REQ_UNBOUND = '33333333-7333-7333-8333-333333333304';

const ALL_IDS = [REQ_BOUND_A, REQ_BOUND_B, REQ_BOTH, REQ_UNBOUND];

let reachable = false;

beforeAll(async () => {
  try {
    await db.select().from(workspaces).limit(0);
    reachable = true;
  } catch (err) {
    console.warn(
      '[binding-filter.integration] postgres unreachable — skipping:',
      (err as Error).message,
    );
  }
});

async function cleanup(): Promise<void> {
  if (!reachable) return;
  await db
    .delete(assetBindings)
    .where(inArray(assetBindings.asset_id, ALL_IDS));
  await queryClient`DELETE FROM projects WHERE id IN (${PROJ_A}, ${PROJ_B})`;
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
}

beforeEach(async () => {
  if (!reachable) return;
  await cleanup();
  await ensureWorkspace(W, 'binding-filter-test-ws');
  await queryClient`
    INSERT INTO projects (id, name, owner_id, repository_url)
    VALUES
      (${PROJ_A}, 'pA', ${OWNER}, 'https://example.invalid/a'),
      (${PROJ_B}, 'pB', ${OWNER}, 'https://example.invalid/b')
    ON CONFLICT DO NOTHING
  `;
  await db.insert(assetBindings).values([
    { asset_kind: 'requirement', asset_id: REQ_BOUND_A, project_id: PROJ_A, bound_by_user_id: OWNER },
    { asset_kind: 'requirement', asset_id: REQ_BOUND_B, project_id: PROJ_B, bound_by_user_id: OWNER },
    { asset_kind: 'requirement', asset_id: REQ_BOTH, project_id: PROJ_A, bound_by_user_id: OWNER },
    { asset_kind: 'requirement', asset_id: REQ_BOTH, project_id: PROJ_B, bound_by_user_id: OWNER },
  ]);
});

afterEach(async () => {
  if (!reachable) return;
  await cleanup();
});

const items = ALL_IDS.map((id) => ({ id }));

itDb('no filter returns input unchanged', async () => {
  const out = await applyBindingFilter('requirement', items, {});
  expect(out.map((i) => i.id)).toEqual(ALL_IDS);
});

itDb('bound_to=A returns only assets bound to A', async () => {
  const out = await applyBindingFilter('requirement', items, { bound_to: PROJ_A });
  expect(new Set(out.map((i) => i.id))).toEqual(
    new Set([REQ_BOUND_A, REQ_BOTH]),
  );
});

itDb('bound_to=B returns only assets bound to B', async () => {
  const out = await applyBindingFilter('requirement', items, { bound_to: PROJ_B });
  expect(new Set(out.map((i) => i.id))).toEqual(
    new Set([REQ_BOUND_B, REQ_BOTH]),
  );
});

itDb('visible_in=A returns bound-to-A plus tenant-wide-unbound', async () => {
  const out = await applyBindingFilter('requirement', items, {
    visible_in: PROJ_A,
  });
  expect(new Set(out.map((i) => i.id))).toEqual(
    new Set([REQ_BOUND_A, REQ_BOTH, REQ_UNBOUND]),
  );
});

itDb('visible_in excludes assets bound to a different project only', async () => {
  const out = await applyBindingFilter('requirement', items, {
    visible_in: PROJ_A,
  });
  expect(out.map((i) => i.id)).not.toContain(REQ_BOUND_B);
});

itDb('empty input returns empty', async () => {
  const out = await applyBindingFilter('requirement', [], { bound_to: PROJ_A });
  expect(out).toEqual([]);
});
