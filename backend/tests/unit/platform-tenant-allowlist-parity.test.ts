// tests/unit/platform-tenant-allowlist-parity.test.ts
//
// ⛔ CROSS-REPO CONTRACT GUARD. Two services decide "is this tenant a PLATFORM
// tenant?" from two independently-overridable configs, and until this file
// existed nothing bound them equal:
//
//   fr             — `src/middleware/internal-tenant-only.ts`: the four
//                    `INTERNAL_TENANT_IDS` plus `EXECUTION_TENANT_ID`.
//                    `services/repo-access.ts` (`internalCaller`) admits
//                    exactly that union to the clone-token minting branch for a
//                    platform-owned (`nonagenticai`) repo.
//   coding-github  — `CODING_GITHUB_PLATFORM_TENANTS`, parsed by
//                    `src/config/settings.py` `parse_platform_tenants` and
//                    applied by `src/services/tenant_binding.py`
//                    `is_platform_tenant` / `check_platform_repo_tenant`.
//
// WHY IT MATTERS NOW. `CODING_GITHUB_PLATFORM_TENANT_ENFORCE` is currently OFF
// (observe): a non-platform tenant gets a WARNING carrying
// `platform_repo_tenant_gate decision=would_refuse` and is still served. The
// moment that flag flips the gate RAISES. So a drift between the two lists is
// silent today and load-bearing the second the flag moves:
//
//   * fr admits a tenant coding-github does not  → real work starts getting
//     refused (`platform_repo_forbidden`) with no grant that can fix it.
//   * coding-github admits a tenant fr does not  → worse, and silent: a
//     workspace fr does not consider platform can still mint a credential on a
//     platform-owned repository.
//
// ── EXACTLY WHAT THIS FILE CATCHES, AND WHAT IT DOES NOT ────────────────────
//
// ⛔ It catches **fr-side edits ONLY**. It cannot catch cross-repo drift, and
// nothing should read it as if it could. `CODING_GITHUB_PLATFORM_TENANTS`
// appears in this repository at eleven sites and EVERY ONE IS A COMMENT; fr's
// CI checks out no second repository. So an edit made entirely on the
// coding-github side — the `range(1, 6)` → `range(1, 7)` shape described below
// — leaves this file green by construction.
//
// ⚠️ AND THE OTHER SIDE DOES NOT CATCH IT EITHER. coding-github does pin its
// own set, at `tests/unit/test_tenant_repo_token.py:784`, but it re-derives the
// expectation with the SAME generator shape it is testing:
//
//     assert ids == frozenset(
//         f"0195f48b-d000-7000-8000-00000000000{i}" for i in range(1, 6))
//
// so it reds a lone `settings.py` edit and goes GREEN on a repo-wide
// `range(1, 6)` → `range(1, 7)` that touches the test and the setting together.
// It also never names fr. **State it plainly: the cross-repo direction is
// guarded by NOBODY today, on either side.** Closing it needs a check that
// reads both repos — a CI job that checks out both, or a shared artefact — and
// that does not exist. This file narrows the hole; it does not close it.
//
// This test pins the admitted set as LITERALS rather than reading it from a
// shared source, because fr has NO real source to read: fr's own environment
// carries `FR_CODING_GITHUB_URL` and `FR_CODING_GITHUB_TOKEN` only — never
// `CODING_GITHUB_PLATFORM_TENANTS`, which is coding-github's own setting — and
// coding-github is a different repo that is not checked out in fr's CI. A
// literal pin is therefore the strongest binding available from inside fr.
//
// ⚠️ Changing the platform-tenant set is a THREE-place edit. Change all three
// in the same change window or the flag flip refuses real work:
//
//   1. fr           — `src/middleware/internal-tenant-only.ts`: BOTH the
//                     `INTERNAL_TENANT_IDS` array AND the `isInternalTenant`
//                     predicate (they are two parallel enumerations — see
//                     `frAdmitsPlatformTenant` below), plus `EXECUTION_TENANT_ID`
//                     and `PLATFORM_TENANTS_PINNED` here.
//   2. coding-github — `src/config/settings.py:32` `DEFAULT_PLATFORM_TENANTS`.
//                     ⚠️ It is NOT a literal list: it is generated as
//                     `",".join(f"0195f48b-d000-7000-8000-00000000000{i}"
//                     for i in range(1, 6))`, so a change to that RANGE moves
//                     the set with no UUID visible in the diff.
//   3. deployment — `CODING_GITHUB_PLATFORM_TENANTS` in coding-github's
//                     deployment env. ⚠️ It is set NOWHERE today — not on the
//                     Deployment, not in the `coding-github-env` secretRef
//                     (measured in-container 2026-09-22: 22 `CODING_GITHUB_*`
//                     vars, zero `PLATFORM_TENANT`), and not in gitops
//                     `origin/main`. So `settings.py` is the live value right
//                     now. This env var WILL BECOME the declared source of
//                     truth, overriding (2) at runtime, once something declares
//                     it — and from that moment a cluster-only edit can drift
//                     from both repos without touching either. Until then there
//                     is nothing here to keep in step.
//
// A guard that only ever passes is decoration. Two kinds of control run below:
// the parity assertions drive fr's REAL admission predicate (not a copy of its
// inputs), and the bottom block drives the comparison function itself against
// mutated sets and requires it to REJECT them.

import { describe, test, expect } from 'bun:test';
import {
  EXECUTION_TENANT_ID,
  INTERNAL_TENANT_IDS,
  INTERNAL_SYSTEM_TENANT_ID,
  KATA_TENANT_ID,
  isInternalTenant,
} from '../../src/middleware/internal-tenant-only';
import { isRepoPlatformTenant } from '../../src/services/repo-access';

/**
 * The five UUIDs coding-github is configured to accept, spelled out. Kept as
 * literals ON PURPOSE: a silent edit to fr's constants must red CI, and it
 * cannot if this list is derived from the very constants under test.
 *
 * Source: coding-github `src/config/settings.py:32` DEFAULT_PLATFORM_TENANTS,
 * and `CODING_GITHUB_PLATFORM_TENANTS` in coding-github's gitops deployment
 * env. See the file header — all three places change together.
 */
const PLATFORM_TENANTS_PINNED = [
  '0195f48b-d000-7000-8000-000000000001', // system
  '0195f48b-d000-7000-8000-000000000002', // workflow-improvement
  '0195f48b-d000-7000-8000-000000000003', // execution (the conveyor)
  '0195f48b-d000-7000-8000-000000000004', // prompt-improvement
  '0195f48b-d000-7000-8000-000000000005', // procedure-improvement
] as const;

/**
 * ⭐ 2026-11-03 (kata-super-admin §7): fr deleted the three improvement tenants
 * (…0002 / …0004 / …0005), so fr now admits only system + execution. Per the
 * design's "not fanned out" rule coding-github keeps its five: the three extra
 * ids name tenants that hold no data in fr. fr is therefore a STRICT SUBSET of
 * coding-github, and the difference is pinned to exactly the three deleted ids
 * — any other drift still reds.
 */
const FR_PLATFORM_TENANTS_PINNED = [
  '0195f48b-d000-7000-8000-000000000001', // system
  '0195f48b-d000-7000-8000-000000000003', // execution (the conveyor)
] as const;
const DELETED_IMPROVEMENT_TENANTS = [
  '0195f48b-d000-7000-8000-000000000002',
  '0195f48b-d000-7000-8000-000000000004',
  '0195f48b-d000-7000-8000-000000000005',
] as const;

/**
 * fr's REAL admission decision, byte-for-byte the expression the enforcement
 * path evaluates at `services/repo-access.ts:340-341`:
 *
 *     const internalCaller =
 *       isInternalTenant(scope.tenantId ?? undefined) ||
 *       scope.tenantId === EXECUTION_TENANT_ID;
 *
 * ⛔ THIS IS THE POINT OF THE FILE, AND THE EARLIER VERSION GOT IT WRONG.
 * `FR_ADMITTED` used to be spread from the `INTERNAL_TENANT_IDS` **array**
 * while `repo-access.ts` calls the **function** — and `isInternalTenant`
 * (`internal-tenant-only.ts:103-110`) does NOT iterate that array. It hardcodes
 * four `===` comparisons. They were two parallel enumerations with nothing
 * binding them, so the assertion carrying this file's headline compared the
 * array against a literal while the predicate that actually gates credential
 * minting was never evaluated at all. Measured, on the pre-fix file:
 *
 *   * drop the `INTERNAL_PROCEDURE_TENANT_ID` clause from the PREDICATE and
 *     leave the array alone → 18 pass / 1 fail, and the single failure was the
 *     behavioural `…0005` case. The parity assertion stayed GREEN while fr had
 *     stopped admitting one of the five.
 *   * widen the PREDICATE with `…0007` → 19 pass / 0 fail. Nothing red at all,
 *     while fr admitted a tenant coding-github does not — the exact direction
 *     this guard exists to stop, and the silent one.
 *
 * The `tenantId is InternalTenantId` type predicate does not help: TypeScript
 * never checks a predicate's BODY against its declared type, so the declaration
 * is an assertion by the author, not a proof. Only driving the function does.
 */
//
// ⭐ UPDATED 2026-09-30: the expression is now ONE exported function,
// `isRepoPlatformTenant` (services/repo-access.ts), which `assessRepoAccess`
// AND the platform-repo ownership gate (`platformRepoRefusals`) both call. This
// drives THAT function, so the parity below measures the enforcement code, not a
// copy of it.
function frAdmitsPlatformTenant(tenantId: string | undefined): boolean {
  return isRepoPlatformTenant(tenantId);
}

/** A uuid in fr's reserved `0195f48b-d000-7000-8000-*` workspace namespace. */
const reservedNamespaceId = (slot: number): string =>
  `0195f48b-d000-7000-8000-${slot.toString(16).padStart(12, '0')}`;

/**
 * Every tenant id the parity assertion interrogates the REAL predicate with.
 *
 * It must be wider than the five, or a WIDENING is invisible: a set built only
 * from the five can never grow. So it sweeps the whole low end of the reserved
 * namespace (slots 0x0–0xf — a `range()` edit on either side lands here, and
 * that is the drift shape with no UUID in the diff), plus off-namespace probes
 * and UPPER-CASED spellings of the five, which `===` must refuse.
 *
 * ⚠️ Honest about its limit: this is a sweep, not a proof of exhaustion. A
 * widening to some arbitrary uuid outside both the namespace and this list
 * still passes. Bounding that needs the predicate to be derived from the array
 * rather than duplicating it — a source change, out of scope here.
 */
const PARITY_PROBES: readonly string[] = [
  ...Array.from({ length: 16 }, (_, slot) => reservedNamespaceId(slot)),
  '7c9e6679-7425-40de-944b-e07fc1f90ae7', // a real customer-shaped tenant
  '00000000-0000-0000-0000-000000000000', // the nil uuid
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ...PLATFORM_TENANTS_PINNED.map((t) => t.toUpperCase()),
];

/**
 * The set fr actually admits — computed by asking the REAL predicate about
 * every probe, exactly as `repo-access.ts` asks it about a live caller. Nothing
 * here reads `INTERNAL_TENANT_IDS`, so narrowing OR widening the predicate
 * changes this array and reds the parity assertion below.
 */
const FR_ADMITTED: readonly string[] = PARITY_PROBES.filter((t) => frAdmitsPlatformTenant(t));

/**
 * The tenants the predicate must REFUSE: every probe that is not one of the
 * pinned five. Asserted explicitly as well as via the set comparison, so a
 * widening names the offending uuid in the failure output.
 */
const FR_MUST_REFUSE: readonly string[] = PARITY_PROBES.filter(
  (t) => !(FR_PLATFORM_TENANTS_PINNED as readonly string[]).includes(t),
);

/**
 * The comparison every assertion in this file makes — order-insensitive,
 * duplicate-insensitive, exact on membership. Factored out so the negative
 * controls can drive THIS function (not a re-implementation of it) against
 * mutated inputs and prove it rejects them.
 */
function sameTenantSet(actual: readonly string[], expected: readonly string[]): boolean {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

describe('fr admits a strict subset of coding-github: exactly system + execution', () => {
  test('fr admits exactly system + execution', () => {
    expect(sameTenantSet(FR_ADMITTED, FR_PLATFORM_TENANTS_PINNED)).toBe(true);
  });

  test('coding-github minus fr is exactly the three deleted improvement tenants', () => {
    const extra = PLATFORM_TENANTS_PINNED.filter((t) => !FR_ADMITTED.includes(t));
    expect(sameTenantSet(extra, DELETED_IMPROVEMENT_TENANTS)).toBe(true);
    for (const t of FR_ADMITTED) expect((PLATFORM_TENANTS_PINNED as readonly string[]).includes(t)).toBe(true);
  });

  test('the real admission predicate ADMITS each pinned fr tenant', () => {
    for (const id of FR_PLATFORM_TENANTS_PINNED) {
      expect(frAdmitsPlatformTenant(id)).toBe(true);
    }
  });

  test('the real admission predicate REFUSES every other probe, the deleted three included', () => {
    for (const id of FR_MUST_REFUSE) {
      expect(frAdmitsPlatformTenant(id)).toBe(false);
    }
    for (const id of DELETED_IMPROVEMENT_TENANTS) expect(frAdmitsPlatformTenant(id)).toBe(false);
  });

  // `INTERNAL_TENANT_IDS` and `isInternalTenant` are two hand-maintained
  // enumerations; this drives both over the same probes.
  test('INTERNAL_TENANT_IDS and isInternalTenant enumerate the SAME tenants', () => {
    const byPredicate = PARITY_PROBES.filter((t) => isInternalTenant(t)).sort();
    expect(byPredicate).toEqual([...INTERNAL_TENANT_IDS].sort());
  });

  // The kata tenant (migration 228, …0006) is INTERNAL but deliberately NOT repo-platform:
  // coding-github's set does not hold it, so admitting it would be the silent widening direction.
  test('the set is system (+ kata, internal but not repo-platform) + the execution tenant, and no more', () => {
    expect([...INTERNAL_TENANT_IDS]).toEqual([INTERNAL_SYSTEM_TENANT_ID, KATA_TENANT_ID]);
    expect(frAdmitsPlatformTenant(KATA_TENANT_ID)).toBe(false);
    expect(INTERNAL_TENANT_IDS).not.toContain(EXECUTION_TENANT_ID);
    expect(FR_ADMITTED).toHaveLength(2);
  });

  // coding-github normalises every entry through `uuid.UUID(...)` → `str(...)`,
  // which yields CANONICAL LOWERCASE. fr compares with `===`. So an
  // upper-cased constant on the fr side would be admitted by coding-github and
  // refused by fr — a drift with no list change at all.
  test('fr spells its tenants in the canonical lowercase form coding-github normalises to', () => {
    for (const id of FR_ADMITTED) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(id).toBe(id.toLowerCase());
    }
  });
});

// ── NEGATIVE CONTROLS ON THE GUARD ITSELF ───────────────────────────────────
//
// `sameTenantSet` is the comparison every assertion above rests on. If it
// returned true unconditionally — or compared lengths only, or compared after
// a case fold — the whole file would be theatre and would still be green.
// These drive THAT function against deliberately mutated copies of the pinned
// set and require a REJECT. Each one is a drift shape that has a plausible
// cause, not an arbitrary string.
describe('negative control: the parity assertion rejects a drifted set', () => {
  const mutations: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['one tenant REMOVED', FR_PLATFORM_TENANTS_PINNED.slice(0, 1)],
    ['a deleted tenant ADDED back', [...FR_PLATFORM_TENANTS_PINNED, DELETED_IMPROVEMENT_TENANTS[0]]],
    ['one digit CHANGED', [FR_PLATFORM_TENANTS_PINNED[0], '0195f48b-d000-7000-8000-000000000006']],
    ['one entry UPPER-CASED', [FR_PLATFORM_TENANTS_PINNED[0], FR_PLATFORM_TENANTS_PINNED[1].toUpperCase()]],
    ['execution SWAPPED for a duplicate (dedups to 1)', [FR_PLATFORM_TENANTS_PINNED[0], FR_PLATFORM_TENANTS_PINNED[0]]],
    ['the empty set', []],
  ];

  test.each(mutations)('%s is REJECTED', (_name, drifted) => {
    expect(sameTenantSet(FR_ADMITTED, drifted)).toBe(false);
  });

  // ...and the same comparison still accepts a merely REORDERED set, so the
  // rejections above are about membership, not about incidental ordering.
  test('a reordered but identical set is ACCEPTED', () => {
    expect(sameTenantSet(FR_ADMITTED, [...FR_PLATFORM_TENANTS_PINNED].reverse())).toBe(true);
  });
});

// ── COMPILE-TIME BINDING ON THE TYPE PREDICATE ──────────────────────────────
//
// `isInternalTenant` is declared `tenantId is InternalTenantId`. tsc does not
// verify that claim against the function BODY — so the declaration alone is
// worth nothing at runtime, which is why the assertions above drive the
// function instead. tsc DOES check assignability here, though: if
// `InternalTenantId` is ever retyped wider than the members of
// `INTERNAL_TENANT_IDS`, or the array and the type part company, `bun run
// typecheck` stops compiling. That is the one half of the binding a test
// cannot express.
function _narrowedTenantIsAnArrayMember(
  id: string,
): (typeof INTERNAL_TENANT_IDS)[number] | null {
  return isInternalTenant(id) ? id : null;
}

test('the type predicate narrows to a member of INTERNAL_TENANT_IDS (compile-time)', () => {
  expect(_narrowedTenantIsAnArrayMember(INTERNAL_SYSTEM_TENANT_ID)).toBe(INTERNAL_SYSTEM_TENANT_ID);
  expect(_narrowedTenantIsAnArrayMember(EXECUTION_TENANT_ID)).toBeNull();
});
