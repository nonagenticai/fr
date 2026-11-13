// tests/unit/workers/deblock-send-exhaustion.test.ts
//
// Unit test for `describeSendExhaustion` — the discriminator that decides WHO a
// `send_exhausted` row blames.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SUITE
// ---------------------------------------------------------
// Same reason as tests/unit/workers/deblock-scan-seed.test.ts: the only other tests for
// this worker were the deblock-callback-redelivery integration suite (deleted 2026-10-29)
// and needed a live Postgres, so the blame decision would have had no gate that runs — and
// therefore no gate that can be mutation-verified — without a database.
//
// NO DB IS TOUCHED. Importing the worker pulls in `src/db/client`, whose pool is LAZY; no
// socket opens until a query runs and nothing here runs one. Same import shape as the two
// existing pure-function worker unit tests.
//
// ⛔ THE DEFECT UNDER TEST. The worker logged ONE unconditional sentence for every retired
// row — "n8n is accepting and not moving; this row needs a human, not another send." —
// while never reading `deblock_action` at all. Measured on prod `fr` (worker4)
// 2026-09-07T14:01Z, bucketed so the parts sum to the whole (15 + 93 = 108):
//
//   required + USABLE      -> receiver blame EARNED     15
//   exempt: no_list_target -> nothing to move it to     93   <-- 86%, blamed the wrong party
//
// ⚠️ MULTI-VALUED ON PURPOSE. A single-valued fixture lets an agreeing hardcode survive:
// a `describeSendExhaustion` that ignored its input and always returned
// `no_actionable_exit` would pass a suite that only ever drove the 93-row shape. Every
// cause below is driven at least once, and the two `receiver_unresponsive` cases use two
// DIFFERENT actions so a hardcode on `QUESTION` dies too.

import { describe, expect, test } from 'bun:test';

import { SEND_EXHAUSTION_CAUSES } from '../../../src/domain/engagement/deblock-actions';
import { renderDeblockActionMetrics } from '../../../src/lib/deblock-action-metrics';
import {
  describeSendExhaustion,
  type SendExhaustionSubject,
} from '../../../src/workers/deblock-callback-redelivery';

/** The sentence the worker used to emit for EVERY exhausted row, verbatim. */
const OLD_UNCONDITIONAL_BLAME = 'n8n is accepting and not moving';

/**
 * ⚠️ `callback_acked_at` DEFAULTS TO ACKED, and that default is load-bearing. Discriminator
 * 1 (#1023) short-circuits on a NULL ack, so a fixture that left it null would send every
 * case below down the `never_acked` arm and the payload discriminator would never be
 * exercised at all — a suite that passes while testing nothing it claims to test.
 */
const subject = (over: Partial<SendExhaustionSubject> = {}): SendExhaustionSubject => ({
  callback_acked_at: new Date('2026-09-07T12:00:00Z'),
  deblock_action: null,
  doing_list_id: '',
  todo_list_id: '',
  advance_phase_on_approve: null,
  approval_kind: 'card_approval',
  ...over,
});

describe('describeSendExhaustion — the blame discriminator', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ THE ACCEPTANCE TEST. Revert the message to the unconditional blame and
  //    THIS goes red. A fix whose absence no test detects is not fixed.
  // ─────────────────────────────────────────────────────────────────────────
  test('the prod 93-row shape does NOT blame n8n and names the mint instead', () => {
    // Exactly the shape measured on prod: no deblock_action key, and doingListId /
    // todoListId present as EMPTY STRINGS (measured `''`, not absent).
    const r = describeSendExhaustion(subject());

    expect(r.cause).toBe('no_actionable_exit');
    // ⭐ The acceptance assertion. The old code emitted this for this exact row.
    expect(r.blame).not.toContain(OLD_UNCONDITIONAL_BLAME);
    expect(r.blame).toContain('NOT AN n8n FAULT');
    expect(r.blame).toContain('routes/webhooks.ts');
  });

  test('an exhausted row carrying a usable action DOES blame the receiver', () => {
    const r = describeSendExhaustion(subject({ deblock_action: 'QUESTION' }));

    expect(r.cause).toBe('receiver_unresponsive');
    // The original blame is EARNED here — fr did send a real instruction.
    expect(r.blame).toContain('QUESTION');
    expect(r.blame).toContain('The receiver accepted and did not move it');
    expect(r.blame).not.toContain('NOT AN n8n FAULT');
  });

  test('a SECOND usable action reaches the same arm, so a QUESTION hardcode dies', () => {
    const r = describeSendExhaustion(subject({ deblock_action: 'MERGE' }));

    expect(r.cause).toBe('receiver_unresponsive');
    expect(r.blame).toContain('MERGE');
    expect(r.blame).not.toContain('QUESTION');
  });

  test('an UNRECOGNISED action with a list target is a mint gap, and says it was present', () => {
    const r = describeSendExhaustion(
      subject({ deblock_action: 'FROBNICATE', doing_list_id: 'list-doing' }),
    );

    expect(r.cause).toBe('mint_gap');
    expect(r.blame).toContain('NOT in the closed allowlist');
    expect(r.blame).not.toContain(OLD_UNCONDITIONAL_BLAME);
  });

  test('an ABSENT action with a list target is a mint gap, and says absent', () => {
    const r = describeSendExhaustion(subject({ todo_list_id: 'list-todo' }));

    expect(r.cause).toBe('mint_gap');
    expect(r.blame).toContain('absent');
    // ⛔ The two mint_gap sub-cases must not collapse: "the producer said nothing" and
    // "the producer said something we throw away" have different fixes.
    expect(r.blame).not.toContain('NOT in the closed allowlist');
  });

  test('an unrecognised action WITHOUT a list target is no_actionable_exit, not mint_gap', () => {
    // Narrowing fails, so step 2 does not fire and step 3 (no list named) does. This is
    // the ordering `classifyDeblockExit` documents; asserting it here pins that this
    // worker delegates rather than re-deriving the precedence.
    const r = describeSendExhaustion(subject({ deblock_action: 'FROBNICATE' }));

    expect(r.cause).toBe('no_actionable_exit');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lane carve-outs. ⛔ These must NOT read as a mint defect: a lane whose exit
  // is driven elsewhere is not a lane with a bug, and a counter that says
  // otherwise about healthy traffic is the counter that gets muted.
  // ─────────────────────────────────────────────────────────────────────────
  test('the phase_advance lane is exempt, not a mint gap', () => {
    const r = describeSendExhaustion(
      subject({ advance_phase_on_approve: 'phase-2', doing_list_id: 'list-doing' }),
    );

    expect(r.cause).toBe('exempt_lane');
    expect(r.blame).toContain('phase_advance');
    expect(r.blame).not.toContain(OLD_UNCONDITIONAL_BLAME);
  });

  test('the improvement_gate lane is exempt', () => {
    const r = describeSendExhaustion(
      subject({ approval_kind: 'improvement.gate', doing_list_id: 'list-doing' }),
    );

    expect(r.cause).toBe('exempt_lane');
    expect(r.blame).toContain('improvement_gate');
  });

  test('the signoff_rail kind is exempt even though it names list targets', () => {
    // The rail's 844 rows all carry NON-EMPTY list ids and zero carry an action; without
    // the kind carve-out they would land on `mint_gap` — 844/844 false positives.
    const r = describeSendExhaustion(
      subject({
        approval_kind: 'execution.ready_signoff',
        doing_list_id: 'list-doing',
        todo_list_id: 'list-todo',
      }),
    );

    expect(r.cause).toBe('exempt_lane');
    expect(r.blame).toContain('signoff_rail');
  });

  test('a usable action does NOT override a lane carve-out', () => {
    // Dual exit: the carve-out still wins, per classifyDeblockExit. The point is that the
    // message must not claim the receiver ignored an action fr never sent.
    const r = describeSendExhaustion(
      subject({ deblock_action: 'RETRY', advance_phase_on_approve: 'phase-2' }),
    );

    expect(r.cause).toBe('exempt_lane');
    expect(r.blame).not.toContain('The receiver accepted and did not move it');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISCRIMINATOR 1 (#1023) — it precedes, and dominates, the payload question.
  // ─────────────────────────────────────────────────────────────────────────
  test('a row NO receiver ever acked blames neither n8n nor the mint', () => {
    // MUTANT: delete the `callback_acked_at` short-circuit and this row is reported as a
    // payload defect (`no_actionable_exit`) even though nothing ever received the payload.
    const r = describeSendExhaustion(subject({ callback_acked_at: null }));

    expect(r.cause).toBe('never_acked');
    expect(r.blame).toContain('NO receiver ever acked this row');
    expect(r.blame).toContain('VOIDED_CALLBACK_PATHS');
    expect(r.blame).not.toContain(OLD_UNCONDITIONAL_BLAME);
  });

  test('the ack test dominates a usable action', () => {
    // ⛔ A row can carry a perfectly good action and still never have been delivered. The
    // payload is moot when nothing accepted it.
    const r = describeSendExhaustion(
      subject({ callback_acked_at: null, deblock_action: 'QUESTION' }),
    );

    expect(r.cause).toBe('never_acked');
    expect(r.blame).not.toContain('The receiver accepted and did not move it');
  });

  test('every declared cause is reachable — no dead label on the counter', () => {
    // ⛔ A cause that no input can produce is a permanently-zero series that reads as
    // "this never happens" when it actually means "this can never be reported".
    const reached = new Set(
      [
        subject(),
        subject({ deblock_action: 'QUESTION' }),
        subject({ todo_list_id: 'list-todo' }),
        subject({ advance_phase_on_approve: 'phase-2' }),
        subject({ callback_acked_at: null }),
      ].map((s) => describeSendExhaustion(s).cause),
    );

    expect([...reached].sort()).toEqual([...SEND_EXHAUSTION_CAUSES].sort());
  });
});

describe('fr_deblock_redelivery_exhausted_total — the countable surface', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ THE GATE THAT DERIVES ITS EXPECTATION, RATHER THAN RE-LISTING IT.
  //
  // ⛔ THE DEFECT THIS CLOSES, AND IT SHIPPED IN THIS PR. `never_acked` became a
  // fifth emitted cause when #1023 was composed in, and the HELP text above it
  // documented only FOUR — so the exposition described a series it also emitted,
  // wrongly, and no test noticed. The test directly above cannot notice: it names
  // four cause strings BY HAND, and a hand-written list is structurally unable to
  // observe a member nobody hand-wrote. Re-listing five instead of four would
  // re-arm the identical trap for a sixth.
  //
  // So every expectation below is derived from `SEND_EXHAUSTION_CAUSES` — the same
  // array the emitter loops over — and the two directions are BOTH asserted: no
  // declared cause may be missing from the exposition or from the HELP, and no
  // series may be exposed that the enum does not declare.
  // ─────────────────────────────────────────────────────────────────────────
  test('every declared cause is BOTH exposed and documented in HELP — derived, never re-listed', () => {
    const lines = renderDeblockActionMetrics();

    const help = lines.find((l) =>
      l.startsWith('# HELP fr_deblock_redelivery_exhausted_total '),
    );
    // A positive control on the instrument itself: if the HELP line were renamed or
    // dropped, `undocumented` below would list every cause and the failure would be
    // blamed on the causes rather than on the missing line.
    expect(help).toBeDefined();

    const exposed = SEND_EXHAUSTION_CAUSES.filter((cause) =>
      lines.some((l) => l.startsWith(`fr_deblock_redelivery_exhausted_total{cause="${cause}"} `)),
    );
    // ⚠️ Named sets, not counts. `expect(n).toBe(5)` would say "expected 5, got 4";
    // these say WHICH cause slipped, which is the whole difficulty of this defect.
    const undocumented = SEND_EXHAUSTION_CAUSES.filter((cause) => !help!.includes(cause));
    const unexposed = SEND_EXHAUSTION_CAUSES.filter((cause) => !exposed.includes(cause));

    expect(undocumented).toEqual([]);
    expect(unexposed).toEqual([]);

    // ⛔ And the converse direction: no exposed series outside the enum. Without this
    // the pair above is satisfiable by an emitter that also prints a sixth, stale
    // label that nothing declares and nothing can ever increment.
    const emitted = lines
      .map((l) => /^fr_deblock_redelivery_exhausted_total\{cause="([^"]+)"\} /.exec(l)?.[1])
      .filter((c): c is string => c !== undefined);
    expect([...emitted].sort()).toEqual([...SEND_EXHAUSTION_CAUSES].sort());
  });
});
