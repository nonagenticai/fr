// Project type → tenant pin (George 2026-09-28; the three improvement tenants and
// their kaizen / meta_prompt / meta_procedure types were deleted 2026-11-03).
// program / it / feature live in EXECUTION (…0003) or a customer's own tenant
// (fr#1476: `feature` mapped, the never-written test / dev / demo dropped).
// The map is TENANCY POLICY keyed by type NAME (design: fr consumes RM vocabulary —
// which types exist is the tenant's RM catalogue). SYSTEM (…0001) owns exactly `system_ops` (movies-73 2026-10-08,
// George-approved system projects), which no other tenant accepts. Refusal =
// 400 `project_type_tenant_mismatch`.

import { describe, expect, test } from 'bun:test';

import {
  PROJECT_TYPE_TENANT,
  ProjectCreateError,
  assertProjectTypeTenant,
  projectTypeCreatableOn,
  projectTypeTenant,
  shouldOrchestrateProjectStart,
} from '../../../src/routes/projects';

// Literal on purpose: the ids must not be derived from the constants under
// test, or re-homing a constant would silently re-home the assertion.
const SYSTEM = '0195f48b-d000-7000-8000-000000000001';
const EXEC = '0195f48b-d000-7000-8000-000000000003';
const KATA = '0195f48b-d000-7000-8000-000000000006';
const CUSTOMER = '0195f48b-d000-7000-8000-000000000100';
const ALL = [SYSTEM, EXEC, KATA, CUSTOMER];

const EXPECTED: Record<string, string> = {
  system_ops: SYSTEM,
  program: EXEC,
  it: EXEC,
  feature: EXEC,
  // The kata tenant (migration 228) holds every kata project, and only kata projects.
  kata: KATA,
};

function refusal(projectType: string | undefined, tenant: string): ProjectCreateError | undefined {
  try {
    assertProjectTypeTenant(projectType, tenant);
    return undefined;
  } catch (e) {
    return e as ProjectCreateError;
  }
}

function expectRefused(projectType: string | undefined, tenant: string, expected: string | null) {
  const err = refusal(projectType, tenant);
  expect(err).toBeInstanceOf(ProjectCreateError);
  expect(err!.httpStatus).toBe(400);
  expect(err!.payload.error).toBe('project_type_tenant_mismatch');
  expect(err!.payload.expected_tenant_id).toBe(expected);
  expect(err!.payload.active_tenant_id).toBe(tenant);
}

describe('PROJECT_TYPE_TENANT', () => {
  test('it pins exactly these five type names (literal on purpose)', () => {
    expect(Object.keys(PROJECT_TYPE_TENANT).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test('a type name the map does not know is unpinned (RM decides whether it exists)', () => {
    expect(projectTypeTenant('bug_hunt_fix')).toBeUndefined();
    expect(refusal('bug_hunt_fix', EXEC)).toBeUndefined();
    expect(refusal('bug_hunt_fix', CUSTOMER)).toBeUndefined();
  });

  test('`feature` resolves to the EXEC tenant (fr#1476 acceptance)', () => {
    expect(projectTypeTenant('feature')).toBe(EXEC);
    expect(refusal('feature', EXEC)).toBeUndefined();
  });

  test('test / dev / demo are gone — unmapped, so no tenant', () => {
    for (const t of ['test', 'dev', 'demo']) expect(projectTypeTenant(t)).toBeUndefined();
  });

  test('is exactly the map (only system_ops maps to SYSTEM)', () => {
    expect({ ...PROJECT_TYPE_TENANT }).toEqual(EXPECTED);
    expect(
      Object.entries(PROJECT_TYPE_TENANT)
        .filter(([, t]) => t === SYSTEM)
        .map(([k]) => k),
    ).toEqual(['system_ops']);
  });
});

describe('assertProjectTypeTenant — every mapped type, every canonical tenant', () => {
  for (const [type, home] of Object.entries(EXPECTED)) {
    test(`${type} on its own tenant ${home} → allowed`, () => {
      expect(refusal(type, home)).toBeUndefined();
    });
    for (const tenant of ALL.filter((t) => t !== home)) {
      const customerOk = home === EXEC && tenant === CUSTOMER;
      test(`${type} on ${tenant} → ${customerOk ? "allowed (customer's own)" : '400 mismatch'}`, () => {
        if (customerOk) expect(refusal(type, tenant)).toBeUndefined();
        else expectRefused(type, tenant, home);
      });
    }
  }
});

describe('assertProjectTypeTenant — unmapped / absent types', () => {
  for (const type of ['analysis', 'toString', undefined]) {
    test(`${String(type)} → refused on SYSTEM and KATA`, () => {
      for (const tenant of [SYSTEM, KATA]) {
        expectRefused(type, tenant, null);
      }
    });
    test(`${String(type)} → allowed on EXECUTION and a customer tenant`, () => {
      expect(refusal(type, EXEC)).toBeUndefined();
      expect(refusal(type, CUSTOMER)).toBeUndefined();
    });
  }

  test('the refusal names what the tenant does accept', () => {
    expect(String(refusal(undefined, SYSTEM)!.payload.message)).toContain('system_ops');
  });
});

// The SAME rule the type picker (`startable` in GET /api/conveyor/project-types) and the
// agent's conveyor.list_project_types publish. Until 2026-11-07 the picker keyed on the
// phase list alone, so the conveyor workspace OFFERED `kata` and create answered 400.
describe('projectTypeCreatableOn — one rule, published as `startable`', () => {
  test('kata is not creatable in the conveyor (EXEC) workspace', () => {
    expect(projectTypeCreatableOn('kata', EXEC)).toBe(false);
    expect(projectTypeCreatableOn('kata', KATA)).toBe(true);
    expect(projectTypeCreatableOn('kata', CUSTOMER)).toBe(false);
    expect(projectTypeCreatableOn('kata', SYSTEM)).toBe(false);
  });

  test('it / feature / program are creatable in EXECUTION and in a customer tenant', () => {
    for (const type of ['it', 'feature', 'program']) {
      expect(projectTypeCreatableOn(type, EXEC)).toBe(true);
      expect(projectTypeCreatableOn(type, CUSTOMER)).toBe(true);
      expect(projectTypeCreatableOn(type, KATA)).toBe(false);
      expect(projectTypeCreatableOn(type, SYSTEM)).toBe(false);
    }
  });

  test('agrees with assertProjectTypeTenant for every type on every tenant', () => {
    for (const type of [...Object.keys(EXPECTED), 'bug_hunt_fix', 'analysis', undefined]) {
      for (const tenant of ALL) {
        expect(refusal(type, tenant) === undefined).toBe(projectTypeCreatableOn(type, tenant));
      }
    }
  });
});

describe('system_ops — SYSTEM only, both directions (movies-73 2026-10-08)', () => {
  test('allowed on SYSTEM', () => {
    expect(refusal('system_ops', SYSTEM)).toBeUndefined();
  });
  test('refused on EXEC, KATA and a customer — expected SYSTEM', () => {
    for (const t of [EXEC, KATA, CUSTOMER]) expectRefused('system_ops', t, SYSTEM);
  });
  test('every other mapped type is still refused on SYSTEM', () => {
    for (const [type, home] of Object.entries(EXPECTED)) {
      if (type === 'system_ops') continue;
      expectRefused(type, SYSTEM, home);
    }
  });
});

describe('system_ops never orchestrates', () => {
  test('false on every tenant, even it-style flags', () => {
    for (const tenantId of ALL) {
      for (const cveSweep of [undefined, false, true]) {
        expect(
          shouldOrchestrateProjectStart({ projectType: 'system_ops', cveSweep, tenantId, execTenantId: EXEC }),
        ).toBe(false);
      }
    }
  });
  test('control: an EXEC project of another type still orchestrates', () => {
    expect(
      shouldOrchestrateProjectStart({ projectType: 'it', cveSweep: false, tenantId: EXEC, execTenantId: EXEC }),
    ).toBe(true);
  });
});

// (assertSystemOpsCreator is gone — v4: system_ops has no `setup` phase and
// cannot start a project; POST /api/projects answers 422 project_type_not_startable.)
