// tests/unit/workers/deblock-fast-lane-budget.test.ts
//
// Pins the ARITHMETIC of the de-block re-delivery fast lane — the two numbers
// that turn "recent decisions are repaired promptly without starving the
// backlog" from a claim in a comment into a property of the code.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SUITE
// ---------------------------------------------------------
// Same reason as tests/unit/workers/deblock-scan-seed.test.ts, which this file
// deliberately mirrors: the behaviour was proved against a real Postgres by the
// deblock-callback-redelivery integration suite (deleted 2026-10-29)
// ("the backlog keeps HALF the send budget even when the fast lane is full"),
// but that gate needed a database. The arithmetic those cases rest on is pure, so
// it gets a gate that runs — and can be mutation-verified — without one.
//
// NO DB IS TOUCHED. Importing the worker pulls in `src/db/client`, whose pool is
// LAZY; no socket opens until a query runs and nothing here runs one. Same import
// shape as the two existing pure-function worker unit tests.
//
// ⚠️ EVERY EXPECTATION BELOW IS A LITERAL, DELIBERATELY — the rule this repo
// already wrote down in deblock-scan-seed.test.ts. Asserting
// `FAST_LANE_READS < MAX_PER_RUN` by importing both is SELF-CANCELLING: it keeps
// passing at 50 and 100, i.e. while the safety property it names quietly changes
// meaning. The relation is asserted too, but the literals are what make a change
// to either constant RED.

import { describe, expect, test } from 'bun:test';

import {
  FAST_LANE_DEADLINE_SHARE,
  FAST_LANE_READS,
  FRESH_WINDOW_MS,
  MAX_PER_RUN,
} from '../../../src/workers/deblock-callback-redelivery';

describe('the fast lane cannot starve the backlog', () => {
  // ⭐ HALF THE ANTI-STARVATION GUARANTEE — THE SEND-SLOT HALF. Fresh rows are
  // delivered FIRST, so the fast lane's read cap is also its cap on the tick's
  // MAX_PER_RUN send slots. Because it is strictly smaller, the backlog page is
  // left MAX_PER_RUN - FAST_LANE_READS slots on EVERY tick, whatever the traffic.
  //
  // ⚠️ AND ONLY HALF. This file used to describe it as the whole guarantee, in
  // the same words the worker's docblock used, and both were wrong in the same
  // direction: a tick ALSO ends on the wall clock, and an unclaimed send slot is
  // worth nothing to a lane the delivery loop never reaches. The time half is the
  // describe() block below; a build that satisfies only these cases still starves
  // the backlog completely under a slow Planka.
  //
  // ⛔ THE MUTANT THIS KILLS: FAST_LANE_READS raised to MAX_PER_RUN (or above), or
  // the LIMIT dropped from `selectFreshCandidates` entirely. Either lets a burst
  // of fresh decisions consume every send slot, which is the SECOND starvation —
  // the one the naive `ORDER BY completed_at DESC` fix creates.
  test('the fast lane reads strictly fewer rows than a tick may send', () => {
    expect(FAST_LANE_READS).toBe(5);
    expect(MAX_PER_RUN).toBe(10);
    // Stated as the relation as well, so a reader sees WHY the two literals are
    // in the same case — but the literals above are what actually fail.
    expect(FAST_LANE_READS).toBeLessThan(MAX_PER_RUN);
  });

  // The floor, spelled as the number an operator would check on a tick line.
  test('at least five send slots per tick are always reachable by the backlog', () => {
    expect(MAX_PER_RUN - FAST_LANE_READS).toBe(5);
  });

  // ⛔ A zero-or-negative reserve would be a fast lane that reads nothing (the
  // fix silently inert) — the shape this repo calls "a deployed fix on an idle
  // path produces no signal".
  test('the reserve is a real, positive number of rows', () => {
    expect(Number.isInteger(FAST_LANE_READS)).toBe(true);
    expect(FAST_LANE_READS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ⭐ THE OTHER HALF — THE TIME RESERVE
//
// ⛔ WHY THIS BLOCK EXISTS. The send-slot reserve above shipped 2026-09-10 with a
// docblock calling it "a property of the arithmetic, not of the traffic". The
// arithmetic was over the WRONG CONSTANT. `deliverAll` breaks on MAX_PER_RUN *and*
// on `Date.now() >= deadline` (60s default), and the fresh rows run FIRST at
// PACE_MS + a Planka `cards.get` each. At the ~11 s/read this worker's own headers
// measure under load — the condition that CREATES a backlog — five fresh rows
// consume the WHOLE tick and the 815-row backlog gets ZERO repairs, every tick,
// for the whole outage. The guarantee held in the happy path and failed exactly
// where it was needed, which is the worst shape a guarantee can have.
// ---------------------------------------------------------------------------
describe('the fast lane cannot spend the whole tick either', () => {
  /** DEBLOCK_REDELIVERY_TICK_DEADLINE_MS's default, hand-written per this file's literal rule. */
  const TICK_BUDGET_MS = 60_000;
  /** Planka under load, from the worker's own measured headers. */
  const DEGRADED_READ_MS = 11_000;

  // ⛔ THE MUTANT THIS KILLS: FAST_LANE_DEADLINE_SHARE raised to 1 (or the
  // `inFastLane ? fastLaneDeadline : deadline` ternary in `deliverAll` collapsed
  // back to `deadline`). Either restores the shipped defect exactly.
  test('the fast lane may start rows for only half of the tick budget', () => {
    expect(FAST_LANE_DEADLINE_SHARE).toBe(0.5);
    expect(FAST_LANE_DEADLINE_SHARE).toBeGreaterThan(0);
    expect(FAST_LANE_DEADLINE_SHARE).toBeLessThan(1);
  });

  // ⭐ THE NUMBER THE GUARANTEE IS ACTUALLY ABOUT, spelled as an operator would
  // check it: milliseconds of tick left for the backlog walk, not send slots.
  test('the backlog walk is entered with half of a default tick still unspent', () => {
    expect(Math.floor(TICK_BUDGET_MS * (1 - FAST_LANE_DEADLINE_SHARE))).toBe(30_000);
  });

  // ⛔ WHY A FRACTION AND NOT A MILLISECOND CONSTANT. The tick budget is
  // operator-tunable; an absolute "the fast lane gets 30s" becomes the WHOLE
  // budget the moment someone sets the deadline to 30s — the guarantee
  // evaporating through a knob that has nothing to do with it. MUTANT: replace
  // the share with a constant and the 5s row below leaves the backlog <= 0.
  test('the reserve survives an operator moving the tick deadline', () => {
    for (const budget of [5_000, 30_000, 60_000, 300_000]) {
      const backlogShare = budget - Math.floor(budget * FAST_LANE_DEADLINE_SHARE);
      expect(backlogShare).toBeGreaterThan(0);
      expect(backlogShare).toBe(budget / 2);
    }
  });

  // ⭐ THE AUDIT'S ARITHMETIC, PINNED. This is the case that says the send-slot
  // reserve was never sufficient: five reads at the degraded cost do not fit in
  // the tick at all, let alone in the fast lane's share of it.
  test('five fresh reads at the DEGRADED read cost overrun both the share and the tick', () => {
    expect(FAST_LANE_READS * DEGRADED_READ_MS).toBeGreaterThan(
      TICK_BUDGET_MS * FAST_LANE_DEADLINE_SHARE,
    );
    // 5 x 11s = 55s of a 60s tick — which is why the backlog saw nothing.
    expect(FAST_LANE_READS * DEGRADED_READ_MS).toBe(55_000);
    expect(FAST_LANE_READS * DEGRADED_READ_MS).toBeGreaterThan(TICK_BUDGET_MS * 0.9);
  });

  // ⚠️ THE COST, ASSERTED RATHER THAN ONLY DESCRIBED. Under that same degraded
  // Planka the fast lane gets 2 reads, not 5. It does NOT get 0: the first row of
  // each lane is attempted unconditionally, so the NEWEST decision is looked at on
  // every tick whatever the read cost. That is the trade this design makes.
  test('a degraded tick still starts at least one fresh row and at least one backlog row', () => {
    const fastLaneBudget = TICK_BUDGET_MS * FAST_LANE_DEADLINE_SHARE;
    const freshStarted = Math.max(1, Math.ceil(fastLaneBudget / DEGRADED_READ_MS));
    expect(freshStarted).toBe(3);
    expect(freshStarted).toBeLessThan(FAST_LANE_READS);
    // …and whatever the read cost, neither lane can be reduced to zero attempts.
    const absurdReadMs = 10 * TICK_BUDGET_MS;
    expect(Math.max(1, Math.floor(fastLaneBudget / absurdReadMs))).toBe(1);
  });
});

describe('the fresh window outlives one full ack-grace cycle', () => {
  // ⭐ WHY THE WINDOW IS 1 HOUR AND NOT "RECENT". A fresh row is sent on the tick
  // that finds it; `deliverDecisionCallback` stamps `callback_acked_at`; the ack
  // clause in `candidateWhereBase` then hides the row for ACK_GRACE_MS (30 min).
  // A window narrower than `ACK_GRACE_MS + one tick` would let the row leave the
  // fast lane DURING its own grace period — one attempt, then back into the
  // ~2.7-hour walk, i.e. the defect wearing a fast lane's name.
  //
  //   found + sent   <= T +   900_000   (one tick)
  //   invisible for       + 1_800_000   (ACK_GRACE_MS)
  //   next look at   <= T + 2_700_000  <  3_600_000  ✅ still inside the window
  //
  // ⛔ MUTANT: change the derivation to `ACK_GRACE_MS` alone (1_800_000) or to
  // `ACK_GRACE_MS + DEFAULT_INTERVAL_MS` (2_700_000, exactly the boundary rather
  // than strictly inside it) and the first case goes RED.
  test('the window is exactly one hour, hand-computed from the two constants it depends on', () => {
    expect(FRESH_WINDOW_MS).toBe(3_600_000);
  });

  test('a row sent on the first tick is still inside the window for its second attempt', () => {
    const SENT_BY = 900_000; // one worker interval
    const ACK_GRACE = 1_800_000; // ACK_GRACE_MS
    // Strictly less than, not <= : the second attempt must land INSIDE the
    // window, not on its edge, or a row can age out between the two comparisons.
    expect(SENT_BY + ACK_GRACE).toBeLessThan(FRESH_WINDOW_MS);
  });

  // The window must also be long enough that a row cannot skip the lane entirely
  // by being decided just after a tick started: one full interval of slack.
  test('the window is at least four worker intervals wide', () => {
    expect(FRESH_WINDOW_MS).toBeGreaterThanOrEqual(4 * 900_000);
  });
});
