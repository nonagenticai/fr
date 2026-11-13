// tests/unit/routes/assets/project-scope-fail-open.test.ts
//
// The `?project_id=` scope filter used to FAIL OPEN. When a free-text
// `project_id` on a requirements/decisions asset did not resolve to a real
// project, BOTH resolvers failed to narrow and the caller got the whole tenant
// labelled as belonging to that project:
//
//   * fr leg — `effective-set.ts` resolves the project's `dept_id`. A missing
//     row gives `dept_id = null`, which empties the department and project
//     buckets but leaves the WORKSPACE bucket intact, and `effective-query.ts`
//     lazily `owns`-seeds every upstream row at workspace scope. Net: the filter
//     returned EVERYTHING.
//   * upstream leg — `listRequirementsParams` declares only `limit`/`offset`
//     (its sibling `listDecisionsParams` declares `project_id`), and the upstream
//     FastAPI silently discards undeclared query params. So for requirements,
//     fr's filter is the ONLY filter, and it was the one failing open.
//
// Live data: ~30% of well-formed `project_id` values resolve to no project
// (353 of 1176 requirements, 215 of 830 decisions).
//
// Each test below names the mutation it kills. A test that cannot fail is worse
// than no test.

import { test, expect, beforeAll, beforeEach } from 'bun:test';

import { db, queryClient, workspaces } from '../../../../src/db/client';
import { ensureWorkspace } from '../../../../src/services/workspaces';
import { createDepartment } from '../../../../src/services/departments';
import { upsertOwns } from '../../../../src/services/asset-assignments';
import { BadRequestError } from '../../../../src/utils/errors';
import {
  applyEffectiveFilter,
  parseProjectIdParam,
  projectExists,
  projectScopeHeaders,
  PROJECT_RESOLVED_HEADER,
} from '../../../../src/routes/assets/_lib/effective-query';

// Fixture ids are unique to THIS file. Sibling unit tests run in parallel under
// bun:test against the same database and clean up by scoped DELETE, so a shared
// workspace/project uuid would let one file truncate another's rows mid-run.
const W = '3a1f0000-0000-4000-8000-000000000001';
const REAL_PROJ = '3a1f0000-0000-4000-8000-000000000002';
// Well-formed uuid that is deliberately absent from `projects`. This is the
// input the whole file is about: it passes the UUID shape-check, so it reaches
// the resolver and used to flood.
const UNKNOWN_PROJ = '3a1f0000-0000-4000-8000-0000000000ff';
// A REAL project row whose `dept_id` IS NULL. Separate from `REAL_PROJ` on
// purpose: `seedRealProject()` gives its project a department, so every
// resolution assertion in this file used to be satisfied by a row with a
// non-null `dept_id` — see the `dept_id = NULL` test below for what that hid.
const NODEPT_PROJ = '3a1f0000-0000-4000-8000-0000000000e0';
const OWNER = '3a1f0000-0000-4000-8000-000000000003';
const A = '3a1f0000-0000-4000-8000-00000000000a';
const B = '3a1f0000-0000-4000-8000-00000000000b';

// Probe Postgres so the suite hard-fails in CI but skip-MARKS on a local dev box
// without a database.
//
// ⛔ `test.skipIf`, never `if (!dbAvailable) return;`. The early-return idiom
// reports the test as a PASS with zero expect() calls — a skip laundered into a
// green tick. A skipped run must READ as skipped.
const dbAvailable: boolean = await (async (): Promise<boolean> => {
  try {
    return await Promise.race([
      queryClient`SELECT 1`.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15000)),
    ]);
  } catch {
    return false;
  }
})();

if (!dbAvailable && process.env.CI === 'true') {
  throw new Error(
    '[project-scope-fail-open] Postgres is not reachable but CI=true — refusing to ' +
      'silently skip the project-scope tests. Start a Postgres container or unset CI.',
  );
}

if (!dbAvailable) {
  console.warn(
    '[project-scope-fail-open] Postgres not reachable — the DB-backed scope tests ' +
      'will be marked SKIP. The pure parse/header tests below still run.',
  );
}

const itDb = (name: string, fn: () => Promise<void>): void => {
  test.skipIf(!dbAvailable)(name, fn);
};

beforeAll(async () => {
  if (!dbAvailable) return;
  // Force drizzle `db` to fully link before tests run (parallel-loader race —
  // same beforeAll as tests/unit/services/effective-set.test.ts).
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Scoped delete in dependency order — `projects.dept_id` FK is not
  // cascade-on-delete, so drop project rows first and let the workspace cascade
  // the rest.
  await queryClient`DELETE FROM projects WHERE id IN (${REAL_PROJ}, ${UNKNOWN_PROJ}, ${NODEPT_PROJ})`;
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'project-scope-ws');
});

/** A real project row, with the NOT NULL columns the live schema requires. */
async function seedRealProject(): Promise<string> {
  const dept = await createDepartment(W, { name: 'eng' });
  await queryClient`
    INSERT INTO projects (id, dept_id, name, owner_id, repository_url)
    VALUES (${REAL_PROJ}, ${dept.id}, 'p', ${OWNER}, 'https://example.invalid/repo')
    ON CONFLICT DO NOTHING
  `;
  return dept.id;
}

/**
 * A real project row with NO department.
 *
 * `seedRealProject()` above cannot stand in for this: it creates a department
 * and points the project at it, so it can never distinguish "this row exists"
 * from "this row has a dept_id". That gap is the whole reason this seeder is
 * separate — see the `dept_id = NULL` test.
 */
async function seedDeptlessProject(): Promise<void> {
  await queryClient`
    INSERT INTO projects (id, dept_id, name, owner_id, repository_url)
    VALUES (${NODEPT_PROJ}, NULL, 'p-nodept', ${OWNER}, 'https://example.invalid/repo')
    ON CONFLICT DO NOTHING
  `;
}

async function ownsRowCount(): Promise<number> {
  const rows = await queryClient<{ c: number }[]>`
    SELECT count(*)::int AS c FROM asset_assignments
    WHERE workspace_id = ${W}
      AND asset_type = 'requirement'
      AND scope_kind = 'workspace'
      AND link_kind = 'owns'
  `;
  return rows[0]?.c ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. The fail-open itself
// ─────────────────────────────────────────────────────────────────────────

itDb(
  'an unknown-but-well-formed project_id does not resolve, even with a workspace owns row seeded',
  async () => {
    // The precondition that made the old code flood: a workspace-scope `owns`
    // row EXISTS for A. Asserted, not assumed — without it the filter would
    // return [] for the boring reason (nothing owned) and this test would pass
    // against the bug.
    await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'seed' });
    expect(await ownsRowCount()).toBe(1);

    // And the project genuinely is not there.
    const present = await queryClient<{ c: number }[]>`
      SELECT count(*)::int AS c FROM projects WHERE id = ${UNKNOWN_PROJ}
    `;
    expect(present[0]?.c).toBe(0);

    // KILLS: hardcoding `projectExists` to `true`, and deleting the
    // `projects` lookup so an unknown id reports as resolved.
    //
    // ⚠️ CORRECTED. This comment used to ALSO claim it killed "reporting
    // resolution from `dept_id != null`". It did not, and could not: that
    // mutation makes `projectExists` STRICTER, so an id that is absent from
    // `projects` still returns false and this assertion still passes. Nothing
    // in this file caught it either, because the only project it seeded
    // (`seedRealProject`) has a department — the former artifacts suite caught it
    // incidentally, from a fixture that happens to lack one. The dedicated
    // case is `a project with dept_id = NULL still RESOLVES` below; that one
    // genuinely kills it.
    expect(await projectExists(UNKNOWN_PROJ)).toBe(false);
  },
);

itDb(
  'an unknown project_id returns the EMPTY set, not the whole workspace',
  async () => {
    await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'seed' });

    const upstream = [{ id: A }, { id: B }];
    const out = await applyEffectiveFilter(W, 'requirement', upstream, UNKNOWN_PROJ);

    // KILLS: restoring the fail-open (deleting the `projectExists` guard, or
    // making its false branch `return upstream`). Under the bug this returned
    // BOTH ids — the entire upstream page — for a project that does not exist.
    expect(out).toEqual([]);
  },
);

itDb('an unknown project_id performs no lazy-seed writes', async () => {
  // The guard runs BEFORE `ensureWorkspace`/`upsertOwnsMany`, so a junk
  // project_id must not write owns rows for every upstream id.
  //
  // KILLS: moving the `projectExists` check below the lazy seed — which would
  // still return [] and pass the test above, while leaving the writes in place.
  expect(await ownsRowCount()).toBe(0);
  await applyEffectiveFilter(W, 'requirement', [{ id: A }, { id: B }], UNKNOWN_PROJ);
  expect(await ownsRowCount()).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Positive control — the feature still works
// ─────────────────────────────────────────────────────────────────────────

itDb(
  'POSITIVE CONTROL: a resolving project_id still returns its narrowed subset',
  async () => {
    // Without this test the "fix" could simply be `return []` for every
    // project_id — every test above would pass and the feature would be dead.
    await seedRealProject();
    expect(await projectExists(REAL_PROJ)).toBe(true);

    const upstream = [{ id: A }, { id: B }];
    const out = await applyEffectiveFilter(W, 'requirement', upstream, REAL_PROJ);

    // A real project with no overrides/blocks sees the workspace set, in
    // upstream order, and the lazy seed ran.
    expect(out.map((r) => r.id)).toEqual([A, B]);
    expect(await ownsRowCount()).toBe(2);

    // KILLS: `return []` unconditionally, and any inversion of the
    // `projectExists` branch.
  },
);

itDb('a project with dept_id = NULL still RESOLVES, and still narrows', async () => {
  // ⛔ THE MUTATION THIS EXISTS FOR: `resolveProject` returning
  // `exists: proj.dept_id !== null` instead of `exists: proj !== null`
  // (services/effective-set.ts). Existence keys on the ROW's presence, never on
  // the truthiness of a column inside it — a department is optional, and an
  // unscoped project is an ordinary, fully valid project.
  //
  // Every other resolution assertion in this file runs against
  // `seedRealProject()`, which creates a department first. Against that fixture
  // the mutation is invisible. Live fixtures without a department exist
  // (tests/integration/routes/assets/cross-link-filters seeds `dept_id` NULL
  // deliberately), so this is the real shape, not a contrived one.
  await seedDeptlessProject();

  // POSITIVE CONTROL for the assertion below: the row is really there AND its
  // dept_id really is NULL. Without it, `projectExists` returning true would be
  // equally consistent with the seeder having quietly attached a department.
  const row = await queryClient<{ dept_id: string | null }[]>`
    SELECT dept_id FROM projects WHERE id = ${NODEPT_PROJ}
  `;
  expect(row.length).toBe(1);
  expect(row[0]?.dept_id).toBeNull();

  expect(await projectExists(NODEPT_PROJ)).toBe(true);

  // And it behaves like a resolving project end-to-end: the lazy seed runs and
  // the workspace bucket comes through in upstream order. (Under the mutation
  // this branch returns [] instead — the empty-set path for a project that does
  // not exist — so the filter assertion is a second, independent kill.)
  const upstream = [{ id: A }, { id: B }];
  const out = await applyEffectiveFilter(W, 'requirement', upstream, NODEPT_PROJ);
  expect(out.map((r) => r.id)).toEqual([A, B]);
  expect(await ownsRowCount()).toBe(2);
});

itDb('POSITIVE CONTROL: an absent project_id is still unfiltered', async () => {
  const upstream = [{ id: A }, { id: B }];
  const out = await applyEffectiveFilter(W, 'requirement', upstream, undefined);

  // KILLS: making the empty-set branch swallow the no-filter case too (e.g.
  // `if (!projectId) return []`), which would blank every library list view.
  expect(out).toEqual(upstream);
  expect(await ownsRowCount()).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. The boundary: '' and a bogus uuid must be DISTINGUISHABLE
// ─────────────────────────────────────────────────────────────────────────

itDb(
  "project_id='' and project_id=<bogus uuid> produce DIFFERENT observable results",
  async () => {
    await upsertOwns(W, 'requirement', A, { scope: 'workspace', by: 'seed' });
    const upstream = [{ id: A }, { id: B }];

    // `''` — present but empty. `URLSearchParams.get` returns '' (not null) for
    // a valueless param, so this is what `?project_id=` actually produces.
    const empty = new URLSearchParams('project_id=');
    expect(() => parseProjectIdParam(empty)).toThrow(BadRequestError);

    // A bogus-but-well-formed uuid: accepted as a value, resolves to nothing,
    // filters to nothing.
    const bogus = new URLSearchParams(`project_id=${UNKNOWN_PROJ}`);
    expect(parseProjectIdParam(bogus)).toBe(UNKNOWN_PROJ);
    const bogusOut = await applyEffectiveFilter(
      W,
      'requirement',
      upstream,
      UNKNOWN_PROJ,
    );
    expect(bogusOut).toEqual([]);

    // KILLS: re-adding the unconditional truthiness short-circuit
    // (`if (!projectId) return upstream`). Under that code BOTH inputs returned
    // the full upstream list — two invalid inputs, one indistinguishable
    // answer. The assertion that separates them is 400-vs-[], so restoring the
    // short-circuit makes the `toThrow` above fail.
    //
    // Pinned explicitly: an absent param is the THIRD state and is NOT an error.
    expect(parseProjectIdParam(new URLSearchParams(''))).toBeUndefined();
  },
);

test("parseProjectIdParam treats a whitespace-only project_id as empty, not as a value", () => {
  // KILLS: `raw === ''` instead of `raw.trim() === ''` — `?project_id=%20`
  // would otherwise be forwarded as a "value" and 400 further down with a
  // misleading "must be a UUID" message.
  expect(() => parseProjectIdParam(new URLSearchParams('project_id=%20'))).toThrow(
    BadRequestError,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 4. The signal reaches the client (no database needed)
// ─────────────────────────────────────────────────────────────────────────

test('projectScopeHeaders reports resolution without disturbing the envelope', () => {
  expect(projectScopeHeaders(false)[PROJECT_RESOLVED_HEADER]).toBe('false');
  expect(projectScopeHeaders(true)[PROJECT_RESOLVED_HEADER]).toBe('true');

  // KILLS: emitting the header when no project_id was supplied — the route must
  // not assert anything about a filter it never applied.
  expect(projectScopeHeaders(undefined)).toEqual({});
  expect(
    projectScopeHeaders(undefined, { 'X-Truncated': 'false' }),
  ).toEqual({ 'X-Truncated': 'false' });
});

test('projectScopeHeaders MERGES Access-Control-Expose-Headers instead of clobbering it', () => {
  // `pageCapHeaders` already publishes two headers and exposes them by name.
  // `jsonResponse` spreads header objects into ONE literal, so a second
  // `Access-Control-Expose-Headers` key would overwrite the first and silently
  // un-expose X-Applied-Limit / X-Truncated to every cross-origin reader.
  const base = {
    'X-Applied-Limit': '200',
    'X-Truncated': 'false',
    'Access-Control-Expose-Headers': 'X-Applied-Limit, X-Truncated',
  };
  const merged = projectScopeHeaders(false, base);
  const exposed = merged['Access-Control-Expose-Headers']!
    .split(',')
    .map((h) => h.trim());

  // KILLS: `{ ...base, 'Access-Control-Expose-Headers': PROJECT_RESOLVED_HEADER }`
  // — a plain overwrite. All three names must survive.
  expect(exposed).toContain('X-Applied-Limit');
  expect(exposed).toContain('X-Truncated');
  expect(exposed).toContain(PROJECT_RESOLVED_HEADER);
  // And the pre-existing headers are untouched.
  expect(merged['X-Applied-Limit']).toBe('200');
  expect(merged['X-Truncated']).toBe('false');

  // Idempotent: merging twice must not duplicate the name.
  const twice = projectScopeHeaders(false, merged);
  const twiceExposed = twice['Access-Control-Expose-Headers']!
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h === PROJECT_RESOLVED_HEADER);
  expect(twiceExposed).toHaveLength(1);
});
