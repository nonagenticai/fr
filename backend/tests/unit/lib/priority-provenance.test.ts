// tests/unit/lib/priority-provenance.test.ts
//
// Pure unit tests (no DB) for the server-stamped priority provenance rules in
// lib/priority-change.ts: actor classification, the EXACT conveyor identity
// gate (isConveyorActor: azp + username + realm role, all three), the
// conveyor-only checks, the base semantics, the conveyor's tenant header and
// route allowlist, and the rule-tag refusal. The route-level proof (the
// project-priority and conveyor-priority route suites) was deleted 2026-10-29
// under the no-test-doubles ruling — no longer in the suite.

import { describe, expect, test } from 'bun:test';
import {
  CONVEYOR_AZP,
  CONVEYOR_ROLE,
  CONVEYOR_RULES,
  CONVEYOR_USERNAME,
  assertNoHumanOverride,
  conveyorTenantFromHeader,
  isConveyorActor,
  isConveyorAllowedRequest,
  parseConveyorRule,
  priorityActorClass,
  priorityBaseAfter,
  priorityEventTenantId,
  PROJECT_TENANT_UNKNOWN,
  prioritySetBy,
  refuseRuleTag,
} from '../../../src/lib/priority-change';
import { assertConveyorNotTopPriority } from '../../../src/services/catalogue/priority-levels';

// The tenant's levels as RM's defaults seed them (rank 0 = highest).
const LEVELS = ['p0', 'p1', 'p2', 'p3'].map((name, rank) => ({
  id: `00000000-0000-4000-8000-00000000000${rank}`,
  name,
  title: name.toUpperCase(),
  rank,
  is_default: rank === 2,
  conveyor_may_set: rank !== 0,
}));
const lv = (n: string) => LEVELS.find((l) => l.name === n.toLowerCase()) ?? null;
import { AA_CONVEYOR_TENANT_ID, PLATFORM_TENANT_IDS } from '../../../src/middleware/internal-tenant-only';
import type { AppError } from '../../../src/utils/errors';

const SUB = 'e2000000-0000-4000-8000-0000000014b1';
const u = (username: string | undefined, isServiceAccount = false) => ({
  id: SUB,
  username,
  isServiceAccount,
  roles: [] as string[],
});
/** EXACTLY the measured conveyor token's identity fields. */
const CONVEYOR = {
  id: SUB,
  username: CONVEYOR_USERNAME,
  isServiceAccount: true,
  azp: CONVEYOR_AZP,
  roles: [CONVEYOR_ROLE],
};

const CLASSES: Array<[string | undefined, boolean, 'human' | 'operator']> = [
  ['george', false, 'human'],
  ['fr-test', false, 'human'],
  [undefined, false, 'human'],
  ['claudette', false, 'human'], // prefix is `claude-`, not `claude`
  ['system-execution-operator', false, 'operator'],
  ['SYSTEM-Execution-Operator', false, 'operator'],
  ['claude-x', false, 'operator'],
  ['Claude-movies-13', false, 'operator'],
  ['aa-card-writer-x', false, 'operator'],
  ['AA-card-writer-x', false, 'operator'],
  ['service-account-n8n', true, 'operator'],
  ['george', true, 'operator'], // a service account is an operator whatever its name
];

const caught = (fn: () => void): AppError => {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a throw');
};

describe('priorityActorClass / prioritySetBy', () => {
  for (const [name, sa, cls] of CLASSES) {
    test(`${JSON.stringify(name)} (service account: ${sa}) → ${cls}:<sub>`, () => {
      expect(priorityActorClass(u(name, sa))).toBe(cls);
      expect(prioritySetBy(u(name, sa))).toBe(`${cls}:${SUB}`);
      // A rule never changes a non-conveyor stamp.
      expect(prioritySetBy(u(name, sa), 'A1')).toBe(`${cls}:${SUB}`);
    });
  }
  test('the exact conveyor identity → conveyor:<rule> (classified BEFORE operator)', () => {
    expect(priorityActorClass(CONVEYOR)).toBe('conveyor');
    for (const r of CONVEYOR_RULES) expect(prioritySetBy(CONVEYOR, r)).toBe(`conveyor:${r}`);
    expect(() => prioritySetBy(CONVEYOR)).toThrow();
  });
});

// Every identity that must NOT be the conveyor. `conveyor:` is produced only
// for the exact shape (CONVEYOR above).
const NOT_CONVEYOR: Array<[string, Parameters<typeof isConveyorActor>[0] & { id: string; isServiceAccount?: boolean }]> = [
  ['system-execution-operator', u('system-execution-operator')],
  ['claude-x', u('claude-x')],
  ['aa-card-writer-x', u('aa-card-writer-x')],
  ['fr-test', u('fr-test')],
  ['a normal user', u('george')],
  ['another service-account-*', { ...u('service-account-n8n-conveyor', true), azp: 'n8n-conveyor' }],
  ['another SA holding the role', { ...u('service-account-n8n', true), azp: 'n8n', roles: [CONVEYOR_ROLE] }],
  ['the right azp, no role', { ...CONVEYOR, roles: [] }],
  ['the right azp, another role', { ...CONVEYOR, roles: ['aa-orchestrator'] }],
  ['the role, another azp', { ...CONVEYOR, azp: 'fr-backend' }],
  ['the role, no azp', { ...CONVEYOR, azp: undefined }],
  ['right azp + role, another username', { ...CONVEYOR, username: 'service-account-conveyor-priority-2' }],
  ['right azp + role, a person username', { ...CONVEYOR, username: 'george' }],
  ['right azp + role, no username', { ...CONVEYOR, username: undefined }],
  ['case-variant azp', { ...CONVEYOR, azp: 'Conveyor-Priority' }],
];

describe('isConveyorActor — ONLY the exact (azp, username, role) shape', () => {
  test('true for the exact measured token shape', () => {
    expect(isConveyorActor(CONVEYOR)).toBe(true);
    // Extra realm roles (e.g. default-roles) do not matter; the role must be present.
    expect(isConveyorActor({ ...CONVEYOR, roles: ['offline_access', CONVEYOR_ROLE] })).toBe(true);
  });
  for (const [label, id] of NOT_CONVEYOR) {
    test(`false for ${label}; its stamp is never conveyor:`, () => {
      expect(isConveyorActor(id)).toBe(false);
      expect(prioritySetBy(id, 'A1').startsWith('conveyor:')).toBe(false);
      expect(prioritySetBy(id, 'A1')).toMatch(/^(human|operator):/);
    });
  }
  for (const [name, sa] of CLASSES) {
    test(`false for ${JSON.stringify(name)} (service account: ${sa})`, () => {
      expect(isConveyorActor(u(name, sa))).toBe(false);
    });
  }
});

describe('conveyor-only checks', () => {
  test('conveyor writing the RANK-0 level → 403 conveyor_p0_forbidden', () => {
    const e = caught(() => assertConveyorNotTopPriority(CONVEYOR, LEVELS, lv('P0')));
    expect(e.statusCode).toBe(403);
    expect(e.code).toBe('conveyor_p0_forbidden');
  });
  test('lower levels / null pass for the conveyor; the top level passes for everyone else', () => {
    for (const to of ['P1', 'P2', 'P3'] as const) expect(() => assertConveyorNotTopPriority(CONVEYOR, LEVELS, lv(to))).not.toThrow();
    expect(() => assertConveyorNotTopPriority(CONVEYOR, LEVELS, null)).not.toThrow();
    for (const [, id] of NOT_CONVEYOR) expect(() => assertConveyorNotTopPriority(id, LEVELS, lv('P0'))).not.toThrow();
  });
  test('the rule is RANK, not the name: a tenant whose top level is "urgent" protects that', () => {
    const custom = [
      { ...LEVELS[1]!, name: 'normal', rank: 5 },
      { ...LEVELS[0]!, name: 'urgent', rank: 1 },
    ];
    expect(caught(() => assertConveyorNotTopPriority(CONVEYOR, custom, custom[1]!)).code).toBe('conveyor_p0_forbidden');
    expect(() => assertConveyorNotTopPriority(CONVEYOR, custom, custom[0]!)).not.toThrow();
  });
  for (const prev of [`human:${SUB}`, `operator:${SUB}`]) {
    test(`conveyor over ${prev.split(':')[0]}: → 409 human_override`, () => {
      const e = caught(() => assertNoHumanOverride(CONVEYOR, prev));
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('human_override');
    });
  }
  test('conveyor over unset / conveyor:* passes; a person over anything passes', () => {
    for (const prev of [null, 'conveyor:A1']) expect(() => assertNoHumanOverride(CONVEYOR, prev)).not.toThrow();
    expect(() => assertNoHumanOverride(u('george'), `human:${SUB}`)).not.toThrow();
  });
});

describe('priorityBaseAfter', () => {
  test('a person/operator write RESETS base to the new value', () => {
    expect(priorityBaseAfter(u('george'), { priority: 'P3', setBy: 'conveyor:A1', base: 'P3' }, 'P2')).toBe('P2');
    expect(priorityBaseAfter(u('george'), { priority: 'P3', setBy: null, base: null }, null)).toBe(null);
  });
  test("the conveyor's FIRST write records the PRIOR value", () => {
    expect(priorityBaseAfter(CONVEYOR, { priority: 'P3', setBy: null, base: null }, 'P2')).toBe('P3');
    expect(priorityBaseAfter(CONVEYOR, { priority: null, setBy: null, base: null }, 'P2')).toBe(null);
  });
  test('a later conveyor write KEEPS the base', () => {
    expect(priorityBaseAfter(CONVEYOR, { priority: 'P2', setBy: 'conveyor:A1', base: 'P3' }, 'P1')).toBe('P3');
  });
});

describe('parseConveyorRule — closed set A1|A2|B1|B2', () => {
  for (const r of CONVEYOR_RULES) test(`${r} accepted`, () => expect(parseConveyorRule({ rule: r })).toBe(r));
  for (const body of [{}, { rule: 'A3' }, { rule: 'a1' }, { rule: 'C1' }, { rule: ' A1' }, { rule: 1 }, null]) {
    test(`${JSON.stringify(body)} → 400 conveyor_rule_required`, () => {
      const e = caught(() => parseConveyorRule(body));
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('conveyor_rule_required');
    });
  }
});

describe('conveyorTenantFromHeader — platform tenants only', () => {
  const req = (h?: string) => new Request('http://x/', { headers: h === undefined ? {} : { 'X-Tenant-Id': h } });
  test('every platform tenant is accepted', () => {
    for (const t of PLATFORM_TENANT_IDS) expect(conveyorTenantFromHeader(req(t))).toBe(t);
    expect(conveyorTenantFromHeader(req(AA_CONVEYOR_TENANT_ID))).toBe(AA_CONVEYOR_TENANT_ID);
  });
  test('missing → 403 conveyor_tenant_required', () => {
    for (const h of [undefined, '', '  ']) {
      const e = caught(() => conveyorTenantFromHeader(req(h)));
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe('conveyor_tenant_required');
    }
  });
  test('a non-platform tenant → 403 conveyor_tenant_forbidden', () => {
    for (const h of ['e0000000-0000-4000-8000-0000000014a1', 'not-a-uuid', AA_CONVEYOR_TENANT_ID.toUpperCase()]) {
      const e = caught(() => conveyorTenantFromHeader(req(h)));
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe('conveyor_tenant_forbidden');
    }
  });
});

describe('isConveyorAllowedRequest — the card priority write, plus reads', () => {
  const allowed: Array<[string, string]> = [
    ['PATCH', '/api/projects/p1/cards/c1/priority'],
    ['GET', '/api/projects'],
  ];
  const refused: Array<[string, string]> = [
    // D15/R16 (George 2026-10-13): a project's priority is RM's; only the PM writes it.
    ['PATCH', '/api/projects/p1'],
    ['POST', '/api/projects'],
    ['DELETE', '/api/projects/p1'],
    ['PUT', '/api/projects/p1'],
    ['POST', '/api/cards/project'],
    ['POST', '/api/kanban/lists/l1/cards'],
    ['POST', '/api/decompositions/commit'],
    ['PUT', '/api/approvals/a1'],
    ['PATCH', '/api/projects/p1/phase'],
    ['PATCH', '/api/projects/p1/cards/c1'],
    ['PATCH', '/api/projects/p1/cards/c1/priority/x'],
    ['POST', '/api/projects/p1/cards/c1/priority'],
  ];
  for (const [m, p] of allowed) test(`${m} ${p} allowed`, () => expect(isConveyorAllowedRequest(m, p)).toBe(true));
  for (const [m, p] of refused) test(`${m} ${p} refused`, () => expect(isConveyorAllowedRequest(m, p)).toBe(false));
});

describe('refuseRuleTag', () => {
  for (const body of [{ rule: 'A1' }, { priority: 'P1', conveyor_rule: 'B1' }, { priority: 'P1', Rule: 'x' }]) {
    test(`${JSON.stringify(body)} → 400 conveyor_rule_not_accepted`, () => {
      let err: AppError | undefined;
      try {
        refuseRuleTag(body);
      } catch (e) {
        err = e as AppError;
      }
      expect(err?.statusCode).toBe(400);
      expect(err?.code).toBe('conveyor_rule_not_accepted');
    });
  }
  for (const body of [{ priority: 'P1' }, { priority: null }, null, 'P1', ['rule']]) {
    test(`${JSON.stringify(body)} passes`, () => {
      expect(() => refuseRuleTag(body)).not.toThrow();
    });
  }
});

describe('priorityEventTenantId — the audit row is scoped to the PROJECT\'s tenant, or refused', () => {
  const CUSTOMER = 'e0000000-0000-4000-8000-0000000014b2';
  test('tagged project: its own keycloak_tenant_id', () => {
    expect(priorityEventTenantId({ project_data: { keycloak_tenant_id: CUSTOMER } })).toBe(CUSTOMER);
  });
  for (const pd of [null, {}, { keycloak_tenant_id: '' }, { keycloak_tenant_id: '  ' }, { keycloak_tenant_id: 7 }]) {
    test(`untagged project_data ${JSON.stringify(pd)}: FAILS CLOSED with 409 project_tenant_unknown (never a guessed tenant)`, () => {
      let err: AppError | undefined;
      let got: unknown;
      try {
        got = priorityEventTenantId({ project_data: pd });
      } catch (e) {
        err = e as AppError;
      }
      expect(got).toBeUndefined();
      expect(err?.statusCode).toBe(409);
      expect(err?.code).toBe(PROJECT_TENANT_UNKNOWN);
      expect(PROJECT_TENANT_UNKNOWN).toBe('project_tenant_unknown');
    });
  }
});
