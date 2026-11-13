// tests/unit/domain/deblock-card-move.test.ts
//
// APPROVING AN INFRASTRUCTURE HOLD IS A REAL CARD MOVE — AND EXPIRING ONE IS NOT.
//
// WHY THIS EXISTS — the defect it pins
// ------------------------------------
// `INFRASTRUCTURE` and `DEPENDENCY` were permanent holds. The receiver's
// `AA Pattern - Approval Callback :: Resolve Target List` routed both to
// `target_list_kind = null` on EVERY decision, so approving one and rejecting one
// produced byte-identical outcomes: the card stayed in BLOCKED either way, the
// callback answered 200, and `callback.outcome` read `sent`. Measured: 214 pending
// rows carry one of the two. A gate whose branches agree is not a gate.
//
// The product owner's decision (2026-09-14): approving one of these means "I have
// fixed it, try again", and re-drives the card to TODO — exactly as RETRY and an
// answered QUESTION already do.
//
// ⛔⛔ THE TRAP THIS FILE EXISTS FOR, AND THE REASON HALF THESE TESTS ARE ABOUT
// OUTCOMES THAT MUST *NOT* MOVE. In the receiver, the same `HOLDING_ACTIONS` set
// is read by the LAPSE path:
//
//     lapseHolds = isNonVerdict && (HOLDING_ACTIONS.has(action) || !!SIDE_EFFECT_ACTIONS[action])
//
// An EXPIRED or VOIDED approval is not a human saying "I fixed it" — fr's
// approval-expiry worker deliberately manufactures no decision at all, because
// either verdict "would manufacture a decision nobody made". So the APPROVED path
// gains a target while the LAPSE path keeps holding: the two tables move in
// OPPOSITE directions in one change. Releasing both at once silently re-drives
// every expired hold in the queue, and a test suite that only exercises the
// approved path goes green on exactly that mistake.
//
// DB-free by construction — `plannedCardMove` is pure.

import { describe, expect, test } from 'bun:test';

import {
  APPROVED_ACTION_TARGET,
  DEBLOCK_ACTIONS,
  LAPSE_HOLDS_ACTIONS,
  lapseHolds,
  plannedCardMove,
  type DeblockAction,
} from '../../../src/domain/engagement/deblock-actions';

/** The two actions Phase 4 changes. Everything else must be untouched by it. */
const PHASE_4_ACTIONS: DeblockAction[] = ['INFRASTRUCTURE', 'DEPENDENCY'];

describe('Phase 4 — an APPROVED infrastructure/dependency hold re-drives the card', () => {
  test.each(PHASE_4_ACTIONS)('%s: the approved target is TODO', (action) => {
    // ⛔ THE ASSERTION THAT FAILS BEFORE THE CHANGE. `null` was the shipped value.
    expect(APPROVED_ACTION_TARGET[action]).toBe('TODO');
  });

  test.each(PHASE_4_ACTIONS)('%s: approving plans a real move', (action) => {
    const plan = plannedCardMove({ decision: 'approved', action });
    expect(plan.moves).toBe(true);
    expect(plan.target).toBe('TODO');
    expect(plan.held).toBeNull();
  });

  test('it is the same destination RETRY already uses — not a new lane', () => {
    // A re-drive through TODO lets the pickability gate decide when the card
    // becomes READY. If this ever diverges from RETRY, the two Phase-4 actions
    // have quietly acquired a bespoke route nobody designed.
    expect(APPROVED_ACTION_TARGET.INFRASTRUCTURE).toBe(APPROVED_ACTION_TARGET.RETRY);
    expect(APPROVED_ACTION_TARGET.DEPENDENCY).toBe(APPROVED_ACTION_TARGET.RETRY);
  });
});

describe('⛔ THE ASYMMETRY — the same two actions still HOLD on every non-approval', () => {
  // ── The discriminating half. Each of these is the SAME action as above with
  // only the decision changed, so a fix that routes on the action alone (a table
  // lookup hoisted above the decision test) passes the suite above and fails
  // every test here.

  test.each(PHASE_4_ACTIONS)('%s: REJECTING must not move the card', (action) => {
    const plan = plannedCardMove({ decision: 'rejected', action });
    expect(plan.moves).toBe(false);
    expect(plan.target).toBeNull();
    expect(plan.held).toBe('rejected_proposition');
  });

  test.each(PHASE_4_ACTIONS)('%s: EXPIRING must not move the card', (action) => {
    // ⛔ THE ONE THAT MATTERS MOST. An expiry is the 15-minute reaper, not a
    // human asserting the fault is fixed. Getting this wrong re-drives the whole
    // expired population at once, silently.
    const plan = plannedCardMove({ decision: 'expired', action });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('lapsed_proposition');
  });

  test.each(PHASE_4_ACTIONS)('%s: VOIDING must not move the card', (action) => {
    const plan = plannedCardMove({ decision: 'voided', action });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('lapsed_proposition');
  });

  test.each(PHASE_4_ACTIONS)('%s: still holds on a lapse, per LAPSE_HOLDS_ACTIONS', (action) => {
    expect(lapseHolds(action)).toBe(true);
    expect(LAPSE_HOLDS_ACTIONS.has(action)).toBe(true);
  });

  test('the two tables genuinely DISAGREE about these actions — that is the point', () => {
    // ⭐ THE ASSERTION A "SIMPLIFICATION" KILLS. Anyone reconciling the two sets
    // by making them equal — in either direction — breaks exactly this line, and
    // nothing else in the suite would notice which direction they broke it in.
    for (const action of PHASE_4_ACTIONS) {
      expect(APPROVED_ACTION_TARGET[action]).not.toBeNull();
      expect(lapseHolds(action)).toBe(true);
    }
  });

  test('CONTROL: RETRY moves on approve and does NOT hold on a lapse', () => {
    // Without this, `lapseHolds` returning `true` for everything would satisfy
    // the arm above while destroying the set's meaning.
    expect(lapseHolds('RETRY')).toBe(false);
    expect(plannedCardMove({ decision: 'approved', action: 'RETRY' }).moves).toBe(true);
  });
});

describe('the rest of the table is untouched by Phase 4', () => {
  test('DROP -> DROPPED (never DONE, 2026-10-05), SPLIT -> READY, RETRY -> TODO', () => {
    expect(APPROVED_ACTION_TARGET.DROP).toBe('DROPPED');
    expect(APPROVED_ACTION_TARGET.SPLIT).toBe('READY');
    expect(APPROVED_ACTION_TARGET.RETRY).toBe('TODO');
  });

  test('MERGE never gets a target — approving authorises the attempt, not the outcome', () => {
    // The receiver's own rule, verbatim: "MERGE MUST NEVER JOIN `ACTION_TARGET`.
    // That map answers 'which list' UNCONDITIONALLY." A merge that is refused for
    // `checks_failed` must leave the card in BLOCKED.
    expect(APPROVED_ACTION_TARGET.MERGE).toBeNull();
    const plan = plannedCardMove({ decision: 'approved', action: 'MERGE' });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('merge_pending');
  });

  test('MERGE holds on a lapse too, via the SIDE_EFFECT disjunct', () => {
    // It is NOT in the receiver's `HOLDING_ACTIONS`; it reaches the lapse hold
    // through `|| !!SIDE_EFFECT_ACTIONS[action]`. A lapsed MERGE must not merge.
    expect(lapseHolds('MERGE')).toBe(true);
  });

  test('an approved QUESTION moves only WITH answer text', () => {
    const answered = plannedCardMove({
      decision: 'approved',
      action: 'QUESTION',
      answerText: 'yes, proceed with option B',
    });
    expect(answered.moves).toBe(true);
    expect(answered.target).toBe('TODO');
  });

  test.each([[undefined], [null], [''], ['   ']])(
    'CONTROL: an approved QUESTION with answerText %p holds as answer_missing',
    (answerText) => {
      // The receiver trims, so this trims: a whitespace-only comment is an EMPTY
      // answer there and must be one here. Releasing on it would build the
      // BLOCKED -> TODO -> BLOCKED loop fed by empty approvals that the non-empty
      // requirement exists to make impossible.
      const plan = plannedCardMove({
        decision: 'approved',
        action: 'QUESTION',
        answerText: answerText as string | null | undefined,
      });
      expect(plan.moves).toBe(false);
      expect(plan.held).toBe('answer_missing');
    },
  );

  test('every action has a decided approved-target — adding one without deciding is a type error', () => {
    // The value may be `null` (a hold), but the KEY must exist. This is the
    // runtime half of the `Record<DeblockAction, …>` in the source: a partial map
    // would let a new action fall through to a silent hold, which is the
    // five-copies failure this module was created to end.
    for (const action of [...DEBLOCK_ACTIONS]) {
      expect(Object.prototype.hasOwnProperty.call(APPROVED_ACTION_TARGET, action)).toBe(true);
    }
  });
});

describe('a row with no usable action is NOT KNOWN, which is not the same as NOT MOVING', () => {
  test.each([[undefined], [null], [''], ['NONSENSE'], [42]])(
    'action %p routes legacy with moves: null',
    (action) => {
      // ⛔ `moves: null` must never be rendered as `false`. The receiver falls back
      // to its legacy decision->list mapping, which resolves lists from the BOARD —
      // something fr does not do. Asserting "the card will not move" here would be
      // an empty evidence block read as a measurement.
      const plan = plannedCardMove({ decision: 'approved', action });
      expect(plan.route).toBe('legacy');
      expect(plan.moves).toBeNull();
    },
  );

  test('CONTROL: a usable action is never legacy', () => {
    expect(plannedCardMove({ decision: 'approved', action: 'INFRASTRUCTURE' }).route).toBe(
      'proposition',
    );
  });
});

// PR #1123 AUDIT, FINDING 2 -- a lapse is not a rejection. The receiver's `isNonVerdict` block
// runs ABOVE its proposition arm: a lapse HOLDS only for `lapseHolds` actions and otherwise
// re-queues to TODO (never `ACTION_TARGET`). The old branch reported `held` for every lapse,
// contradicting fr's own `lapseHolds('RETRY') === false`.
describe('a lapse routes like the receiver: hold only for lapse-holding actions', () => {
  test.each([['expired'], ['voided']])('%s RETRY re-queues to TODO', (decision) => {
    const plan = plannedCardMove({ decision, action: 'RETRY' });
    expect(plan.moves).toBe(true);
    expect(plan.target).toBe('TODO');
    expect(plan.held).toBeNull();
  });

  test.each([['expired'], ['voided']])('CONTROL: %s INFRASTRUCTURE holds', (decision) => {
    const plan = plannedCardMove({ decision, action: 'INFRASTRUCTURE' });
    expect(plan.moves).toBe(false);
    expect(plan.target).toBeNull();
    expect(plan.held).toBe('lapsed_proposition');
  });

  test.each([['SPLIT'], ['DROP']])(
    'an expired %s re-queues to TODO -- NOT its approved target',
    (action) => {
      // ⛔ The receiver: "TODO, NEVER `ACTION_TARGET[action]`". DROP -> DONE on an expiry would
      // kill a card nobody sanctioned killing; SPLIT -> READY would run the split judge.
      const plan = plannedCardMove({ decision: 'expired', action });
      expect(plan.moves).toBe(true);
      expect(plan.target).toBe('TODO');
    },
  );

  test('CONTROL: a REJECTED RETRY still holds -- only the lapse re-queues', () => {
    const plan = plannedCardMove({ decision: 'rejected', action: 'RETRY' });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('rejected_proposition');
  });

  test('an expired MERGE holds via the side-effect disjunct', () => {
    const plan = plannedCardMove({ decision: 'expired', action: 'MERGE' });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('lapsed_proposition');
  });
});

describe('the hold tells the decider what it is waiting for', () => {
  test('a held INFRASTRUCTURE row names its release condition', () => {
    const plan = plannedCardMove({ decision: 'expired', action: 'INFRASTRUCTURE' });
    expect(plan.holdReleaseCondition).toContain('approves');
  });

  test('CONTROL: a held RETRY row has no release condition to name', () => {
    // Only the holding actions have one. Inventing a sentence for RETRY would be
    // a fabricated precision — a rejected RETRY is simply refused, not waiting.
    const plan = plannedCardMove({ decision: 'rejected', action: 'RETRY' });
    expect(plan.holdReleaseCondition).toBeUndefined();
  });
});

// ── RECLASSIFY (REALIGN R5) ─────────────────────────────────────────────────────────
// Approving re-drives through TODO under the decider-chosen type; it is a MOVE on the
// approved path, but a LAPSE HOLD: an expired/voided RECLASSIFY means no human chose a new
// type, so re-queueing would re-run the card under the type just declared wrong.
describe('RECLASSIFY: a move when approved, a hold when lapsed', () => {
  test('the approved target is TODO', () => {
    expect(APPROVED_ACTION_TARGET.RECLASSIFY).toBe('TODO');
  });

  test('an approved RECLASSIFY plans a move to TODO', () => {
    const plan = plannedCardMove({ decision: 'approved', action: 'RECLASSIFY' });
    expect(plan).toEqual({ route: 'proposition', moves: true, target: 'TODO', held: null });
  });

  test('a rejected RECLASSIFY holds — rejecting never moves the card', () => {
    const plan = plannedCardMove({ decision: 'rejected', action: 'RECLASSIFY' });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('rejected_proposition');
  });

  test('still holds on a lapse, per LAPSE_HOLDS_ACTIONS', () => {
    expect(LAPSE_HOLDS_ACTIONS.has('RECLASSIFY')).toBe(true);
    expect(lapseHolds('RECLASSIFY')).toBe(true);
  });

  test.each(['expired', 'voided'])('%s: must not move the card (stays BLOCKED for a human)', (decision) => {
    const plan = plannedCardMove({ decision, action: 'RECLASSIFY' });
    expect(plan.moves).toBe(false);
    expect(plan.target).toBeNull();
    expect(plan.held).toBe('lapsed_proposition');
  });

  test('the two tables disagree for RECLASSIFY, as for INFRASTRUCTURE/DEPENDENCY', () => {
    expect(APPROVED_ACTION_TARGET.RECLASSIFY).not.toBeNull();
    expect(lapseHolds('RECLASSIFY')).toBe(true);
  });
});
