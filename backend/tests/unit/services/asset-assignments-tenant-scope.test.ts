// tests/unit/services/asset-assignments-tenant-scope.test.ts
//
// REGRESSION COVER FOR MIGRATION 111 — `asset_assignments`' partial unique
// indexes must be keyed on the TENANT.
//
// THE DEFECT THIS PINS. Migration 030 created:
//
//     asset_assignments_uq_workspace   UNIQUE (asset_type, asset_id, scope_kind)
//                                      WHERE target_id IS NULL
//     asset_assignments_uq_with_target UNIQUE (asset_type, asset_id, scope_kind,
//                                      target_id) WHERE target_id IS NOT NULL
//
// Neither carried `workspace_id`, fr's tenant key — so an assignment row was
// unique GLOBALLY, across every tenant. The sole writer
// (services/asset-assignments.ts) uses a BARE `.onConflictDoNothing()` with no
// `target:`, which fires on ANY unique violation on the table, so the second
// tenant to claim an upstream asset id had its row silently DISCARDED and the
// statement returned success. Upstream ids are process-global (n8n workflow ids,
// procedure_management ids), so in production the first workspace to list an
// asset type claimed the whole catalogue: 2,288 workspace-scope rows over 2,288
// DISTINCT asset_ids, none shared, one tenant holding 259 of 273 workflows.
//
// WHY THESE TESTS CANNOT PASS VACUOUSLY. This file does NOT use the
// DB-reachability skip idiom — the one where a probe sets a `…eachable` flag and every test body
// bails out early when it is false, so a run with no database reports "N pass, 0
// expect() calls". Every test here talks to Postgres unconditionally and asserts
// unconditionally; with no database the file ERRORS rather than reporting a green
// it never earned. It therefore needs NO arming entry in scripts/ci-test.sh's
// `FR_TEST_REQUIRE_DB=1` lane and rides the unarmed `bun test tests/unit/` glob.
// (The guard matches on raw source, comments included, so the literal shape of
// that idiom is deliberately not reproduced in this comment.)
//
// MUTATION-PROVEN. With the OLD (pre-111) index shape restored on a live
// database, `cross-tenant claim` and `batch seed` both go RED — the second
// tenant's row is absent — and `both unique indexes carry workspace_id` goes RED
// on the index definition itself. Measured, not asserted: see the PR body.

import { test, expect, beforeAll, beforeEach } from 'bun:test';
// `queryClient` (raw postgres.js tag) for cleanup + fixtures, pre-warmed by
// tests/setup.ts. The `beforeAll` select forces drizzle's `db` to fully link
// before any test runs — same parallel-loader race the sibling service tests
// document.
import { db, queryClient, workspaces } from '../../../src/db/client';
import { ensureWorkspace } from '../../../src/services/workspaces';
import {
  upsertOwns,
  upsertOwnsMany,
  listAssignmentsForAsset,
} from '../../../src/services/asset-assignments';
import { effectiveAssetIds } from '../../../src/services/effective-set';

// Two DIFFERENT tenants. Per-file unique uuids: sibling unit files provision
// their own workspaces and a collision on workspaces_pkey blocks --isolate=off.
const W1 = 'a1100001-0000-0000-0000-000000000001';
const W2 = 'a1100002-0000-0000-0000-000000000002';

// One project per tenant. `effectiveAssetIds` shape-checks project_id and looks
// up `projects.dept_id`; a workspace-scope `owns` row is emitted whether or not
// the project has a department, so `dept_id` stays NULL here.
const P1 = 'a1100011-0000-0000-0000-000000000011';
const P2 = 'a1100012-0000-0000-0000-000000000012';
const OWNER = 'a1100099-0000-0000-0000-000000000099';

// THE SAME asset id, claimed by both tenants. This is the whole point: upstream
// ids are process-global, so this is the ordinary case in production, not a
// contrived collision. Deliberately NOT uuid-shaped — `asset_assignments.asset_id`
// is `text` (migration 035) and the real n8n workflow ids that triggered this
// defect are opaque strings.
const SHARED = 'n8n-wf-shared-111';
const SHARED_B = 'n8n-wf-shared-111-b';
const SHARED_C = 'n8n-wf-shared-111-c';

// A target_id shared across both tenants, to exercise the OTHER partial index
// (`..._uq_with_target`, WHERE target_id IS NOT NULL). `target_id` carries no FK,
// so this is a pure index-shape assertion: the two rows differ ONLY in
// workspace_id, which is exactly the pair the pre-111 key could not tell apart.
const SHARED_TARGET = 'a1100077-0000-0000-0000-000000000077';

const USER = 'user-111';

beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  // Delete our project rows first (projects.dept_id is ON DELETE SET NULL, not
  // cascade), then cascade the rest through each workspace. Scoped to OUR ids so
  // sibling files running in parallel are untouched.
  await queryClient`DELETE FROM projects WHERE id IN (${P1}, ${P2})`;
  await queryClient`DELETE FROM workspaces WHERE id IN (${W1}, ${W2})`;

  // ⛔ Cross-workspace scrub by asset_id. Under the PRE-111 index this was
  // MANDATORY — a leftover row for these ids under any other workspace_id made
  // our own insert a silent no-op and the test green-but-empty. Post-111 it is
  // merely hygiene against a re-run.
  await queryClient`
    DELETE FROM asset_assignments
    WHERE asset_id IN (${SHARED}, ${SHARED_B}, ${SHARED_C})
  `;

  await ensureWorkspace(W1, 'tenant-scope-ws-1');
  await ensureWorkspace(W2, 'tenant-scope-ws-2');
  await queryClient`
    INSERT INTO projects (id, name, owner_id, repository_url)
    VALUES (${P1}, 'p1', ${OWNER}, 'https://example.invalid/r1'),
           (${P2}, 'p2', ${OWNER}, 'https://example.invalid/r2')
  `;
});

/** Every assignment row for one asset id, across every tenant. */
async function rowsForAsset(assetId: string) {
  return queryClient<
    { workspace_id: string; scope_kind: string; target_id: string | null }[]
  >`
    SELECT workspace_id, scope_kind, target_id
      FROM asset_assignments
     WHERE asset_id = ${assetId}
     ORDER BY workspace_id
  `;
}

// ── THE DECISIVE TEST ────────────────────────────────────────────────────────

test('two tenants claiming the SAME asset id each get their own row', async () => {
  await upsertOwns(W1, 'workflow', SHARED, { scope: 'workspace', by: USER });
  await upsertOwns(W2, 'workflow', SHARED, { scope: 'workspace', by: USER });

  const rows = await rowsForAsset(SHARED);

  // TWO rows, not one. Pre-111 this was 1: W2's insert hit
  // asset_assignments_uq_workspace, `ON CONFLICT DO NOTHING` swallowed it, and
  // the call still resolved successfully.
  expect(rows.length).toBe(2);
  expect(rows.map((r) => r.workspace_id).sort()).toEqual([W1, W2].sort());

  // Neither insert was swallowed: each tenant owns exactly one row.
  expect(rows.filter((r) => r.workspace_id === W1).length).toBe(1);
  expect(rows.filter((r) => r.workspace_id === W2).length).toBe(1);
});

test('both tenants SEE the shared asset through effectiveAssetIds', async () => {
  await upsertOwns(W1, 'workflow', SHARED, { scope: 'workspace', by: USER });
  await upsertOwns(W2, 'workflow', SHARED, { scope: 'workspace', by: USER });

  // `effectiveAssetIds` builds its result ADDITIVELY from rows this tenant owns,
  // so a row the index refused to write is not an error to this reader — it is
  // an absence, and the caller is answered 200 with a short list. Asserting on
  // the resolver (not just the table) is what makes this a user-visible claim.
  const e1 = await effectiveAssetIds(W1, 'workflow', { project_id: P1 });
  const e2 = await effectiveAssetIds(W2, 'workflow', { project_id: P2 });

  expect(e1.map((e) => e.asset_id)).toContain(SHARED);
  expect(e2.map((e) => e.asset_id)).toContain(SHARED);

  // Each tenant reaches it via ITS OWN assignment row, at workspace scope.
  const v1 = e1.find((e) => e.asset_id === SHARED);
  const v2 = e2.find((e) => e.asset_id === SHARED);
  expect(v1?.source).toBe('workspace');
  expect(v2?.source).toBe('workspace');
  expect(v1?.via_assignment_id).not.toBe(v2?.via_assignment_id);
});

test('the batch seed path writes a row per tenant for every shared id', async () => {
  // `upsertOwnsMany` is the path `applyEffectiveFilter` actually takes on every
  // `?project_id=` list request — one multi-row INSERT ... ON CONFLICT DO
  // NOTHING for the whole upstream catalogue. Same bare conflict clause, so it
  // failed the same way.
  const catalogue = [SHARED, SHARED_B, SHARED_C];
  await upsertOwnsMany(W1, 'workflow', catalogue, { scope: 'workspace', by: USER });
  await upsertOwnsMany(W2, 'workflow', catalogue, { scope: 'workspace', by: USER });

  for (const id of catalogue) {
    const rows = await rowsForAsset(id);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([W1, W2].sort());
  }

  // And the whole catalogue is visible to BOTH tenants, not split between them.
  const e1 = (await effectiveAssetIds(W1, 'workflow', { project_id: P1 })).map(
    (e) => e.asset_id,
  );
  const e2 = (await effectiveAssetIds(W2, 'workflow', { project_id: P2 })).map(
    (e) => e.asset_id,
  );
  for (const id of catalogue) {
    expect(e1).toContain(id);
    expect(e2).toContain(id);
  }
});

test('the with_target index is tenant-scoped too', async () => {
  // Exercises `asset_assignments_uq_with_target` (WHERE target_id IS NOT NULL),
  // the index the workspace-scope tests never touch. The two rows differ ONLY in
  // workspace_id — pre-111 the second was discarded.
  await upsertOwns(W1, 'workflow', SHARED, {
    scope: 'project',
    target_id: SHARED_TARGET,
    by: USER,
  });
  await upsertOwns(W2, 'workflow', SHARED, {
    scope: 'project',
    target_id: SHARED_TARGET,
    by: USER,
  });

  const rows = await rowsForAsset(SHARED);
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.target_id === SHARED_TARGET)).toBe(true);
  expect(rows.map((r) => r.workspace_id).sort()).toEqual([W1, W2].sort());
});

test('re-seeding the same tenant is still idempotent', async () => {
  // The loosening must not cost the property the index was there for: WITHIN one
  // tenant the row is still unique, so the lazy re-seed on every list request
  // stays a no-op instead of accumulating duplicates. A fix that dropped the
  // indexes outright would pass every test above and fail this one.
  await upsertOwns(W1, 'workflow', SHARED, { scope: 'workspace', by: USER });
  await upsertOwns(W1, 'workflow', SHARED, { scope: 'workspace', by: USER });
  await upsertOwnsMany(W1, 'workflow', [SHARED, SHARED], {
    scope: 'workspace',
    by: USER,
  });

  const rows = await rowsForAsset(SHARED);
  expect(rows.length).toBe(1);
  expect(rows[0]?.workspace_id).toBe(W1);
});

// ── THE READ SIDE ───────────────────────────────────────────────────────────

test("listAssignmentsForAsset returns ONLY the caller's tenant's rows", async () => {
  // 111 fixed the WRITE side: both tenants now get their own row for the same
  // process-global asset id. That fix is what made the READ side dangerous —
  // before it, a second tenant's row could not exist, so an unscoped
  // `WHERE asset_type = ? AND asset_id = ?` had nothing to leak. Now it does.
  await upsertOwns(W1, 'workflow', SHARED, { scope: 'workspace', by: USER });
  await upsertOwns(W2, 'workflow', SHARED, { scope: 'workspace', by: USER });
  // A second W2 row at a different scope, so the leak — if the predicate is
  // dropped — is a MAJORITY of the result set, not a one-row rounding error.
  await upsertOwns(W2, 'workflow', SHARED, {
    scope: 'project',
    target_id: SHARED_TARGET,
    by: USER,
  });

  // Premise check, NOT the assertion: three rows for this asset id really are
  // in the table, spread over two tenants. Without this the isolation
  // assertion below could pass vacuously on an empty or single-tenant table.
  const all = await rowsForAsset(SHARED);
  expect(all.length).toBe(3);
  expect(new Set(all.map((r) => r.workspace_id))).toEqual(new Set([W1, W2]));

  const mine = await listAssignmentsForAsset(W1, 'workflow', SHARED);

  expect(mine.length).toBe(1);
  expect(mine.every((r) => r.workspace_id === W1)).toBe(true);
  expect(mine.some((r) => r.workspace_id === W2)).toBe(false);

  // And symmetrically, from the other side: W2 sees its two rows and never W1's.
  const theirs = await listAssignmentsForAsset(W2, 'workflow', SHARED);
  expect(theirs.length).toBe(2);
  expect(theirs.every((r) => r.workspace_id === W2)).toBe(true);

  // The two tenants' views are DISJOINT — no assignment id appears in both.
  const mineIds = new Set(mine.map((r) => r.id));
  expect(theirs.some((r) => mineIds.has(r.id))).toBe(false);
});

// ── THE SHAPE GUARD ─────────────────────────────────────────────────────────

test('both partial unique indexes carry workspace_id', async () => {
  // Reads the LIVE index definitions rather than trusting schema.ts. This is the
  // test that fails on the pre-111 shape regardless of what the writer does, so
  // it catches a revert of the migration, a drizzle-kit push from a reverted
  // schema.ts, or a hand-rolled index on a fresh database.
  const defs = await queryClient<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE tablename = 'asset_assignments'
       AND indexname IN ('asset_assignments_uq_workspace',
                         'asset_assignments_uq_with_target')
     ORDER BY indexname
  `;

  expect(defs.length).toBe(2);
  for (const d of defs) {
    expect(d.indexdef).toContain('UNIQUE');
    // `workspace_id` must be a KEY column. Matching the parenthesised key list
    // rather than the whole definition means a future partial predicate
    // mentioning workspace_id could not satisfy this by accident.
    const keys = /\(([^)]*)\)/.exec(d.indexdef)?.[1] ?? '';
    expect(keys.split(',').map((c) => c.trim())).toContain('workspace_id');
  }
});
