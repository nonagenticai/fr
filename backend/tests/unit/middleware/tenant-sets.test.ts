// tests/unit/middleware/tenant-sets.test.ts
//
// Pins the EXACT contents of fr's three tenant sets. They differ on purpose
// (see the comment block above PLATFORM_TENANT_IDS in
// src/middleware/internal-tenant-only.ts):
//   INTERNAL_TENANT_IDS  (2) — system + kata (migration 228); the 3 improvement
//                              tenants were deleted 2026-11-03
//   isRepoPlatformTenant (2) — system + EXECUTION (coding-github refuses the AA
//                              conveyor tenant for platform repos and does not
//                              hold kata)
//   PLATFORM_TENANT_IDS  (5) — system + kata + EXECUTION + the AA conveyor
//                              tenant + the v4 conveyor tenant (George 10-14)
// A change to any of them must be deliberate and must edit this file.

import { test, expect } from 'bun:test';
import {
  AA_CONVEYOR_TENANT_ID,
  V4_CONVEYOR_TENANT_ID,
  KATA_TENANT_ID,
  INTERNAL_TENANT_IDS,
  PLATFORM_TENANT_IDS,
  isPlatformTenant,
} from '../../../src/middleware/internal-tenant-only';
import * as systemUnion from '../../../src/routes/assets/_lib/system-union';
import { isRepoPlatformTenant } from '../../../src/services/repo-access';

const SYSTEM = '0195f48b-d000-7000-8000-000000000001';
// The three improvement tenants deleted 2026-11-03: in no set.
const WORKFLOW = '0195f48b-d000-7000-8000-000000000002';
const EXECUTION = '0195f48b-d000-7000-8000-000000000003';
const PROMPT = '0195f48b-d000-7000-8000-000000000004';
const PROCEDURE = '0195f48b-d000-7000-8000-000000000005';
const AA_CONVEYOR = '019de842-c92a-7e37-8fdd-eb0d8c5396f9';
const V4_CONVEYOR = '5f868d42-03f8-51f0-a93c-3e83070dc196';
const KATA = '0195f48b-d000-7000-8000-000000000006';
const CUSTOMER = 'e0000000-0000-4000-8000-00000000c0de';

const sorted = (xs: Iterable<string>) => [...xs].sort();

test('INTERNAL_TENANT_IDS is exactly system + kata', () => {
  expect(KATA_TENANT_ID).toBe(KATA);
  expect(sorted(INTERNAL_TENANT_IDS)).toEqual(sorted([SYSTEM, KATA]));
  expect((INTERNAL_TENANT_IDS as readonly string[]).includes(V4_CONVEYOR)).toBe(false);
});

test('isRepoPlatformTenant is exactly system + EXECUTION — NOT either conveyor tenant, NOT kata, nor a deleted tenant', () => {
  const candidates = [SYSTEM, WORKFLOW, EXECUTION, PROMPT, PROCEDURE, KATA, AA_CONVEYOR, V4_CONVEYOR, CUSTOMER];
  expect(sorted(candidates.filter((t) => isRepoPlatformTenant(t)))).toEqual(
    sorted([SYSTEM, EXECUTION]),
  );
  expect(isRepoPlatformTenant(AA_CONVEYOR)).toBe(false);
  expect(isRepoPlatformTenant(V4_CONVEYOR)).toBe(false);
  expect(isRepoPlatformTenant(KATA)).toBe(false);
  expect(isRepoPlatformTenant(null)).toBe(false);
});

test('PLATFORM_TENANT_IDS is exactly system + kata + EXECUTION + both conveyor tenants (5)', () => {
  expect(AA_CONVEYOR_TENANT_ID).toBe(AA_CONVEYOR);
  expect(V4_CONVEYOR_TENANT_ID).toBe(V4_CONVEYOR);
  expect(sorted(PLATFORM_TENANT_IDS)).toEqual(
    sorted([SYSTEM, KATA, EXECUTION, AA_CONVEYOR, V4_CONVEYOR]),
  );
  for (const t of PLATFORM_TENANT_IDS) expect(isPlatformTenant(t)).toBe(true);
  expect(isPlatformTenant(CUSTOMER)).toBe(false);
  for (const t of [WORKFLOW, PROMPT, PROCEDURE]) expect(isPlatformTenant(t)).toBe(false);
  expect(isPlatformTenant(null)).toBe(false);
  expect(isPlatformTenant(undefined)).toBe(false);
});

test('system-union re-exports the SAME objects (a pure move)', () => {
  expect(systemUnion.PLATFORM_TENANT_IDS).toBe(PLATFORM_TENANT_IDS);
  expect(systemUnion.isPlatformTenant).toBe(isPlatformTenant);
  expect(systemUnion.AA_CONVEYOR_TENANT_ID).toBe(AA_CONVEYOR_TENANT_ID);
});
