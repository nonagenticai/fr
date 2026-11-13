// tests/unit/routes/tenant-billing.test.ts
//
// toTenantBilling — the math behind GET /api/tenant/billing. Pure; no DB, no
// Keycloak, no billing. The properties that matter:
//   * the two sentinels become the Unattributed buckets and are never dropped,
//   * sum(projects) + unattributed == total == sum(members) + unattributed,
//   * coverage is the attributed share, null (not 0 / 100) on an axis with no spend,
//   * a disagreement between billing's two rollups is FLAGGED, not hidden,
//   * unknown projects / unresolved actors stay as rows with null names.
//
// The handler is not driven end-to-end here (AUTH_BYPASS + no Postgres in the
// unit lane — same scoping as tests/unit/routes/tenant/members.test.ts); the
// gate is pinned structurally from the source.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  toTenantBilling,
  toBilledTenantBilling,
  resolveRange,
} from '../../../src/routes/tenant/billing';
import {
  UNATTRIBUTED_PROJECT_ID,
  UNATTRIBUTED_ACTOR_ID,
} from '../../../src/integrations/metering/usage';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const A2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const proj = (project_id: string, cost_usd: number, request_count = 1) => ({
  project_id,
  cost_usd,
  input_tokens: 0,
  output_tokens: 0,
  request_count,
});
const actor = (actor_id: string, cost_usd: number, request_count = 1, byo_cost_usd = 0) => ({
  actor_id,
  cost_usd,
  byo_cost_usd,
  input_tokens: 0,
  output_tokens: 0,
  request_count,
});

function build(opts: {
  total: number;
  projects: ReturnType<typeof proj>[];
  actorTotal?: number;
  actors: ReturnType<typeof actor>[];
  projectNames?: Record<string, string>;
  people?: Record<string, { id: string; email: string | null; name: string }>;
  lookupFailed?: { projects: boolean; members: boolean };
}) {
  return toTenantBilling({
    from: '2026-09-01',
    to: '2026-09-07',
    breakdown: { total_cost_usd: opts.total, by_project: opts.projects },
    actors: { total_cost_usd: opts.actorTotal ?? opts.total, by_actor: opts.actors },
    projectNames: opts.projectNames ?? {},
    people: opts.people ?? {},
    lookupFailed: opts.lookupFailed,
  });
}

describe('toTenantBilling', () => {
  test('sentinels become unattributed buckets; totals reconcile; coverage is the attributed share', () => {
    const r = build({
      total: 10,
      projects: [proj(P1, 6, 3), proj(P2, 1.5, 2), proj(UNATTRIBUTED_PROJECT_ID, 2.5, 4)],
      actors: [actor(A1, 7, 5, 2), actor(UNATTRIBUTED_ACTOR_ID, 3, 4)],
      projectNames: { [P1]: 'Alpha' },
      people: { [A1]: { id: A1, email: 'a@x.test', name: 'Ada' } },
    });
    expect(r.projects.map((p) => p.id)).toEqual([P1, P2]); // sorted by cost desc, sentinel removed
    expect(r.unattributed).toEqual({
      project_usd: 2.5,
      project_requests: 4,
      member_usd: 3,
      member_requests: 4,
    });
    expect(r.total_cost_usd).toBe(10);
    const projSum = r.projects.reduce((s, p) => s + p.cost_usd, 0) + r.unattributed.project_usd;
    const memSum = r.members.reduce((s, m) => s + m.cost_usd, 0) + r.unattributed.member_usd;
    expect(Math.abs(projSum - r.total_cost_usd)).toBeLessThan(1e-6);
    expect(Math.abs(memSum - r.total_cost_usd)).toBeLessThan(1e-6);
    expect(r.totals_mismatch).toBe(false);
    expect(r.coverage).toEqual({ project_pct: 75, member_pct: 70 });
    expect(r.members[0]).toEqual({
      id: A1,
      name: 'Ada',
      email: 'a@x.test',
      resolved: true,
      cost_usd: 7,
      byo_cost_usd: 2,
      requests: 5,
    });
  });

  test('unknown project and unresolved actor are kept with null names, never dropped', () => {
    const r = build({
      total: 3,
      projects: [proj(P1, 1), proj(P2, 2)],
      actors: [actor(A1, 1), actor(A2, 2)],
      projectNames: { [P1]: 'Alpha' },
      people: { [A1]: { id: A1, email: null, name: 'Ada' } },
    });
    expect(r.projects).toEqual([
      { id: P2, name: null, cost_usd: 2, requests: 1 },
      { id: P1, name: 'Alpha', cost_usd: 1, requests: 1 },
    ]);
    const a2 = r.members.find((m) => m.id === A2);
    expect(a2).toEqual({
      id: A2,
      name: null,
      email: null,
      resolved: false,
      cost_usd: 2,
      byo_cost_usd: 0,
      requests: 1,
    });
    expect(r.unattributed.project_usd).toBe(0);
    expect(r.unattributed.member_usd).toBe(0);
    expect(r.coverage).toEqual({ project_pct: 100, member_pct: 100 });
  });

  test('billing rollups that disagree are flagged, with all three totals returned', () => {
    const r = build({
      total: 10,
      projects: [proj(P1, 10)],
      actorTotal: 9,
      actors: [actor(A1, 9)],
    });
    expect(r.totals_mismatch).toBe(true);
    expect(r.totals).toEqual({ tenant_usd: 10, projects_usd: 10, members_usd: 9 });
    // Every row survives regardless.
    expect(r.projects).toHaveLength(1);
    expect(r.members).toHaveLength(1);
  });

  test('a tenant total that by_project does not account for (older billing) is flagged', () => {
    const r = build({ total: 5, projects: [], actors: [actor(A1, 5)] });
    expect(r.totals_mismatch).toBe(true);
    expect(r.totals.projects_usd).toBe(0);
    expect(r.coverage.project_pct).toBeNull();
  });

  test('differences within 1e-6 are not a mismatch; no-spend coverage is null, not 0 or 100', () => {
    const r = build({
      total: 0.3,
      projects: [proj(P1, 0.1), proj(P2, 0.2)],
      actors: [actor(A1, 0.1000004), actor(A2, 0.2)],
    });
    expect(r.totals_mismatch).toBe(false);
    const empty = build({ total: 0, projects: [], actors: [] });
    expect(empty.coverage).toEqual({ project_pct: null, member_pct: null });
    expect(empty.totals_mismatch).toBe(false);
  });

  test('an all-unattributed axis has 0% coverage', () => {
    const r = build({
      total: 4,
      projects: [proj(UNATTRIBUTED_PROJECT_ID, 4)],
      actors: [actor(UNATTRIBUTED_ACTOR_ID, 4)],
    });
    expect(r.coverage).toEqual({ project_pct: 0, member_pct: 0 });
    expect(r.projects).toEqual([]);
    expect(r.unattributed.project_usd).toBe(4);
  });
});

describe('names_unavailable is derived from the rows, not only from a thrown lookup', () => {
  // The defect (fr#1223 → fr#1231): a project outside the tenant / missing from
  // fr's table, or an actor Keycloak did not return, rendered `name: null`
  // beside `names_unavailable.* === false`, so the page showed bare ids with no
  // notice. Nothing threw, so the old flag stayed false.
  test('some project ids and some actors unresolved (no lookup threw) → true', () => {
    const r = build({
      total: 3,
      projects: [proj(P1, 1), proj(P2, 2)],
      actors: [actor(A1, 1), actor(A2, 2)],
      projectNames: { [P1]: 'Alpha' },
      people: { [A1]: { id: A1, email: null, name: 'Ada' } },
    });
    expect(r.projects.find((p) => p.id === P2)?.name).toBeNull();
    expect(r.names_unavailable).toEqual({ projects: true, members: true });
  });

  test('project lookup returned nothing for every id → projects true, members false', () => {
    const r = build({
      total: 3,
      projects: [proj(P1, 1), proj(P2, 2)],
      actors: [actor(A1, 3)],
      projectNames: {},
      people: { [A1]: { id: A1, email: null, name: 'Ada' } },
    });
    expect(r.names_unavailable).toEqual({ projects: true, members: false });
  });

  test('every project and actor resolves → both false', () => {
    const r = build({
      total: 3,
      projects: [proj(P1, 1), proj(P2, 2), proj(UNATTRIBUTED_PROJECT_ID, 0)],
      actors: [actor(A1, 1), actor(A2, 2), actor(UNATTRIBUTED_ACTOR_ID, 0)],
      projectNames: { [P1]: 'Alpha', [P2]: 'Beta' },
      people: {
        [A1]: { id: A1, email: null, name: 'Ada' },
        [A2]: { id: A2, email: null, name: 'Bob' },
      },
    });
    expect(r.names_unavailable).toEqual({ projects: false, members: false });
  });

  test('a lookup that threw stays true even with no attributed rows to show it', () => {
    const r = build({
      total: 1,
      projects: [proj(UNATTRIBUTED_PROJECT_ID, 1)],
      actors: [actor(UNATTRIBUTED_ACTOR_ID, 1)],
      lookupFailed: { projects: true, members: false },
    });
    expect(r.names_unavailable).toEqual({ projects: true, members: false });
  });
});

describe('resolveRange', () => {
  test('defaults to the last 7 days including today (UTC)', () => {
    // Real clock: the window ends today and spans 7 days inclusive.
    const r = resolveRange(new URLSearchParams());
    if ('error' in r) throw new Error(r.error);
    expect(r.to).toBe(new Date().toISOString().slice(0, 10));
    expect((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000).toBe(6);
  });
  test('rejects malformed, impossible and inverted dates', () => {
    expect('error' in resolveRange(new URLSearchParams('from=2026-9-1&to=2026-09-02'))).toBe(true);
    expect('error' in resolveRange(new URLSearchParams('from=2026-02-30&to=2026-03-02'))).toBe(true);
    expect('error' in resolveRange(new URLSearchParams('from=2026-09-10&to=2026-09-02'))).toBe(true);
  });
  test('rejects a range wider than the chunk cap', () => {
    expect('error' in resolveRange(new URLSearchParams('from=1990-01-01&to=2026-09-01'))).toBe(true);
  });
});

describe('handler gate (structural)', () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, '../../../src/routes/tenant/billing.ts'),
    'utf8',
  );
  test('gates on super-admin OR workspace-admin of the context tenant, before any billing read', () => {
    const gate = SOURCE.indexOf("hasRole(user.id, tenantId, 'workspace-admin')");
    expect(gate).toBeGreaterThan(-1);
    expect(SOURCE).toContain('isSuperAdmin(user)');
    expect(gate).toBeLessThan(SOURCE.indexOf('getTenantCostBreakdown({'));
    // Realm tenant_admin, pinned to the raw tenant_id claim, also admits.
    const realm = SOURCE.indexOf('isRealmTenantAdminOf(user, tenantId)');
    expect(realm).toBeGreaterThan(-1);
    expect(realm).toBeLessThan(SOURCE.indexOf('getTenantCostBreakdown({'));
  });
  test('the tenant comes from the request context, never a query param', () => {
    expect(SOURCE).toContain('ctxTenantId(user.tenantId)');
    expect(SOURCE).not.toMatch(/searchParams\.get\(['"]tenant/);
  });
});

// ── billed, not incurred, for a workspace-admin ─────────────────────────────
//
// billing's `/api/costs/tenant/{id}` rollups are what fr BOOKS (billing_service
// alembic 0021: cost_usd "keeps its meaning — what we book"; markup is applied
// on top). The route handed them to workspace-admins unmarked — fr's margin.

describe('toBilledTenantBilling', () => {
  const incurred = () =>
    build({
      total: 10,
      projects: [proj(P1, 6, 3), proj(P2, 1.5, 2), proj(UNATTRIBUTED_PROJECT_ID, 2.5, 4)],
      actors: [actor(A1, 7, 5, 2), actor(UNATTRIBUTED_ACTOR_ID, 3, 4)],
    });

  test('every cost figure is marked up; byo, requests, coverage and mismatch are untouched', () => {
    const r = toBilledTenantBilling(incurred(), 25);
    expect(r.cost_basis).toBe('billed');
    expect(r.total_cost_usd).toBe(12.5);
    expect(r.totals).toEqual({ tenant_usd: 12.5, projects_usd: 12.5, members_usd: 12.5 });
    expect(r.projects.map((p) => p.cost_usd)).toEqual([7.5, 1.88]);
    expect(r.unattributed).toEqual({
      project_usd: 3.12, // 3.125 → half-even, as billing.py quantizes
      project_requests: 4,
      member_usd: 3.75,
      member_requests: 4,
    });
    expect(r.members[0]!.cost_usd).toBe(8.75);
    expect(r.members[0]!.byo_cost_usd).toBe(2); // the customer's own provider bill
    expect(r.coverage).toEqual({ project_pct: 75, member_pct: 70 });
    expect(r.totals_mismatch).toBe(false);
  });

  test('the incurred payload declares its basis', () => {
    expect(incurred().cost_basis).toBe('incurred');
  });
});

describe('handler: a non-super-admin is shown billed cost (structural)', () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, '../../../src/routes/tenant/billing.ts'),
    'utf8',
  );
  test('markup is fetched for non-super-admins and applied before the response', () => {
    expect(SOURCE).toContain('superAdmin ? Promise.resolve(null) : fetchTenantMarkupPct(tenantId)');
    // Markup unknown → WITHHELD, never incurred (its behavioural suite was
    // deleted 2026-10-29; only this source pin remains).
    expect(SOURCE).toMatch(
      /superAdmin\s*\?\s*incurred\s*:\s*markupPct === null\s*\?\s*toWithheldTenantBilling\(incurred\)\s*:\s*toBilledTenantBilling\(incurred, markupPct\)/,
    );
  });
});
