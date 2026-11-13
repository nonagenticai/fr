// tests/unit/routes/knowledge-area-routes.test.ts
//
// The knowledge-area ROUTES. The properties under test are the two that an
// end-to-end test could not establish any better and that a reviewer is least
// likely to catch in a diff:
//
//   1. the execution sign-off roster is UNREACHABLE from these endpoints, and
//   2. an allocation change is ATOMIC, because the role is part of the PK.
//
// ⚠️ SCOPE: this suite runs with AUTH_BYPASS, so `validateAuth` returns a
// synthetic admin rather than throwing and every handler then reaches Postgres. A
// handler-level test here would assert against the no-local-Postgres failure
// rather than against authorization — which is worse than no test, because it
// LOOKS like coverage. So this file covers the pure folds and the STRUCTURAL
// invariants; end-to-end authz coverage belongs in the integration suite, which
// has a database.

import { describe, test, expect } from 'bun:test';

import { toProjectAllocation } from '../../../src/routes/project-knowledge-allocation';
import type { RoleGrant } from '../../../src/services/user-roles';

const SERVICE_SRC = await Bun.file(
  new URL('../../../src/services/knowledge-areas.ts', import.meta.url).pathname,
).text();
const PROJECT_ROUTE_SRC = await Bun.file(
  new URL('../../../src/routes/project-knowledge-allocation.ts', import.meta.url).pathname,
).text();
const WORKSPACE_ROUTE_SRC = await Bun.file(
  new URL('../../../src/routes/workspace/knowledge-areas.ts', import.meta.url).pathname,
).text();
const SERVER_SRC = await Bun.file(
  new URL('../../../src/server.ts', import.meta.url).pathname,
).text();
const MEMBERS_ROUTE_SRC = await Bun.file(
  new URL('../../../src/routes/tenant/members.ts', import.meta.url).pathname,
).text();

/**
 * Source text with `//` line comments and block comments blanked out.
 *
 * ⚠️ LOAD-BEARING, NOT TIDINESS. These files discuss `execution_signoff` at
 * length — deliberately, because "why this lane must not touch it" is the most
 * important sentence in them — and every mention is in backticks. A raw
 * `not.toContain('`execution_signoff`')` therefore FAILED on the prose, and the
 * tempting fix (delete the assertion, or only check the single-quoted form) would
 * have left a real hand-written `` `execution_signoff` `` template literal
 * invisible. Same discipline, same reason, as
 * scripts/check-migration-dml-probed.ts's stripper.
 *
 * Newlines are preserved so nothing downstream shifts.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const grant = (user_id: string, role = 'workspace-member'): RoleGrant => ({
  user_id,
  tenant_id: '0195f48b-d000-7000-8000-000000000001',
  tenant_name: 'Acme',
  role,
  granted_at: '2026-09-01T00:00:00.000Z',
  granted_by: null,
});
const person = (id: string, name: string, email: string) => ({ id, name, email });

describe('the allocation editor is fed CANDIDATES, so it cannot render falsely empty', () => {
  test('every tenant member appears, allocated or not', () => {
    // ⚠️ MEASURED 2026-09-27: all 113 `project_stakeholders` rows carry role
    // `execution_signoff`, so the knowledge-area allocation of EVERY project in
    // the estate is currently the empty set. An editor listing only existing
    // allocation rows would therefore render empty everywhere — which reads as
    // "there is nobody to allocate" when the truth is "nobody is allocated yet".
    const items = toProjectAllocation(
      [grant('u1'), grant('u2')],
      { u1: person('u1', 'Ada', 'ada@acme.test'), u2: person('u2', 'Grace', 'g@acme.test') },
      new Map([['u1', ['architecture']]]),
      new Map(), // nobody allocated on this project
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(['u1', 'u2']);
    expect(items.every((i) => i.project_knowledge_areas.length === 0)).toBe(true);
  });

  test('the two area lists answer DIFFERENT questions and are not conflated', () => {
    // `knowledge_areas` is the STANDING tenant-wide set (the prefill source);
    // `project_knowledge_areas` is what this project actually allocates. A
    // project allocation is deliberately not required to be a subset — `testing`
    // below is allocated on the project without being a standing claim.
    const items = toProjectAllocation(
      [grant('u1')],
      { u1: person('u1', 'Ada', 'ada@acme.test') },
      new Map([['u1', ['architecture']]]),
      new Map([['u1', ['testing']]]),
    );
    expect(items[0]!.knowledge_areas).toEqual(['architecture']);
    expect(items[0]!.project_knowledge_areas).toEqual(['testing']);
  });

  test('a member absent from either map gets [] — never undefined', () => {
    const items = toProjectAllocation([grant('u9')], {}, new Map(), new Map());
    expect(items[0]!.knowledge_areas).toEqual([]);
    expect(items[0]!.project_knowledge_areas).toEqual([]);
  });

  test('an unresolvable id is still LISTED, and still sorts last', () => {
    // Inherited from `toTenantMembers`, deliberately, rather than re-derived: an
    // empty picker is a false statement about access, and a dangling grant that
    // sorts among the names reads as a person you meant to pick.
    const items = toProjectAllocation(
      [grant('zoe'), grant('ghost')],
      { zoe: person('zoe', 'Zoe', 'zoe@acme.test') },
      new Map(),
      new Map(),
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('zoe');
    expect(items[1]!).toMatchObject({ id: 'ghost', resolved: false });
  });
});

describe('⛔ the execution sign-off roster is unreachable from these routes', () => {
  test('both project reads are scoped to the tenant area vocabulary', () => {
    // Structural, because the property is about what the SQL is ALLOWED to match
    // rather than about one request's outcome — and because the failure it guards
    // is silent: `delete where project_id = $1 and user_id = $2` would empty a
    // live sign-off roster and return 200.
    //
    // TWO reads must each carry the filter — the per-project list and the
    // per-member read — and the write inherits it transitively, because its diff
    // is computed from that per-member read.
    const code = stripComments(SERVICE_SRC);
    expect(code.split('inArray(projectStakeholders.role, roles)').length - 1).toBe(2);
    expect(code.split('const roles = areaRoles(vocabulary);').length - 1).toBe(2);
  });

  test('the only DELETE on project_stakeholders is bounded by that filtered read', () => {
    const code = stripComments(SERVICE_SRC);
    // Exactly one delete statement in the whole lane…
    expect(code.split('.delete(projectStakeholders)').length - 1).toBe(1);
    // …and its role predicate is `plan.toDelete`, which comes from
    // `listProjectAllocationForMember` and is therefore a subset of the 15 areas
    // by construction. A predicate on (project_id, user_id) alone would match
    // every `execution_signoff` row the member holds.
    expect(code).toContain('inArray(projectStakeholders.role, plan.toDelete)');
  });

  test("`execution_signoff` appears in the PROSE and never in the CODE", () => {
    for (const src of [SERVICE_SRC, PROJECT_ROUTE_SRC, WORKSPACE_ROUTE_SRC]) {
      expect(stripComments(src)).not.toContain('execution_signoff');
    }
    // Non-zero control, two ways. (a) The reasoning IS there, so a future rewrite
    // that deletes it cannot pass by saying nothing. (b) The stripper is doing
    // real work rather than returning the input — if it were a no-op, (a) and the
    // assertion above would contradict each other and one of them would fail.
    expect(SERVICE_SRC).toContain('execution_signoff');
    expect(PROJECT_ROUTE_SRC).toContain('execution_signoff');
    expect(stripComments(SERVICE_SRC).length).toBe(SERVICE_SRC.length);
    expect(stripComments(SERVICE_SRC)).not.toBe(SERVICE_SRC);
  });
});

describe('⭐ an allocation change is atomic, because `role` is in the primary key', () => {
  test('both writes on each path run inside ONE db.transaction', () => {
    // `project_stakeholders`'s PK is (project_id, user_id, ROLE), so changing a
    // role is a DELETE plus an INSERT. Two round trips leave a window in which
    // the member holds neither area, and a crash in that window makes it
    // permanent.
    //
    // ⚠️ WHITESPACE-INSENSITIVE ON PURPOSE. These assertions used to pin the
    // source text INCLUDING ITS INDENTATION — `'tx\n        .delete(...)'` — so a
    // prettier run that rewrapped `await tx.delete(...)` onto one line, or
    // reindented the block by two spaces, turned them RED with no behaviour change
    // whatsoever. A structural test that fails on formatting trains the next
    // person to delete it. Worse, the same brittleness made the final NEGATIVE
    // assertion (`not.toContain('defaultDb\n        .delete(')`) unable to fail
    // for the right reason: a statement genuinely moved off `tx` onto the outer
    // handle would be reported only if it landed at exactly that indentation.
    //
    // The property is unchanged: two transactions, every mutating statement
    // issued on `tx`, none on the outer handle. Comments are stripped first —
    // this file's prose discusses `db.transaction` at length, so a loosened
    // pattern would otherwise match the reasoning rather than the code.
    const code = stripComments(SERVICE_SRC);

    // Non-vacuity controls for the instrument itself. `stripComments` blanks
    // comments to spaces and preserves newlines, so the length must be identical
    // while the content must NOT be — if it silently returned its input, every
    // count below would be counting prose; if it returned '', they would all be 0
    // and `.toBe(2)` would catch it, but the equality pair further down would pass
    // vacuously at 0 === 0.
    expect(code.length).toBe(SERVICE_SRC.length);
    expect(code).not.toBe(SERVICE_SRC);

    const count = (re: RegExp): number => code.match(re)?.length ?? 0;

    expect(count(/\bdb\s*\.\s*transaction\s*\(\s*async\s*\(\s*tx\s*\)/g)).toBe(2);

    // Every statement of both writes is issued on `tx`, never on the outer
    // handle — the mistake that makes a "transaction" decorative.
    for (const table of ['memberKnowledgeAreas', 'projectStakeholders']) {
      for (const verb of ['delete', 'insert']) {
        expect(
          count(new RegExp(`\\btx\\s*\\.\\s*${verb}\\s*\\(\\s*${table}\\s*\\)`, 'g')),
          `${verb} on ${table} must be issued on tx`,
        ).toBe(1);
      }
    }

    // …and NOTHING mutating is issued off `tx`. Asserted as "all of them are tx
    // ones" with the total pinned separately, so the equality cannot be satisfied
    // by there being no statements at all — which is what a bare
    // `not.toContain('defaultDb…')` amounted to once formatting moved.
    expect(count(/\.\s*delete\s*\(/g)).toBe(2);
    expect(count(/\.\s*insert\s*\(/g)).toBe(2);
    expect(count(/\.\s*delete\s*\(/g)).toBe(count(/\btx\s*\.\s*delete\s*\(/g));
    expect(count(/\.\s*insert\s*\(/g)).toBe(count(/\btx\s*\.\s*insert\s*\(/g));
  });

  test('the diff is computed INSIDE the transaction, against rows it can see', () => {
    // Reading the current set outside the transaction would make the plan stale
    // the moment a second admin saves concurrently.
    expect(SERVICE_SRC).toContain('listAreasForMember(tenantId, userId, tx)');
    expect(SERVICE_SRC).toContain('listProjectAllocationForMember(projectId, userId, vocabulary, tx)');
  });

  test('inserts are conflict-tolerant, so a concurrent identical save cannot 500', () => {
    expect(SERVICE_SRC.split('.onConflictDoNothing(').length - 1).toBe(2);
  });
});

describe('authz and tenant provenance', () => {
  // ⚠️ EVERY negative assertion in this block runs on `stripComments(...)`, and
  // that is not a style choice. Three of them FAILED on the prose first: these
  // files name `requireWorkspaceAdmin`, `isWorkspaceAdminOf`, `findProjectForRead`
  // and `findTenantScopedProject` in comments explaining why each is or is not
  // used — which is exactly the reasoning a reviewer needs. A test that forces
  // that reasoning to be deleted to go green is a worse instrument than no test.
  test('the WORKSPACE write reuses requireWorkspaceAdmin rather than a copy', () => {
    const code = stripComments(WORKSPACE_ROUTE_SRC);
    expect(code).toContain('import { requireWorkspaceAdmin } from');
    expect(code).toContain('await requireWorkspaceAdmin(req)');
    // …and does not re-derive the gate, which is how copies of a gate diverge
    // in the direction that opens it. `isWorkspaceAdminOf` is the gate's own
    // internal; `isSuperAdmin` is a DIFFERENT authority axis that this
    // predicate deliberately excludes (services/user-roles.ts's ⛔ note).
    expect(code).not.toContain('isWorkspaceAdminOf');
    expect(code).not.toContain('isSuperAdmin');
  });

  test('the PROJECT allocation is a tenant-MEMBER route (George 2026-10-16, ruling b): no admin gate, licence refused', () => {
    const code = stripComments(PROJECT_ROUTE_SRC);
    expect(code).not.toContain('requireWorkspaceAdmin');
    expect(code).not.toContain('isWorkspaceAdminOf');
    expect(code).not.toContain('isSuperAdmin');
    // ONE gate, used by both verbs, which reads the verified identity itself.
    expect(code.split('await validateAuth(req)').length - 1).toBe(1);
    expect(code).toContain("await requireProjectMember(req, projectId, 'read')");
    expect(code).toContain("await requireProjectMember(req, projectId, 'write')");
    expect(code).toContain("user.authKind === 'licence'");
  });

  test('the tenant is never taken from caller input', () => {
    // `ctxTenantId` is read ONCE, inside the shared gate, so a check and a write
    // cannot disagree about which tenant they mean; neither file accepts one from
    // a body or a query string.
    for (const src of [PROJECT_ROUTE_SRC, WORKSPACE_ROUTE_SRC]) {
      const code = stripComments(src);
      expect(code).not.toContain('body.tenant');
      expect(code).not.toContain("searchParams.get('tenant");
      // Body strictness is not re-declared per route — both parse the ONE shared
      // `SetAreasBody` (lib/knowledge-areas.ts, `.strict()`). Two copies of a
      // schema is the same defect as two copies of a gate.
      expect(code).toContain('SetAreasBody.parse(await req.json())');
      expect(code).not.toContain('z.object(');
    }
    expect(stripComments(WORKSPACE_ROUTE_SRC)).not.toContain('ctxTenantId');
    expect(stripComments(PROJECT_ROUTE_SRC).split('ctxTenantId(user.tenantId)').length - 1).toBe(1);
  });

  test('the project lanes are the P1-TEAM member lanes: READ for the GET, the member WRITE lane (+ switched-view owner pin, archived refusal) for the PUT', () => {
    const code = stripComments(PROJECT_ROUTE_SRC);
    expect(code).not.toContain('findProjectForWorkspaceAdmin');
    expect(code).toContain("mode === 'read' ? await findProjectForRead(db, user, projectId) : await findTenantScopedProject(db, user, projectId)");
    expect(code).toContain("mode === 'write' && !projectWritableByCaller(user, project)");
    expect(code).toContain("if (mode === 'write') assertProjectNotArchived(project);");
  });

  test('the sign-off fence is spelled at the route: a reserved stakeholder role is refused before the vocabulary is read', () => {
    const code = stripComments(PROJECT_ROUTE_SRC);
    const fence = code.indexOf('NON_AREA_STAKEHOLDER_ROLES.includes(a)');
    const vocabulary = code.indexOf('await knowledgeAreasOf(tenantId)', code.indexOf('handleSetProjectMemberKnowledgeAllocation'));
    expect(fence).toBeGreaterThan(-1);
    expect(vocabulary).toBeGreaterThan(fence);
    expect(code).toContain("code: 'reserved_stakeholder_role'");
  });

  test('the member directory read stays member-level, not admin-gated', () => {
    // GET /api/tenant/members is a DIRECTORY, not a secret. Adding areas to it
    // must not have quietly raised its guard — an empty picker is a false
    // statement about access, and that file's own header says so at length
    // (which is why this reads the STRIPPED source).
    const code = stripComments(MEMBERS_ROUTE_SRC);
    expect(code).toContain('await validateAuth(req)');
    expect(code).not.toContain('requireWorkspaceAdmin');
    expect(code).not.toContain('isWorkspaceAdminOf');
    // Non-zero control for the stripper on THIS file: the prose does name the
    // admin gate, so a stripper that silently returned '' would make the two
    // assertions above vacuous.
    expect(MEMBERS_ROUTE_SRC).toContain('requireWorkspaceAdmin');
    // Non-vacuity only: a stripper that returned '' would make the assertions
    // above vacuous. No size of the file is pinned.
    expect(code.length).toBeGreaterThan(0);
  });
});

describe('the vocabulary endpoint', () => {
  test('the routes are registered: all four capability-derived (deriveRouter)', () => {
    // The route table (server.ts + deriveRouter) is the only place a path exists. fr-agui P2-c1
    // derived the allocation READ; P4d-2a the other three (capabilities/projects/collaboration.ts).
    for (const k of [
      'GET /api/tenant/knowledge-areas',
      'PUT /api/workspace/members/:userId/knowledge-areas',
      'PUT /api/projects/:id/knowledge-allocation/:userId',
    ]) {
      expect(SERVER_SRC).toContain(`// ${k} is capability-derived (P4d-2a`);
    }
    expect(SERVER_SRC).not.toContain("'/api/projects/:id/knowledge-allocation',");
    expect(SERVER_SRC).toContain('GET /api/projects/:id/knowledge-allocation is capability-derived (P2-c1');
  });
});
