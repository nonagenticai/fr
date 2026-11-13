// tests/unit/lib/project-owner-guard-seam.test.ts
//
// fr#1143 audit (review 5230781755) M3: `project-owner-guard.test.ts` pins
// `resolveEmission` in isolation — a hand-built `OwnershipCandidateProject`
// object, never a row that came out of Postgres. The ONE production seam
// that applies the guard is `lib/project-access.ts resolveProject()`
// (`grep -rn "guardProjectId(" backend/src` finds exactly that one call
// site), and nothing in the suite drove it end-to-end: bypassing the guard
// there — `setProjectId(project.id)` unconditionally instead of routing
// through `guardProjectId` — left the whole suite green.
//
// This file closes that gap: it seeds real `projects` rows in the CI
// Postgres instance and calls the REAL `findTenantScopedProject` /
// `findProjectForRead` inside a real ALS request frame, so the SQL fetch,
// the guard, and `setProjectId`'s fill-once semantics all run together,
// exactly as they do in production.
//
// DB-backed + skip-if-unreachable.

import {
  expect,
  describe,
  beforeAll,
  afterAll,
} from 'bun:test';
import { db, queryClient, projects } from '../../../src/db/client';
import {
  findTenantScopedProject,
  findProjectForRead,
} from '../../../src/lib/project-access';
import { withRequestContext, getProjectId } from '../../../src/middleware/request-context';

import { createDbSuite } from '../../integration/helpers/db-suite';

const sql = queryClient;

// Per-file fixed UUIDs (never LIKE 'test-%').
const HOME_TENANT = 'e5000000-0000-4000-8000-00000000000a'; // caller's active tenant
const FOREIGN_TENANT = 'e5000000-0000-4000-8000-00000000000b'; // a DIFFERENT tenant
const OWNER_ID = 'e6000000-0000-4000-8000-000000000001';

const PROJECT_OWNED = 'e7000000-0000-4000-8000-0000000000a1'; // tagged HOME_TENANT
const PROJECT_FOREIGN = 'e7000000-0000-4000-8000-0000000000a2'; // tagged FOREIGN_TENANT
const PROJECT_UNTAGGED = 'e7000000-0000-4000-8000-0000000000a3'; // no keycloak_tenant_id at all

let reachable = false;

// A minimal ScopeUser: no roles, so `isSuperAdminSwitchedView` /
// `isSuperAdminHomeView` are both false and the two resolvers behave
// identically for this subject (findProjectForRead's extra relaxation is
// super-admin-only).
const user = { id: OWNER_ID, tenantId: HOME_TENANT, roles: [] as string[] };

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[project-owner-guard-seam] DB not reachable, skipping. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!reachable) return;

  await sql`DELETE FROM projects WHERE id IN (${PROJECT_OWNED}, ${PROJECT_FOREIGN}, ${PROJECT_UNTAGGED})`;

  // dept_id = NULL on all three: `tenantScopedProjectFilter`'s home-tenant
  // branch is `owner_id = userId AND (dept-workspace match OR dept_id IS
  // NULL)`, so a NULL dept_id makes the row reachable under the caller's
  // home tenant with no `workspaces`/`departments` fixtures at all — the
  // SQL-level scope is deliberately orthogonal to the `project_data` tag the
  // JS-side guard reads afterward (see project-access.ts:280-283's own
  // comment on exactly this gap).
  await db.insert(projects).values([
    {
      id: PROJECT_OWNED,
      owner_id: OWNER_ID,
      name: 'owner-guard-seam-owned',
      repository_url: 'https://example.com/repo',
      dept_id: null,
      project_data: { keycloak_tenant_id: HOME_TENANT },
    },
    {
      id: PROJECT_FOREIGN,
      owner_id: OWNER_ID,
      name: 'owner-guard-seam-foreign',
      repository_url: 'https://example.com/repo',
      dept_id: null,
      project_data: { keycloak_tenant_id: FOREIGN_TENANT },
    },
    {
      id: PROJECT_UNTAGGED,
      owner_id: OWNER_ID,
      name: 'owner-guard-seam-untagged',
      repository_url: 'https://example.com/repo',
      dept_id: null,
      project_data: null,
    },
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await sql`DELETE FROM projects WHERE id IN (${PROJECT_OWNED}, ${PROJECT_FOREIGN}, ${PROJECT_UNTAGGED})`;
});


const { itDb } = createDbSuite('project-owner-guard-seam');

interface Resolved<T> {
  row: T;
  /**
   * `getProjectId()` read INSIDE the ALS frame, in the same callback that
   * calls the resolver — NOT after `withRequestContext`'s promise resolves.
   * AsyncLocalStorage's active store does not survive back out into the
   * caller's own async context once `.run()`'s callback has returned, so a
   * `getProjectId()` call made after `await`ing the frame reads NO store at
   * all (`undefined` for a reason that has nothing to do with the guard —
   * see `integrations/_lib/context.test.ts`'s own tests, which all read
   * inside the callback for exactly this reason).
   */
  projectId: string | undefined;
}

function resolveInFrame<T>(fn: () => Promise<T>): Promise<Resolved<T>> {
  return withRequestContext(
    {
      correlationId: 'owner-guard-seam',
      initiator: 'human',
      channel: 'web',
      tenantId: HOME_TENANT,
      userId: OWNER_ID,
      activeTenantSource: 'jwt',
    },
    async () => {
      const row = await fn();
      return { row, projectId: getProjectId() };
    },
  );
}

describe('findTenantScopedProject — the real SQL fetch + the real guard, together', () => {

  // ⛔ MUTATION CONTROL — M3. If `resolveProject` is ever changed to call
  // `setProjectId(project.id)` directly (bypassing `guardProjectId`), the
  // SQL fetch above still finds this row (dept_id NULL + owner match), but
  // this assertion goes RED: a foreign-tagged project would then publish
  // its own id onto ALS under the HOME tenant's frame.
  //
  // fr row 14b: the SQL home branch now also requires the tag, so a foreign
  // row no longer even resolves — the owner cannot load it at all (and the
  // guard in resolveProject is the second, independent barrier).
  itDb('foreign: the owner can NOT load it, and NO project id reaches ALS', async () => {
    const { row, projectId } = await resolveInFrame(() =>
      findTenantScopedProject(db, user, PROJECT_FOREIGN),
    );
    expect(row).toBeUndefined();
    expect(projectId).toBeUndefined();
  });

  // ⛔ MUTATION CONTROL — M3, second arm. An untagged row is
  // foreign-but-unknown, not "no restriction" — same bypass would let it
  // through too.
  itDb('untagged: fails closed — not loadable, NO project id reaches ALS', async () => {
    const { row, projectId } = await resolveInFrame(() =>
      findTenantScopedProject(db, user, PROJECT_UNTAGGED),
    );
    expect(row).toBeUndefined();
    expect(projectId).toBeUndefined();
  });
});

describe('findProjectForRead — same seam, the read-only entry point', () => {
  // `findProjectForRead` funnels through the SAME `resolveProject`; for a
  // non-super-admin subject `crossTenantReadOnly` is false regardless, so
  // behaviour must be identical to `findTenantScopedProject` above.
  itDb('owned: identical to the mutating resolver for an ordinary user', async () => {
    const { row, projectId } = await resolveInFrame(() =>
      findProjectForRead(db, user, PROJECT_OWNED),
    );
    expect(row?.id).toBe(PROJECT_OWNED);
    expect(projectId).toBe(PROJECT_OWNED);
  });

  itDb('foreign: identical to the mutating resolver for an ordinary user', async () => {
    const { row, projectId } = await resolveInFrame(() =>
      findProjectForRead(db, user, PROJECT_FOREIGN),
    );
    expect(row).toBeUndefined();
    expect(projectId).toBeUndefined();
  });
});
