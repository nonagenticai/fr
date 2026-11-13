// tests/unit/workers/deblock-scan-seed.test.ts
//
// Unit test for `seedScanOffset` ONLY — the wall-clock seed that makes the
// deblock re-delivery scan cursor restart-immune.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SUITE
// ---------------------------------------------------------
// The only other tests that touched this worker were the
// deblock-callback-redelivery integration suite (deleted 2026-10-29),
// which needed a live Postgres. So the arithmetic that decides whether the walk
// covers the population — the entire fix for "0 of 274 `voided` rows had EVER
// been delivered" — had no gate that can run without a database, and therefore
// no gate that can be mutation-verified locally. `seedScanOffset` is pure and
// exported precisely so it can be pinned here.
//
// NO DB IS TOUCHED. Importing the worker pulls in `src/db/client`, whose
// `postgres(config.database.url)` builds a LAZY pool — no socket is opened until
// a query runs, and nothing here runs one. src/workers/approval-expiry is
// another `db/client` importer with the same import shape.
//
// ⚠️ EVERY EXPECTATION BELOW IS A LITERAL, DELIBERATELY. Deriving it from
// MAX_READS_PER_RUN / SEED_TICK_MS would make the assertion self-cancelling: it
// would keep passing while the constants — and therefore the coverage the walk
// achieves — changed underneath it. The two constants are re-stated here as
// documentation, not as inputs to any expectation:
//
//   MAX_READS_PER_RUN = 40       (page size; the offset grid)
//   SEED_TICK_MS      = 900_000  (= DEFAULT_INTERVAL_MS, one page per tick)
//
// A change to either must turn this file RED. That is the point.
//
// THE ANCHOR VALUES, worked by hand:
//   nowMs 9_000_000_000 / 900_000            = 10_000 exactly (chosen so the
//                                              floor() is unambiguous)
//   candidateCount 594 -> ceil(594 / 40)     = 15 pages (the measured prod
//                                              population: approved 333 + voided 261)
//   10_000 % 15                              = 10        (15 * 666 = 9_990)
//   page 10 * 40                             = 400  <-- expected offset
//   one tick later: 10_001 % 15 = 11 -> 440
//   next tick:      10_002 % 15 = 12 -> 480

import { describe, expect, test } from 'bun:test';

import { seedScanOffset } from '../../../src/workers/deblock-callback-redelivery';

/** Divides 900_000 exactly, so `floor(now / SEED_TICK_MS)` is exactly 10_000. */
const T0 = 9_000_000_000;
/** One seed quantum (one worker interval) later. */
const T1 = 9_000_900_000;
/** Two seed quanta later. */
const T2 = 9_001_800_000;

/** Measured prod population, and NOT a clean multiple of 40 (594 = 14*40 + 34). */
const PROD_CANDIDATES = 594;

describe('seedScanOffset — the arithmetic is pinned', () => {
  // Proves the exact page the fleet clock selects. Kills the reverted
  // `let scanOffset = 0` (returns 0, expected 400) AND any silent change to
  // MAX_READS_PER_RUN or SEED_TICK_MS, because both are baked into the literal.
  test('a fixed clock and a fixed population yield one exact, hand-computed offset', () => {
    expect(seedScanOffset(T0, PROD_CANDIDATES)).toBe(400);
  });

  // Proves the offset lands on the SAME grid the sequential walk uses — the
  // page-aligned property. Kills a mutation to `% candidateCount` (which would
  // return 10_000 % 594 = 502, not a multiple of 40) or to `page * 1`.
  test('the offset is page-aligned, and consecutive quanta step by exactly one page', () => {
    expect(seedScanOffset(T0, PROD_CANDIDATES)).toBe(400);
    expect(seedScanOffset(T1, PROD_CANDIDATES)).toBe(440);
    expect(seedScanOffset(T2, PROD_CANDIDATES)).toBe(480);
    expect(seedScanOffset(T1, PROD_CANDIDATES) - seedScanOffset(T0, PROD_CANDIDATES)).toBe(40);
  });

  // Proves the quantum is 900_000 ms and not something finer: everything inside
  // one interval seeds identically. Kills a mutation that shrinks SEED_TICK_MS
  // (e.g. to 90_000), which the step-by-40 case above cannot see on its own —
  // that case only pins the step, this one pins the width.
  test('two clocks inside the same quantum seed identically', () => {
    expect(seedScanOffset(T0, PROD_CANDIDATES)).toBe(400);
    expect(seedScanOffset(T0 + 1, PROD_CANDIDATES)).toBe(400);
    expect(seedScanOffset(T0 + 899_999, PROD_CANDIDATES)).toBe(400);
    // ...and the very next millisecond is the next page.
    expect(seedScanOffset(T0 + 900_000, PROD_CANDIDATES)).toBe(440);
  });
});

describe('seedScanOffset — restart-immunity, the property the fix exists for', () => {
  // THE FIX ITSELF. A pod restarting a quantum later must NOT resume where the
  // previous one started. Kills the reverted fixed-0 cursor, which returns the
  // same value for every clock and is exactly the starvation that left 0 of 274
  // `voided` rows reachable.
  test('two clocks one quantum apart seed DIFFERENT offsets', () => {
    expect(seedScanOffset(T0, PROD_CANDIDATES)).not.toBe(seedScanOffset(T1, PROD_CANDIDATES));
  });

  // Proves the seed actually leaves the head of the population. A fixed-0
  // implementation passes every in-range check but fails this one.
  test('a clock well past the epoch does not seed page 0', () => {
    expect(seedScanOffset(T0, PROD_CANDIDATES)).not.toBe(0);
    // A second, independent clock, so the case does not rest on one lucky value.
    expect(seedScanOffset(T2, PROD_CANDIDATES)).not.toBe(0);
  });
});

describe('seedScanOffset — coverage and wrap', () => {
  // Proves the modulo cannot seed PAST the population: an out-of-range seed
  // would make `advanceScan` see a short scan and wrap straight to 0, i.e. the
  // no-op fix the docblock calls out (`floor(now/900_000)*40` = 79,496,920).
  // Kills removal of the `% pages` reduction. Includes a non-multiple-of-40
  // population (594, 101, 41) so an off-by-one page count is visible.
  test('every offset stays inside [0, candidateCount) across many clocks', () => {
    const populations = [PROD_CANDIDATES, 101, 41, 39, 1];
    let sawNonZero = false;
    for (const candidates of populations) {
      for (let q = 0; q < 25; q++) {
        const offset = seedScanOffset(T0 + q * 900_000, candidates);
        expect(Number.isFinite(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(candidates);
        // Page-aligned at every population size, not just the anchor one.
        expect(offset % 40).toBe(0);
        if (offset !== 0) sawNonZero = true;
      }
    }
    // Guards this case against passing under a fixed-0 implementation: an
    // in-range assertion alone is satisfied by 0, so the sweep must also
    // demonstrate the seed moves.
    expect(sawNonZero).toBe(true);
  });

  // Proves a population that fits in ONE page yields 0 — correct, not a special
  // case (`pages` is 1, `% 1` is 0): there is no tail to starve. Kills a
  // `Math.ceil` -> `Math.floor` mutation on the page count, which for 39 or 1
  // candidates gives 0 pages and makes the reduction `% 0` = NaN — caught below
  // by the 39 and 1 rows, not by the 40 row (floor(40/40) is still 1).
  test('a single-page population always seeds 0, at any clock', () => {
    expect(seedScanOffset(T0, 40)).toBe(0);
    expect(seedScanOffset(T1, 40)).toBe(0);
    expect(seedScanOffset(T0, 1)).toBe(0);
    expect(seedScanOffset(T0, 39)).toBe(0);
    // 41 does NOT fit in one page (pages = 2), so it MUST be able to leave 0 —
    // otherwise "single page yields 0" would be indistinguishable from a
    // fixed-0 implementation. Hand-computed: 10_000 % 2 = 0 -> page 0 at T0,
    // 10_001 % 2 = 1 -> page 1 -> offset 40 one quantum later.
    expect(seedScanOffset(T0, 41)).toBe(0);
    expect(seedScanOffset(T1, 41)).toBe(40);
  });
});

describe('seedScanOffset — degenerate inputs return 0, never NaN', () => {
  // THE GUARD THAT MATTERS MOST. A `% 0` or a NaN clock would reach Postgres as
  // `OFFSET NaN` and fail the whole tick. Asserting finiteness AND 0 separately
  // is deliberate: `expect(NaN).toBe(0)` fails, but so does an accidental
  // `-0`/`Infinity`, and the finiteness assertion names which defect it is.
  const DEGENERATE: ReadonlyArray<{ label: string; nowMs: number; candidateCount: number }> = [
    { label: 'candidateCount 0 — nothing to walk', nowMs: T0, candidateCount: 0 },
    { label: 'candidateCount negative', nowMs: T0, candidateCount: -1 },
    { label: 'candidateCount negative and large', nowMs: T0, candidateCount: -594 },
    { label: 'candidateCount NaN', nowMs: T0, candidateCount: Number.NaN },
    { label: 'candidateCount Infinity', nowMs: T0, candidateCount: Number.POSITIVE_INFINITY },
    { label: 'candidateCount -Infinity', nowMs: T0, candidateCount: Number.NEGATIVE_INFINITY },
    { label: 'nowMs 0 — the epoch itself', nowMs: 0, candidateCount: PROD_CANDIDATES },
    { label: 'nowMs negative', nowMs: -1, candidateCount: PROD_CANDIDATES },
    { label: 'nowMs NaN', nowMs: Number.NaN, candidateCount: PROD_CANDIDATES },
    { label: 'nowMs Infinity', nowMs: Number.POSITIVE_INFINITY, candidateCount: PROD_CANDIDATES },
    { label: 'nowMs -Infinity', nowMs: Number.NEGATIVE_INFINITY, candidateCount: PROD_CANDIDATES },
    { label: 'both degenerate', nowMs: Number.NaN, candidateCount: Number.NaN },
  ];

  for (const { label, nowMs, candidateCount } of DEGENERATE) {
    test(label, () => {
      const offset = seedScanOffset(nowMs, candidateCount);
      // Finiteness first, and asserted separately from the value: it names the
      // defect (`OFFSET NaN` reaching Postgres) rather than reporting a generic
      // "expected 0, got NaN".
      expect(Number.isFinite(offset)).toBe(true);
      expect(offset).toBe(0);
    });
  }
});

describe('seedScanOffset — the tail is reachable', () => {
  // Proves EVERY page is a reachable start position before any repeats, which
  // is what makes "the walk covers the whole population across restarts" an
  // identity rather than an argument. 101 candidates = 3 pages, so three
  // consecutive quanta must produce all three page starts, and the fourth must
  // repeat the first. Kills a fixed-0 seed (set would be {0}), a seed that
  // never reaches the last page, and an off-by-one in `pages`.
  test('three consecutive quanta cover all three pages, then repeat', () => {
    const CANDIDATES = 101; // ceil(101 / 40) = 3 pages -> starts 0, 40, 80
    const seeds = [0, 1, 2].map((q) => seedScanOffset(T0 + q * 900_000, CANDIDATES));

    // Hand-computed: 10_000 % 3 = 1 -> 40; 10_001 % 3 = 2 -> 80; 10_002 % 3 = 0 -> 0.
    expect(seeds).toEqual([40, 80, 0]);
    // Same claim stated as coverage, so a re-ordering of the cycle still passes
    // while a MISSING page still fails.
    expect([...seeds].sort((a, b) => a - b)).toEqual([0, 40, 80]);
    // The fourth quantum wraps back onto the first — the cycle length is the
    // page count, so nothing is skipped and nothing is visited twice per cycle.
    expect(seedScanOffset(T0 + 3 * 900_000, CANDIDATES)).toBe(40);
    expect(new Set(seeds).size).toBe(3);
  });
});
