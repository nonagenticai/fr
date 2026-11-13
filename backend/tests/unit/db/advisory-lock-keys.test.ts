// tests/unit/db/advisory-lock-keys.test.ts
//
// Guards the integer advisory-lock registry in src/db/advisory-lock-keys.ts.
//
// The defect this exists to catch (measured on origin/main, 2026-09-05):
// `approval-expiry.ts` and `scheduled-trigger-run-prune.ts` BOTH declared
// `const ADVISORY_LOCK_KEY = 912350`. Both take it with
// `pg_try_advisory_xact_lock`, so whichever worker ticked first made the
// other's call return false; the loser then took its ordinary "another replica
// of me is already running" branch and skipped its whole tick. Silent — no
// throw, no log naming the cause, two unrelated workers serialising while both
// reported healthy.
//
// ⚠️ WHAT THIS FILE CANNOT SEE — do not read a green here as "no collision".
// Every assertion below reads `LOCK_KEYS` and nothing else, so it can only
// detect a duplicate BETWEEN REGISTERED OWNERS. A key declared outside the
// registry is invisible to it: open PR #921 adds
// `src/workers/approval-redelivery.ts` with an inline
// `const ADVISORY_LOCK_KEY = 912351;`, touching files disjoint from this
// branch, so both merge cleanly and main carries 912351 twice while all seven
// tests below stay green. That half is NOT guarded here.
//
// Hermetic: no database, no network. Reads the frozen object and nothing else.

import { describe, expect, test } from 'bun:test';

import { LOCK_KEYS } from '../../../src/db/advisory-lock-keys';

/** Every owner that must be registered, with its exact key.
 *
 *  Stated here as literals ON PURPOSE, and this is the only place in the
 *  backend that is allowed to restate them. A silent renumber in the source
 *  registry reddens this table instead of sliding through — which is the
 *  property `tests/unit/workers/idempotency-sweep.test.ts` used to hold with
 *  its own hand-copied `912349`, before that literal became the last surviving
 *  instance of the very copy-paste that caused the collision. */
const EXPECTED: Record<string, number> = {
  migrationRunner: 912347,
  analyticsRollup: 912348,
  idempotencySweep: 912349,
  approvalExpiry: 912350,
  // src/workers/approval-redelivery.ts. Was RESERVED here while PR #921 was
  // open, so a future author who saw "no consumer imports this" could not
  // quietly hand 912351 to something else; #921 has merged and the owner is real.
  approvalRedelivery: 912351,
  // MOVED off 912350 (the collision) and PAST 912351 (#921's claim).
  scheduledTriggerRunPrune: 912352,
  // src/workers/deblock-callback-redelivery.ts. ⚠️ This owner holds its key
  // ACROSS outbound HTTP, unlike every other entry — see the registry's own note.
  deblockCallbackRedelivery: 912353,
};

/** Kept as a named constant so the two length assertions below cannot drift
 *  apart from each other or from EXPECTED. */
const OWNER_COUNT = Object.keys(EXPECTED).length;

describe('advisory-lock key registry', () => {
  // A uniqueness assertion over an empty or 1-entry object passes vacuously.
  // Pin the population first, so deleting an entry reddens THIS test rather
  // than quietly shrinking the set the uniqueness check runs over.
  test('registers exactly the expected owners', () => {
    expect(Object.keys(LOCK_KEYS).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(LOCK_KEYS)).toHaveLength(OWNER_COUNT);
    expect(OWNER_COUNT).toBe(7);
  });

  test('every registered key has its expected value', () => {
    // Widened to Record<string, number>: `Object.freeze` over an object literal
    // gives each property a LITERAL type (912347, not number), so a directly
    // typed toEqual() compares against those literals and cannot fail.
    const actual: Record<string, number> = { ...LOCK_KEYS };
    expect(actual).toEqual(EXPECTED);
  });

  test('all keys are unique — the collision this registry exists to prevent', () => {
    const values = Object.values(LOCK_KEYS);
    expect(values).toHaveLength(OWNER_COUNT);
    expect(new Set(values).size).toBe(Object.keys(LOCK_KEYS).length);
  });

  test('approval-expiry and scheduled-trigger-run-prune no longer share a key', () => {
    // The specific regression. Named so a re-collision reads as itself.
    expect(LOCK_KEYS.approvalExpiry).not.toBe(LOCK_KEYS.scheduledTriggerRunPrune);
  });

  test("scheduled-trigger-run-prune does not sit on PR #921's 912351 either", () => {
    // The CROSS-BRANCH collision, which the first fix would have shipped: #921
    // and this branch touch disjoint files, so nothing would have conflicted.
    expect(LOCK_KEYS.scheduledTriggerRunPrune).not.toBe(LOCK_KEYS.approvalRedelivery);
    expect(LOCK_KEYS.approvalRedelivery).toBe(912351);
  });

  test('every key is a 32-bit signed integer', () => {
    // pg_try_advisory_xact_lock(int) takes int4; a value outside the range
    // errors at the database, per tick, in production only.
    for (const [owner, key] of Object.entries(LOCK_KEYS)) {
      expect(Number.isInteger(key), `${owner} must be an integer`).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  test('the registry is frozen', () => {
    expect(Object.isFrozen(LOCK_KEYS)).toBe(true);
  });
});
