// tests/unit/workers/deblock-hold-acknowledged.test.ts
//
// Unit test for `classifyReceiverHold` — the predicate that reads the receiver's own
// 200 BODY and decides whether this row must stop being sent for.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SUITE
// ---------------------------------------------------------
// Same reason as tests/unit/workers/deblock-send-exhaustion.test.ts and
// deblock-scan-seed.test.ts: the worker's other tests need a live Postgres, so the
// BODY-SHAPE decision would have no gate that runs without a database — and a
// predicate whose only exercise is through a tick proves that some row retired, not
// WHICH bodies retire it. NO DB IS TOUCHED: importing the worker pulls in
// `src/db/client`, whose pool is LAZY, and nothing here runs a query.
//
// ⛔ THE DEFECT UNDER TEST. MEASURED on prod 2026-09-10: every tick in a 2h window
// read `acked=10 moved=0`, and rows carrying `deblock_action = 'QUESTION'` retired
// `send_exhausted / receiver_unresponsive` after FIVE SUCCESSFUL acks. The receiver
// was answering every time and SAYING what it did: `AA Pattern - Approval Callback ::
// Resolve Target List` sets `deliberate_hold: true` and a `resolve_diagnostic` ending
// `APPROVED WITH NO ANSWER: the ask is still open` when an approved QUESTION carries
// no answer text. fr counted the ack and discarded the body.
//
// ⚠️ THE NEGATIVE CASES ARE THE POINT OF THIS FILE, NOT DECORATION. A predicate that
// returned a cause for every 200 would "fix" the measured population and silently
// retire three others that must keep their retry budget — a genuinely unresponsive
// receiver, the receiver's own moved-on idempotence guard, and an approved MERGE. Each
// gets a case below, because the honest terminal for those rows is unchanged.

import { describe, expect, test } from 'bun:test';

import {
  classifyReceiverHold,
  HOLD_CAUSES,
  type HoldCause,
} from '../../../src/workers/deblock-callback-redelivery';

/**
 * The receiver's REAL body, field for field.
 *
 * ⚠️ TOP-LEVEL, NOT WRAPPED IN `data`, AND THAT IS COPIED FROM THE LIVE WORKFLOW
 * RATHER THAN FROM THE TYPE. `Final Output` (n8n id yG1N9K2hTswEZNTq) returns
 * `{ processed, cardId, decision, comment, cardMoved, verified_list_id,
 * target_list_id, target_list_kind, target_list_source, deblock_action,
 * deliberate_hold, resolve_diagnostic }` — it emits NO `success` key and NO `data`
 * envelope, while `N8nWebhookResponse` declares `{ success, message?, data? }`. A
 * fixture built from the declared type would have tested a shape production never
 * sends.
 */
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  processed: true,
  cardId: 'card-1',
  decision: 'approved',
  comment: '',
  cardMoved: false,
  verified_list_id: null,
  target_list_id: null,
  target_list_kind: null,
  target_list_source: 'unresolved',
  deblock_action: 'QUESTION',
  deliberate_hold: true,
  resolve_diagnostic:
    'proposition QUESTION approved - the card deliberately stays in BLOCKED; this is ' +
    'the decision, not a failure - APPROVED WITH NO ANSWER: the ask is still open',
  ...over,
});

describe('classifyReceiverHold — the measured population', () => {
  test('an approved QUESTION with no answer is answer_missing', () => {
    // THE ROW THIS CHANGE EXISTS FOR. Verbatim receiver body.
    expect(classifyReceiverHold(body())).toBe('answer_missing');
  });

  test('the flag and the action alone are enough — the prose is not required', () => {
    // A receiver refactor that drops the diagnostic suffix must not silently return
    // fr to five pointless sends. MUTANT: delete the `action === 'QUESTION' &&
    // decision === 'approved'` arm and this goes RED while the case above stays green.
    expect(classifyReceiverHold(body({ resolve_diagnostic: null }))).toBe('answer_missing');
  });

  test('the prose alone is enough — the flag is not required', () => {
    // The other direction: a receiver that grows the sentence before the flag, or
    // drops the flag, has still said the thing unambiguously.
    expect(classifyReceiverHold(body({ deliberate_hold: false }))).toBe('answer_missing');
  });

  test('a non-QUESTION holding action is hold_by_design, NOT answer_missing', () => {
    // ⛔ ONE LABEL FOR BOTH WOULD SEND HALF THE READERS TO THE WRONG FIX. An
    // INFRASTRUCTURE hold needs a fault to clear; an answer_missing hold needs a
    // human to type an answer. `HOLD_RELEASE_CONDITION` in the receiver spells both.
    expect(
      classifyReceiverHold(
        body({
          deblock_action: 'INFRASTRUCTURE',
          resolve_diagnostic:
            'proposition INFRASTRUCTURE approved - the card deliberately stays in ' +
            'BLOCKED; this is the decision, not a failure',
        }),
      ),
    ).toBe('hold_by_design');
    expect(
      classifyReceiverHold(
        body({
          deblock_action: 'DEPENDENCY',
          resolve_diagnostic: 'proposition DEPENDENCY approved - the card deliberately stays',
        }),
      ),
    ).toBe('hold_by_design');
  });

  test('a hold arriving wrapped in `data` is still read', () => {
    // `N8nWebhookResponse`'s declared shape, i.e. what the OTHER receivers in
    // EXPIRY_CALLBACK_PATHS answer with. MUTANT: drop the `data` fallback and this
    // goes RED — and the predicate becomes a no-op the day a hold arrives wrapped.
    expect(classifyReceiverHold({ success: true, data: body() })).toBe('answer_missing');
  });
});

describe('classifyReceiverHold — the rows that must KEEP their retry budget', () => {
  test('a genuinely unresponsive receiver is NOT a hold', () => {
    // ⛔ THE MUTANT THIS CASE KILLS is the whole-file one: any predicate that treats
    // a 200 as a hold. This is the receiver production actually had — n8n's queue
    // gave up (61 measured rows) or Planka 504'd (20) — and it MUST still walk to
    // `send_exhausted` at MAX_SEND_ATTEMPTS. Its body carries no marker at all.
    expect(classifyReceiverHold({ success: true })).toBeNull();
    expect(classifyReceiverHold({ processed: true, cardMoved: false })).toBeNull();
  });

  test('the receiver`s moved-on guard sets the SAME flag and is NOT a hold', () => {
    // ⛔ `deliberate_hold = movedOn || (…)` in the receiver, and `movedOn` on a
    // re-delivery means THE CARD HAS LEFT BLOCKED. That row earned `moved` and its
    // `callback_delivered_at`; retiring it here would write "waiting on an answer"
    // over a card already off the board. MUTANT: delete the MOVED_ON_DIAGNOSTIC
    // refusal and this goes RED.
    expect(
      classifyReceiverHold(
        body({
          resolve_diagnostic:
            'redelivery suppressed - this decision was already delivered and the card ' +
            'has since left BLOCKED (card is in list list-done, BLOCKED on this board ' +
            'is list-blocked) - re-applying the move would drag the card back out of ' +
            'the state it has legitimately reached; this is the guard, not a failure',
        }),
      ),
    ).toBeNull();
    // The first-delivery spelling of the same guard.
    expect(
      classifyReceiverHold(
        body({
          resolve_diagnostic:
            'decision not applied - the card had already left BLOCKED (card is in list ' +
            'list-done, BLOCKED on this board is list-blocked)',
        }),
      ),
    ).toBeNull();
  });

  test('an approved MERGE sets the SAME flag and is NOT a hold', () => {
    // ⛔ `SIDE_EFFECT_ACTIONS` puts MERGE on the deliberate_hold branch of `Resolve
    // Target List`, and `Final Output` reads that node — i.e. from BEFORE `Resolve
    // Merge Outcome` ran — so the flag is true whether the pull request landed or
    // not. A merge that did not land may land on the next attempt, so retiring it
    // would DELETE a repair. MUTANT: drop the RECEIVER_HOLDING_ACTIONS test and this
    // goes RED.
    expect(
      classifyReceiverHold(
        body({
          deblock_action: 'MERGE',
          resolve_diagnostic:
            'proposition MERGE approved - attempting the merge now; the card moves to ' +
            'DONE only if the pull request actually merges, and stays in BLOCKED with ' +
            'the refusal reason otherwise',
        }),
      ),
    ).toBeNull();
  });

  test('an `approval_hold:` token for MERGE is NOT a hold either', () => {
    // ⚠️ THE TOKEN IS EMITTED FOR EVERY DELIBERATE HOLD, MERGE INCLUDED (`Compose
    // Hold Reason`: `if (r.deliberate_hold) { if (action) parts.push('approval_hold:'
    // + action) }`), so matching the bare prefix — which an earlier draft of the
    // predicate did — would have retired the very rows the case above protects.
    expect(
      classifyReceiverHold({ resolve_diagnostic: 'approval_hold:MERGE decision:approved' }),
    ).toBeNull();
    // The same token for a holding action IS one.
    expect(
      classifyReceiverHold({ resolve_diagnostic: 'approval_hold:QUESTION decision:approved' }),
    ).toBe('answer_missing');
    expect(
      classifyReceiverHold({ resolve_diagnostic: 'approval_hold:DEPENDENCY decision:approved' }),
    ).toBe('hold_by_design');
  });

  test('a moved-on diagnostic beats every other signal, token included', () => {
    // ⛔ ORDER, ASSERTED. `moved` is a claim about the WORLD; a hold is a claim about
    // an INTENTION. A body carrying both must not retire as held.
    expect(
      classifyReceiverHold({
        deliberate_hold: true,
        deblock_action: 'QUESTION',
        decision: 'approved',
        resolve_diagnostic:
          'redelivery suppressed - approval_hold:QUESTION - APPROVED WITH NO ANSWER',
      }),
    ).toBeNull();
  });
});

describe('classifyReceiverHold — total over garbage', () => {
  // A receiver body crosses the wire, so it is `unknown` and absence must read as
  // SILENCE, never as a hold. Each of these would be a crash or a false retirement if the narrowing
  // were assumed rather than performed.
  const garbage: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'OK'],
    ['a number', 200],
    ['an array', [{ deliberate_hold: true }]],
    ['an empty object', {}],
    ['a truthy-but-not-true flag', { deliberate_hold: 'yes', deblock_action: 'QUESTION' }],
    ['a non-string diagnostic', { resolve_diagnostic: 42, deliberate_hold: true }],
  ];
  for (const [label, value] of garbage) {
    test(`${label} is not a hold`, () => {
      expect(classifyReceiverHold(value)).toBeNull();
    });
  }
});

describe('the cause vocabulary', () => {
  test('every declared cause is reachable from a real body', () => {
    // ⛔ A LABEL NOTHING CAN PRODUCE IS A BUCKET THAT READS AS A PERMANENT ZERO —
    // the failure `HOLD_CAUSES` is pre-zeroed to make visible, made vacuous. Every
    // value in the exported set must be returnable by the predicate that fills it.
    const produced = new Set<HoldCause>([
      classifyReceiverHold(body())!,
      classifyReceiverHold(body({ deblock_action: 'DEPENDENCY', resolve_diagnostic: null }))!,
    ]);
    for (const cause of HOLD_CAUSES) expect(produced.has(cause)).toBe(true);
  });
});

// R5: RECLASSIFY is deliberately NOT a holding action (an accepted one MOVES the
// card), so only the ncn receiver's refusal marker may retire it. The marker text
// is pinned on the ncn side by test-approval-callback-reclassify.mjs.
describe('classifyReceiverHold — RECLASSIFY (R5)', () => {
  test('a receiver-refused RECLASSIFY is hold_by_design (retired, not redelivered)', () => {
    expect(
      classifyReceiverHold(
        body({
          deblock_action: 'RECLASSIFY',
          deliberate_hold: true,
          resolve_diagnostic:
            "RECLASSIFY REFUSED (not_a_type): not a card_type in ncn's catalogue - the card stays BLOCKED",
        }),
      ),
    ).toBe('hold_by_design');
  });

  test('a RECLASSIFY hold WITHOUT the refusal marker keeps its retry budget', () => {
    // e.g. a lapse/void hold or any other deliberate_hold — the flag alone is not
    // trusted for an action the receiver normally moves for.
    expect(
      classifyReceiverHold(
        body({ deblock_action: 'RECLASSIFY', deliberate_hold: true, resolve_diagnostic: 'approval expired - holding' }),
      ),
    ).toBeNull();
  });

  test('the marker without deliberate_hold does not retire it', () => {
    expect(
      classifyReceiverHold(
        body({ deblock_action: 'RECLASSIFY', deliberate_hold: false, resolve_diagnostic: 'RECLASSIFY REFUSED (x)' }),
      ),
    ).toBeNull();
  });
});
