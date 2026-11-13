// tests/unit/workers/deblock-tick-log-gate.test.ts
//
// #1034's fix adds a `shadowed` count to the redelivery tick line. That fix is
// only worth anything if the line actually PRINTS in the state the issue
// describes — a worker doing nothing while a suppressed population sits behind
// the shadow clause.
//
// The gate was `delivered > 0 || failed > 0 || cardUnreadable > 0`. All three
// mean "this tick did something". Measured on prod 2026-09-08 the worker sees
// 452 shadowed / 1 visible, and that 1 visible row is a permanently unreadable
// smoke card — so `cardUnreadable > 0` is the ONLY reason a line prints today.
// The day that row retires, or the 239 gates expiring 2026-09-10 drain, every
// term would go to 0 and the tick would fall silent with 452 rows still parked:
// the exact invisibility #1034 exists to remove, reinstated by the log gate.
//
// ⛔ This asserts the PREDICATE, not the source text of the worker. A
// `SRC.includes(...)` check proves a sequence of characters exists, not that a
// branch is reached — an `if (false) return …` wrapper satisfies the former and
// defeats the latter, which is exactly how a sibling test in this repo was
// evaded earlier today.
import { describe, test, expect } from 'bun:test';

import { shouldLogTick } from '../../../src/workers/deblock-callback-redelivery';

const quiet = { delivered: 0, failed: 0, cardUnreadable: 0, shadowed: 0 };

describe('the redelivery tick logs when there is something to say', () => {
  test('a genuinely idle tick still prints NOTHING', () => {
    expect(shouldLogTick(quiet)).toBe(false);
  });

  // THE REGRESSION GUARD. Remove `shadowed` from the gate and this is the
  // assertion that fails.
  test('a tick that did no work but has a SHADOWED population still prints', () => {
    expect(shouldLogTick({ ...quiet, shadowed: 452 })).toBe(true);
    expect(shouldLogTick({ ...quiet, shadowed: 1 })).toBe(true);
  });

  test('each of the three original work terms still prints on its own', () => {
    expect(shouldLogTick({ ...quiet, delivered: 1 })).toBe(true);
    expect(shouldLogTick({ ...quiet, failed: 1 })).toBe(true);
    expect(shouldLogTick({ ...quiet, cardUnreadable: 1 })).toBe(true);
  });

  // ⭐ 2026-09-10 — THE SAME DEFECT, ONE SUPPRESSED POPULATION OVER. `rejected`
  // is now a candidate status, but a rejected BLOCKED-exit PROPOSITION is
  // withheld (`notARejectedHold`): the receiver holds that card in BLOCKED on
  // purpose, so the row can never reach `moved`. Measured on prod 2026-09-10:
  // 16 rejected rows, 0 with a resolution, 0 with any retry path ever — and the
  // reason nobody noticed is that they were excluded BY CONSTRUCTION, which is
  // indistinguishable from not existing.
  //
  // REGRESSION GUARD: remove `rejectedHeld` from the gate and this goes RED.
  test('a tick that did no work but is HOLDING rejected rows still prints', () => {
    expect(shouldLogTick({ ...quiet, rejectedHeld: 16 })).toBe(true);
    expect(shouldLogTick({ ...quiet, rejectedHeld: 1 })).toBe(true);
  });

  // ⛔ AND THE FIELD IS OPTIONAL, SO ITS ABSENCE MUST NOT PRINT. A `?? 0` that
  // was written as `?? 1` — or a `!= null` test — would make every idle tick log
  // forever, which is how a heartbeat becomes noise and then gets muted.
  test('an absent rejectedHeld reads as none, not as something to say', () => {
    expect(shouldLogTick(quiet)).toBe(false);
    expect(shouldLogTick({ ...quiet, rejectedHeld: 0 })).toBe(false);
  });

  test('the prod shape today prints, and would STILL print once the smoke card retires', () => {
    // today: 1 visible candidate, unreadable, 452 shadowed
    expect(shouldLogTick({ delivered: 0, failed: 0, cardUnreadable: 1, shadowed: 452 })).toBe(true);
    // after that row retires: nothing worked, 452 still parked
    expect(shouldLogTick({ delivered: 0, failed: 0, cardUnreadable: 0, shadowed: 452 })).toBe(true);
  });
});
