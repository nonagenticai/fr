// tests/unit/middleware/tenant-sets.test.ts
//
// Pins HOW fr's three tenant sets relate — not a frozen literal inventory.
// The ids are environment-supplied (`FR_*_TENANT_ID`, read through
// src/lib/tenant-config.ts), so this file asserts the invariants that must
// hold for ANY configured environment:
//
//   internalTenantIds()   = system + kata
//   isRepoPlatformTenant  = system + execution (kata excluded: coding-github's
//                           set does not hold it and a kata project carries no
//                           repository; both conveyors excluded: coding-github
//                           refuses them for platform repos)
//   platformTenantIds()   = internal + execution + both conveyor tenants
//
// The relationships pinned:
//   * internal ⊆ platform
//   * execution and both conveyors are in platform, NOT in internal
//   * canonicalTenantNames() names exactly the configured canonical roles
//   * an unset role vanishes from every set (fail closed), never falling back
// A change to any relationship must be deliberate and must edit this file.

import { describe, test, expect } from 'bun:test';
import {
  aaConveyorTenantId,
  canonicalTenantNames,
  executionTenantId,
  internalSystemTenantId,
  internalTenantIds,
  kataTenantId,
  platformTenantIds,
  v4ConveyorTenantId,
  isPlatformTenant,
} from '../../../src/middleware/internal-tenant-only';
import * as systemUnion from '../../../src/routes/assets/_lib/system-union';
import { isRepoPlatformTenant } from '../../../src/services/repo-access';

// tests/setup-env.ts (the preload) sets these synthetic ids; asserting the
// literals here binds the accessors to the environment the tests run under.
const SYSTEM = 'aaaaaaaa-0000-4000-8000-000000000001';
const EXECUTION = 'aaaaaaaa-0000-4000-8000-000000000003';
const KATA = 'aaaaaaaa-0000-4000-8000-000000000006';
const AA_CONVEYOR = 'aaaaaaaa-0000-4000-8000-0000000000a5';
const V4_CONVEYOR = 'aaaaaaaa-0000-4000-8000-0000000000a6';
// The three improvement tenants deleted 2026-11-03, plus an ordinary customer
// id: none of them may appear in any set.
const DELETED = [
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000004',
  'aaaaaaaa-0000-4000-8000-000000000005',
];
const CUSTOMER = 'e0000000-0000-4000-8000-00000000c0de';

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('the accessors read the configured roles', () => {
  test('each single-role accessor returns its FR_*_TENANT_ID', () => {
    expect(internalSystemTenantId()).toBe(SYSTEM);
    expect(executionTenantId()).toBe(EXECUTION);
    expect(kataTenantId()).toBe(KATA);
    expect(aaConveyorTenantId()).toBe(AA_CONVEYOR);
    expect(v4ConveyorTenantId()).toBe(V4_CONVEYOR);
  });
});

describe('internalTenantIds() and platformTenantIds()', () => {
  test('internalTenantIds() is exactly system + kata', () => {
    expect(sorted(internalTenantIds())).toEqual(sorted([SYSTEM, KATA]));
  });

  test('platformTenantIds() is exactly internal + execution + both conveyors', () => {
    expect(platformTenantIds()).toEqual(
      new Set([SYSTEM, KATA, EXECUTION, AA_CONVEYOR, V4_CONVEYOR]),
    );
  });

  test('internal ⊆ platform; execution and both conveyors are platform but NOT internal', () => {
    const platform = platformTenantIds();
    for (const t of internalTenantIds()) expect(platform.has(t)).toBe(true);
    for (const t of [EXECUTION, AA_CONVEYOR, V4_CONVEYOR]) {
      expect(platform.has(t)).toBe(true);
      expect(internalTenantIds()).not.toContain(t);
    }
  });

  test('isPlatformTenant agrees with platformTenantIds() and refuses everything else', () => {
    for (const t of platformTenantIds()) expect(isPlatformTenant(t)).toBe(true);
    for (const t of [...DELETED, CUSTOMER]) expect(isPlatformTenant(t)).toBe(false);
    expect(isPlatformTenant(null)).toBe(false);
    expect(isPlatformTenant(undefined)).toBe(false);
  });
});

describe('isRepoPlatformTenant — the narrower gate', () => {
  test('admits exactly system + execution', () => {
    const candidates = [SYSTEM, ...DELETED, EXECUTION, KATA, AA_CONVEYOR, V4_CONVEYOR, CUSTOMER];
    expect(sorted(candidates.filter((t) => isRepoPlatformTenant(t)))).toEqual(
      sorted([SYSTEM, EXECUTION]),
    );
  });

  test('refuses kata and both conveyors even though they are in platformTenantIds()', () => {
    for (const t of [KATA, AA_CONVEYOR, V4_CONVEYOR]) {
      expect(platformTenantIds().has(t)).toBe(true);
      expect(isRepoPlatformTenant(t)).toBe(false);
    }
    expect(isRepoPlatformTenant(null)).toBe(false);
  });
});

describe('canonicalTenantNames()', () => {
  test('names exactly the three configured canonical roles, and nothing else', () => {
    expect(canonicalTenantNames()).toEqual({
      [SYSTEM]: 'system',
      [EXECUTION]: 'execution',
      [KATA]: 'kata',
    });
    for (const t of [AA_CONVEYOR, V4_CONVEYOR, ...DELETED, CUSTOMER]) {
      expect(canonicalTenantNames()[t]).toBeUndefined();
    }
  });
});

describe('system-union re-exports the SAME accessors (a pure move)', () => {
  test('identity, not equal-looking copies', () => {
    expect(systemUnion.platformTenantIds).toBe(platformTenantIds);
    expect(systemUnion.aaConveyorTenantId).toBe(aaConveyorTenantId);
    expect(systemUnion.isPlatformTenant).toBe(isPlatformTenant);
  });
});

describe('fail closed: an unset role vanishes from every set', () => {
  test('unset ⇒ undefined accessor, empty sets, no names (env restored)', () => {
    // Every FR_*_TENANT_ID the preload configured — found rather than listed, so
    // this also restores any role added later.
    const names = Object.keys(process.env).filter(
      (k) => k.startsWith('FR_') && k.endsWith('_TENANT_ID'),
    );
    const saved = names.map((n) => [n, process.env[n]] as const);
    try {
      for (const n of names) delete process.env[n];
      expect(internalSystemTenantId()).toBeUndefined();
      expect(executionTenantId()).toBeUndefined();
      expect(kataTenantId()).toBeUndefined();
      expect(aaConveyorTenantId()).toBeUndefined();
      expect(v4ConveyorTenantId()).toBeUndefined();
      expect(internalTenantIds()).toEqual([]);
      expect(platformTenantIds()).toEqual(new Set());
      expect(canonicalTenantNames()).toEqual({});
      expect(isPlatformTenant(SYSTEM)).toBe(false);
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });
});
