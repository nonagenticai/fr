import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  ANSWER_CONTRACT,
  FIX_ASSERTION_ACTIONS,
  FIX_ASSERTION_CONTRACT,
  FIX_ASSERTION_LABEL,
  FIX_ASSERTION_PLACEHOLDER,
  FIX_ASSERTION_REFUSAL,
  FIX_ASSERTION_TOGGLE,
  answerDemandOf,
  answerlessApproveTitle,
  demandedDecisionText,
  isFixAssertion,
  BROKEN_GATE_OVERRIDE_MIN_REASON,
  BROKEN_GATE_TERMS,
  answerRequired,
  approveConsequenceNotice,
  approveHoldNotice,
  approveMoveNotice,
  brokenGateTermsOf,
  cardMoveOnApprove,
  deblockActionOf,
  hasStatedQuestion,
  isQuestion,
  openQuestionsOf,
  parseProposition,
  questionPresentation,
  UNREADABLE_QUESTION_NOTICE,
  UNROUTED_QUESTION_NOTICE,
  UNSTATED_QUESTION_NOTICE,
  validateAnswer,
  validateOverrideReason,
} from './question';
import type { Approval } from '$lib/types/api';

const base = {
  id: 'a1',
  project_id: 'p1',
  requester_id: 'r1',
  status: 'pending',
  description: 'gate',
  created_at: '',
  expires_at: '',
} as unknown as Approval;

const withMetadata = (metadata: unknown): Approval =>
  ({ ...base, metadata } as unknown as Approval);

/** The NEWER description format — carries ON APPROVE / ON REJECT. */
const NEW_FORMAT = [
  'Validate Draft Data and Project Linkage: PROPOSITION for card 1855542337409648090 (development_feature_new)',
  'BLOCK REASON [open_questions, source=derived-from-block-reason-field]: block reason: failed_step: validate',
  'VERDICT: needs_info -> DOING',
  'ISSUES: first issue. ; second issue. ; third issue.',
  'PROCEDURE: development_feature_new.blocked.action (ingest_block_context [mental_step] -> ask)',
  'LEARNING: BLOCKED open_questions on development_feature_new  [signature open-questions::abc, stream __system_prompt__]',
  'PROPOSED_ACTION: QUESTION',
  'ON APPROVE: your decision comment is taken as the ANSWER and the card returns to TODO to be re-driven with it. Approving with an EMPTY comment supplies no answer and leaves the card in BLOCKED.',
  'ON REJECT: the card stays in BLOCKED.',
].join('\n');

/** The OLDER format — no ON APPROVE / ON REJECT, generic trailer instead. */
const OLD_FORMAT = [
  'Validate Draft Data: PROPOSITION for card 1855542337409648090 (development_feature_new)',
  'BLOCK REASON [open_questions, source=derived-from-block-reason-field]: block reason: failed_step: validate',
  'VERDICT: needs_info -> DOING',
  'PROPOSED_ACTION: QUESTION',
  'Approve to execute the proposed action. Reject to hold the card in BLOCKED.',
].join('\n');

describe('deblockActionOf', () => {
  it('reads a non-empty string action off metadata', () => {
    expect(deblockActionOf(withMetadata({ deblock_action: 'QUESTION' }))).toBe('QUESTION');
    expect(deblockActionOf(withMetadata({ deblock_action: '  RETRY  ' }))).toBe('RETRY');
  });

  it('is null for every non-string and every empty string', () => {
    expect(deblockActionOf(withMetadata(null))).toBeNull();
    expect(deblockActionOf(withMetadata(undefined))).toBeNull();
    expect(deblockActionOf(withMetadata({}))).toBeNull();
    expect(deblockActionOf(withMetadata({ deblock_action: null }))).toBeNull();
    expect(deblockActionOf(withMetadata({ deblock_action: 7 }))).toBeNull();
    expect(deblockActionOf(withMetadata({ deblock_action: ['QUESTION'] }))).toBeNull();
    expect(deblockActionOf(withMetadata({ deblock_action: { v: 'QUESTION' } }))).toBeNull();
    expect(deblockActionOf(withMetadata({ deblock_action: '' }))).toBeNull();
    expect(deblockActionOf(withMetadata({ deblock_action: '   ' }))).toBeNull();
  });

  it('does not narrow to the closed enum — an unknown action is reported as sent', () => {
    expect(deblockActionOf(withMetadata({ deblock_action: 'ESCALATE' }))).toBe('ESCALATE');
  });
});

describe('isQuestion', () => {
  it('true for QUESTION in any casing', () => {
    expect(isQuestion(withMetadata({ deblock_action: 'QUESTION' }))).toBe(true);
    expect(isQuestion(withMetadata({ deblock_action: 'question' }))).toBe(true);
    expect(isQuestion(withMetadata({ deblock_action: ' Question ' }))).toBe(true);
  });

  // Negative controls: widening past QUESTION would demand an answer from most
  // of the queue and disable bulk approve for rows that are approvable as-is.
  it.each(['RETRY', 'SPLIT', 'INFRASTRUCTURE', 'DEPENDENCY', 'DROP', 'MERGE'])(
    'false for %s',
    (action: string) => {
      expect(isQuestion(withMetadata({ deblock_action: action }))).toBe(false);
    },
  );

  it('false for an action-less row', () => {
    expect(isQuestion(withMetadata({}))).toBe(false);
    expect(isQuestion(withMetadata(null))).toBe(false);
  });

  it('false for a string that merely contains QUESTION', () => {
    expect(isQuestion(withMetadata({ deblock_action: 'QUESTION_RETRY' }))).toBe(false);
  });
});

describe('answerRequired', () => {
  const question = withMetadata({ deblock_action: 'QUESTION' });
  const retry = withMetadata({ deblock_action: 'RETRY' });

  it('true only for approving a QUESTION', () => {
    expect(answerRequired(question, 'approved')).toBe(true);
  });

  it('false when rejecting a QUESTION — the server exempts rejection', () => {
    expect(answerRequired(question, 'rejected')).toBe(false);
  });

  it('false for a non-question in either direction', () => {
    expect(answerRequired(retry, 'approved')).toBe(false);
    expect(answerRequired(retry, 'rejected')).toBe(false);
    expect(answerRequired(withMetadata({}), 'approved')).toBe(false);
  });

  // ── (a) THE HALF THAT WAS MISSING ──────────────────────────────────────────
  //
  // MEASURED ON PROD 2026-09-10, not inferred: of 1040 pending approvals, exactly
  // 15 carried a non-empty `metadata.open_questions` — a real, readable question —
  // and ALL 15 had `deblock_action` NULL. Gated on `isQuestion` alone, no fr
  // surface ever offered those rows an answer box, so the only rows on the queue
  // that ask a human something were the only rows a human could not answer.
  const CARRIER =
    'Goal-tree: decision "Set project_type to feature" does not trace to a necessary condition/objective';

  it('(a) true for a row that STATES a question, with NO deblock_action at all', () => {
    const stated = withMetadata({ open_questions: [CARRIER] });
    // The row is not typed QUESTION and never was — that is the measured shape.
    expect(isQuestion(stated)).toBe(false);
    expect(answerRequired(stated, 'approved')).toBe(true);
  });

  it('(a) true for a stated question sitting on a non-QUESTION action', () => {
    expect(answerRequired(withMetadata({ deblock_action: 'RETRY', open_questions: ['Which branch?'] }), 'approved')).toBe(
      true,
    );
  });

  it('(a) still exempt on REJECT — rejecting a question is a legitimate terminal', () => {
    expect(answerRequired(withMetadata({ open_questions: [CARRIER] }), 'rejected')).toBe(false);
  });

  it('(a) an UNREADABLE open_questions is not a stated question', () => {
    // `[object Object]` is the producer defect, not something anyone was asked, so
    // it must not manufacture a demand on a row that is otherwise decidable.
    expect(answerRequired(withMetadata({ open_questions: [{ q: 'nested' }] }), 'approved')).toBe(
      false,
    );
    expect(answerRequired(withMetadata({ open_questions: [] }), 'approved')).toBe(false);
  });

  // ── (b) THE HALF THAT MUST *NOT* CHANGE ────────────────────────────────────
  it('⛔ (b) STAYS true for a typed QUESTION that states no question', () => {
    // ⛔ DO NOT "FIX" THE 137 UNSTATED ROWS BY DROPPING THIS. It reads like the
    // same inversion backwards — fr demanding an answer where nothing was asked —
    // and it is not. `approval-callback.json :: Resolve Target List` computes
    // `questionAnswered = action === 'QUESTION' && decision === 'approved' &&
    // answerText.length > 0` and never reads `open_questions`, so an empty approve
    // on one of these takes the HOLDING branch, stamps `approval_answer_missing`,
    // and SPENDS the row — no second decision is accepted from the same approver,
    // so nothing can release the card afterwards. Removing the demand converts a
    // refusal into a one-click permanent strand on the largest population it
    // protects. The honest remedy for these rows is UNSTATED_QUESTION_NOTICE,
    // which says the producer asked nothing and steers to reject — which is exempt.
    expect(
      answerRequired(
        withMetadata({ deblock_action: 'QUESTION', gate_terms: ['watchdog_stall_unspecified'] }),
        'approved',
      ),
    ).toBe(true);
    expect(
      answerRequired(withMetadata({ deblock_action: 'QUESTION', open_questions: [] }), 'approved'),
    ).toBe(true);
  });
});

describe('validateAnswer', () => {
  it('accepts any text with a non-space character, and reports no reason', () => {
    expect(validateAnswer('yes, ship it')).toEqual({ ok: true, reason: null });
    expect(validateAnswer('  x  ')).toEqual({ ok: true, reason: null });
  });

  it('rejects empty, missing and whitespace-only answers', () => {
    for (const bad of ['', '   ', '\t', '\n', ' \n\t ', null, undefined]) {
      expect(validateAnswer(bad).ok).toBe(false);
    }
  });

  it('names the consequence — a spent approval and a card left BLOCKED', () => {
    const { reason } = validateAnswer('');
    expect(reason).toContain('BLOCKED');
    expect(reason).toContain('approval_answer_missing');
    expect(reason).toMatch(/reject/i);
  });
});

describe('brokenGateTermsOf', () => {
  it('returns only the terms in the broken set, in declared order', () => {
    const a = withMetadata({ gate_terms: ['ready_signoff', 'evidence_gap', 'no_procedure'] });
    expect(brokenGateTermsOf(a)).toEqual(['evidence_gap', 'no_procedure']);
  });

  it('returns [] when nothing declared is broken', () => {
    expect(brokenGateTermsOf(withMetadata({ gate_terms: ['ready_signoff'] }))).toEqual([]);
  });

  it('returns [] for absent / null / string / non-array gate_terms', () => {
    expect(brokenGateTermsOf(withMetadata({}))).toEqual([]);
    expect(brokenGateTermsOf(withMetadata(null))).toEqual([]);
    expect(brokenGateTermsOf(withMetadata({ gate_terms: null }))).toEqual([]);
    expect(brokenGateTermsOf(withMetadata({ gate_terms: 'evidence_gap' }))).toEqual([]);
    expect(brokenGateTermsOf(withMetadata({ gate_terms: { 0: 'evidence_gap' } }))).toEqual([]);
  });

  it('drops non-string members without throwing and keeps the strings', () => {
    const a = withMetadata({ gate_terms: [null, 42, { t: 'evidence_gap' }, 'authoring_gap'] });
    expect(brokenGateTermsOf(a)).toEqual(['authoring_gap']);
  });

  it('mirrors the five built-in server terms and the override floor', () => {
    expect([...BROKEN_GATE_TERMS].sort()).toEqual([
      'authoring_gap',
      'brief_write_failed',
      'decision_authoring_gap',
      'evidence_gap',
      'no_procedure',
    ]);
    expect(BROKEN_GATE_OVERRIDE_MIN_REASON).toBe(30);
  });
});

describe('validateOverrideReason', () => {
  // ⛔ `canOverride` IS PART OF THE PREDICATE. A surface that validated only the
  // text would show a satisfied-looking Approve to a non-super-admin, which 422s on
  // click — the exact shape this change exists to remove.
  const MIN = BROKEN_GATE_OVERRIDE_MIN_REASON;
  const TOO_SHORT = 'x'.repeat(MIN - 1);
  const AT_FLOOR = 'x'.repeat(MIN);

  it('refuses a non-super-admin at every text length, including a long one', () => {
    for (const text of ['', TOO_SHORT, AT_FLOOR, 'y'.repeat(MIN * 10), null, undefined]) {
      expect(validateOverrideReason(text, false).ok).toBe(false);
    }
  });

  it('tells a non-super-admin the truth — reject is open, and offers no length target', () => {
    const { reason } = validateOverrideReason(AT_FLOOR, false);
    expect(reason).toContain('Only a super-admin can override');
    expect(reason).toMatch(/reject/i);
    // No `n/30` counter: there is no text this viewer can type that is accepted,
    // so a progress figure would point at a door that does not open.
    expect(reason).not.toMatch(/\d+\/\d+/);
  });

  it('refuses a super-admin one character short, and counts the shortfall', () => {
    const v = validateOverrideReason(TOO_SHORT, true);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(`${MIN - 1}/${MIN}`);
  });

  it(`accepts a super-admin at exactly ${BROKEN_GATE_OVERRIDE_MIN_REASON} characters`, () => {
    expect(validateOverrideReason(AT_FLOOR, true)).toEqual({ ok: true, reason: null });
    expect(validateOverrideReason(`${AT_FLOOR}x`, true).ok).toBe(true);
  });

  it('trims — padding is not an argument', () => {
    // Raw length clears the floor; the trimmed text does not. The server trims, so
    // accepting this here would offer an Approve the server refuses.
    const padded = `    ${TOO_SHORT}    `;
    expect(padded.length).toBeGreaterThan(MIN);
    expect(validateOverrideReason(padded, true).ok).toBe(false);
    expect(validateOverrideReason(' '.repeat(MIN * 2), true).ok).toBe(false);
    // ...and padding around a reason that is long enough on its own is harmless.
    expect(validateOverrideReason(`  ${AT_FLOOR}  `, true).ok).toBe(true);
  });
});

describe('ANSWER_CONTRACT', () => {
  it('states both halves — what approving with an answer does, and without one', () => {
    expect(ANSWER_CONTRACT).toContain('ANSWER');
    expect(ANSWER_CONTRACT).toContain('TODO');
    expect(ANSWER_CONTRACT).toContain('BLOCKED');
    expect(ANSWER_CONTRACT).toMatch(/empty answer/i);
  });
});

describe('parseProposition — newer format', () => {
  const p = parseProposition(NEW_FORMAT);

  it('takes the title from before the PROPOSITION marker', () => {
    expect(p.title).toBe('Validate Draft Data and Project Linkage');
  });

  it('reads each labelled section without its label or provenance bracket', () => {
    expect(p.blockReason).toBe('block reason: failed_step: validate');
    expect(p.verdict).toBe('needs_info -> DOING');
    expect(p.procedure).toBe(
      'development_feature_new.blocked.action (ingest_block_context [mental_step] -> ask)',
    );
    expect(p.learning).toBe(
      'BLOCKED open_questions on development_feature_new  [signature open-questions::abc, stream __system_prompt__]',
    );
    expect(p.proposedAction).toBe('QUESTION');
  });

  it('splits ISSUES on the semicolon separator', () => {
    expect(p.issues).toEqual(['first issue.', 'second issue.', 'third issue.']);
  });

  it('captures ON APPROVE and ON REJECT', () => {
    expect(p.onApprove).toContain('the card returns to TODO');
    expect(p.onReject).toBe('the card stays in BLOCKED.');
  });

  it('is parsed, and keeps raw byte-identical', () => {
    expect(p.parsed).toBe(true);
    expect(p.raw).toBe(NEW_FORMAT);
  });

  it('parses sections in a different order and tolerates missing ones', () => {
    const reordered = parseProposition(
      ['PROPOSED_ACTION: QUESTION', 'VERDICT: needs_info -> DOING'].join('\n'),
    );
    expect(reordered.proposedAction).toBe('QUESTION');
    expect(reordered.verdict).toBe('needs_info -> DOING');
    expect(reordered.blockReason).toBeNull();
    expect(reordered.procedure).toBeNull();
    expect(reordered.learning).toBeNull();
    expect(reordered.onApprove).toBeNull();
    expect(reordered.issues).toEqual([]);
    expect(reordered.parsed).toBe(true);
  });

  it('carries a wrapped section body onto its own field', () => {
    const wrapped = parseProposition(
      ['VERDICT: needs_info -> DOING', 'because the draft has no project link', 'ISSUES: only one.'].join(
        '\n',
      ),
    );
    expect(wrapped.verdict).toBe('needs_info -> DOING\nbecause the draft has no project link');
    expect(wrapped.issues).toEqual(['only one.']);
  });
});

describe('parseProposition — older format', () => {
  const p = parseProposition(OLD_FORMAT);

  it('still parses, with onApprove and onReject null', () => {
    expect(p.parsed).toBe(true);
    expect(p.proposedAction).toBe('QUESTION');
    expect(p.verdict).toBe('needs_info -> DOING');
    expect(p.onApprove).toBeNull();
    expect(p.onReject).toBeNull();
  });

  it('does not swallow the generic trailer into the last section', () => {
    expect(p.proposedAction).toBe('QUESTION');
    expect(p.proposedAction).not.toContain('Approve to execute');
    expect(p.blockReason).not.toContain('Approve to execute');
  });
});

describe('parseProposition — real-data damage passes through verbatim', () => {
  it('does not choke on, or clean away, a stringified [object Object]', () => {
    const src = [
      'Ingest Block Context: PROPOSITION for card 1855542337409648090 (development_feature_new)',
      'BLOCK REASON [open_questions]: block reason: [object Object] could not be resolved',
      'PROPOSED_ACTION: QUESTION',
    ].join('\n');
    const p = parseProposition(src);
    expect(p.parsed).toBe(true);
    expect(p.blockReason).toBe('block reason: [object Object] could not be resolved');
    expect(p.raw).toBe(src);
  });

  it('parses a description truncated mid-word without throwing', () => {
    const src = [
      'Validate Draft Data: PROPOSITION for card 1855542337409648090 (development_feature_new)',
      'BLOCK REASON [open_questions]: block reason: failed_step | failed step(s): step und',
    ].join('\n');
    const p = parseProposition(src);
    expect(p.parsed).toBe(true);
    expect(p.blockReason).toBe('block reason: failed_step | failed step(s): step und');
    expect(p.proposedAction).toBeNull();
  });

  it('an ISSUES body of only separators yields no issues', () => {
    expect(parseProposition('ISSUES:  ;  ; ').issues).toEqual([]);
  });
});

describe('parseProposition — unparseable input', () => {
  it('reports parsed false and preserves raw for arbitrary prose', () => {
    const src = 'the worker crashed and this text has no sections at all';
    const p = parseProposition(src);
    expect(p.parsed).toBe(false);
    expect(p.raw).toBe(src);
    expect(p.title).toBe(src);
    expect(p.blockReason).toBeNull();
    expect(p.verdict).toBeNull();
    expect(p.proposedAction).toBeNull();
    expect(p.issues).toEqual([]);
  });

  it('reports an empty, null or undefined description as unparsed with empty raw', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const p = parseProposition(empty);
      expect(p.parsed).toBe(false);
      expect(p.title).toBeNull();
      expect(p.raw).toBe(typeof empty === 'string' ? empty : '');
    }
  });
});

describe('parseProposition — content after the legacy trailer is never discarded', () => {
  // The trailer is a BOUNDARY, not the end of the document. It used to set the
  // cursor to null, which silently ate every following line while `parsed`
  // stayed true — the caller saw a confident parse with content missing.
  const AFTER_TRAILER_LABELLED = [
    ...OLD_FORMAT.split('\n'),
    'ON REJECT: the card stays in BLOCKED.',
  ].join('\n');

  it('populates a labelled section that follows the trailer, and leaves trailing null', () => {
    const p = parseProposition(AFTER_TRAILER_LABELLED);
    expect(p.onReject).toBe('the card stays in BLOCKED.');
    expect(p.proposedAction).toBe('QUESTION');
    // Nothing UNLABELLED followed, so there is no remainder to surface.
    expect(p.trailing).toBeNull();
  });

  it('surfaces unlabelled prose that follows the trailer on `trailing`', () => {
    const p = parseProposition(
      [OLD_FORMAT, 'Escalated by the on-call operator.', 'Second line of the same note.'].join('\n'),
    );
    expect(p.trailing).toBe('Escalated by the on-call operator.\nSecond line of the same note.');
    // ...and it is NOT attributed to the section the trailer closed.
    expect(p.proposedAction).toBe('QUESTION');
    expect(p.verdict).toBe('needs_info -> DOING');
    expect(p.parsed).toBe(true);
  });

  it('keeps both when prose and a labelled section follow the trailer', () => {
    const p = parseProposition(
      [OLD_FORMAT, 'operator note before the label', 'ON REJECT: the card stays in BLOCKED.'].join(
        '\n',
      ),
    );
    expect(p.trailing).toBe('operator note before the label');
    expect(p.onReject).toBe('the card stays in BLOCKED.');
  });

  it('never leaks the trailer sentence itself into a section or into trailing', () => {
    const p = parseProposition([OLD_FORMAT, 'a trailing operator note'].join('\n'));
    expect(p.trailing).toBe('a trailing operator note');
    expect(p.trailing).not.toContain('Approve to execute');
    expect(p.proposedAction).toBe('QUESTION');
    expect(p.proposedAction).not.toContain('Approve to execute');
    expect(p.blockReason).not.toContain('Approve to execute');
    expect(p.onApprove).toBeNull();
  });

  it('trailing alone does not make an unlabelled description report as parsed', () => {
    const src = ['Approve to execute the proposed action.', 'just some prose'].join('\n');
    const p = parseProposition(src);
    expect(p.trailing).toBe('just some prose');
    expect(p.parsed).toBe(false);
    expect(p.raw).toBe(src);
  });
});

describe('cardMoveOnApprove — what the button actually does to the card', () => {
  const row = (deblock_action?: string) => ({ metadata: deblock_action ? { deblock_action } : {} });

  // ⭐ Mirrors `approval-callback.json :: Resolve Target List :: ACTION_TARGET`.
  // If that map changes and this does not, the button describes a move the card
  // will not make — worse than saying nothing.
  it('mirrors the receiver: DROP→DROPPED (never DONE), SPLIT→READY, RETRY→TODO', () => {
    expect(cardMoveOnApprove(row('DROP'))).toBe('DROPPED');
    expect(cardMoveOnApprove(row('SPLIT'))).toBe('READY');
    expect(cardMoveOnApprove(row('RETRY'))).toBe('TODO');
  });

  // ⭐ CHANGED 2026-09-14, IN LOCKSTEP WITH THE RECEIVER. This case used to read
  // "returns null for the actions that HOLD the card" over
  // ['QUESTION','INFRASTRUCTURE','DEPENDENCY']. INFRASTRUCTURE and DEPENDENCY
  // now MOVE on approve — the product owner's rule is that approving one means
  // "I have fixed it, try again" — so the receiver's `ACTION_TARGET` gains both
  // keys and this map must gain them on the same commit. The old hold was
  // TERMINAL (nothing in the estate drained `approval_hold:INFRASTRUCTURE`), so
  // approve and reject were byte-identical outcomes on 214 pending rows.
  it('mirrors the receiver: INFRASTRUCTURE→TODO and DEPENDENCY→TODO', () => {
    expect(cardMoveOnApprove(row('INFRASTRUCTURE'))).toBe('TODO');
    expect(cardMoveOnApprove(row('DEPENDENCY'))).toBe('TODO');
  });

  it('QUESTION is the ONLY action that still holds, and is the discriminating half', () => {
    // ⭐ THE PAIR. Without this, "INFRASTRUCTURE→TODO" is also satisfied by an
    // implementation that maps EVERY action to TODO — which would silently start
    // promising a re-drive on a QUESTION row, where the receiver holds until an
    // answer arrives and the answer, not the approve, is what releases it.
    expect(cardMoveOnApprove(row('QUESTION'))).toBeNull();
    expect(cardMoveOnApprove(row('question'))).toBeNull();
  });

  // MERGE is not a plain move: the receiver attempts the pull-request merge first
  // and advances the card only if it lands. Promising 'moves the card to DONE'
  // would be a claim the receiver does not honour.
  it('returns null for MERGE, which is conditional on the merge succeeding', () => {
    expect(cardMoveOnApprove(row('MERGE'))).toBeNull();
  });

  it('returns null when there is no action at all', () => {
    expect(cardMoveOnApprove(row())).toBeNull();
    expect(cardMoveOnApprove(row('   '))).toBeNull();
  });

  it('is case-insensitive, matching deblockActionOf/isQuestion', () => {
    expect(cardMoveOnApprove(row('retry'))).toBe('TODO');
  });

  it('the notice names the destination, and says it is not a sign-off', () => {
    const notice = approveMoveNotice(row('RETRY'));
    expect(notice).toContain('TODO');
    expect(notice).toContain('not a sign-off');
    expect(approveMoveNotice(row('QUESTION'))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER SIDE OF THE SAME MIRROR — what approving does when it moves NO card.
//
// ⛔ THE DEFECT THESE PIN. `approveMoveNotice` is `null` for every action absent
// from ACTION_CARD_MOVE, and `null` renders as SILENCE — the operator clicked
// Approve and the surface said nothing about what that did. Measured 2026-09-13:
// of 458 human Approve clicks only 73 moved a card; 161 INFRASTRUCTURE and 6
// DEPENDENCY approvals were HELD.
//
// ⭐ EVERY CASE BELOW IS WRITTEN AS A DISCRIMINATING PAIR, because the two cheap
// wrong implementations both pass a one-sided test:
//   * "always return a sentence" passes every hold assertion — killed by the
//     RETRY control, which must still produce the MOVE sentence naming TODO;
//   * "the function is dead / returns null" passes every null assertion — killed
//     by the INFRASTRUCTURE control opposite each null case.
// ─────────────────────────────────────────────────────────────────────────────
describe('approveHoldNotice — the actions whose approve moves nothing', () => {
  const row = (deblock_action?: string) => ({ metadata: deblock_action ? { deblock_action } : {} });

  // ⭐ REPLACED 2026-09-14. Two cases stood here — "INFRASTRUCTURE says, in
  // words, that the card does NOT move and nothing drains it" and "DEPENDENCY
  // holds on the blocking card, not on an infrastructure fault" — and both
  // asserted a hold that the receiver no longer performs on approve. Their
  // measurements were right and are exactly why the behaviour changed: a hold
  // nothing drains is a sink, not a wait. The hold copy for those two actions is
  // DELETED rather than left unreachable, because a dead branch that contradicts
  // the live one is a stale comment with a `return` in it.
  it('INFRASTRUCTURE and DEPENDENCY produce NO hold sentence — they move now', () => {
    expect(approveHoldNotice(row('INFRASTRUCTURE'))).toBeNull();
    expect(approveHoldNotice(row('DEPENDENCY'))).toBeNull();
    expect(approveHoldNotice(row('infrastructure'))).toBeNull();
  });

  it('CONTROL — and the MOVE half DOES speak for them, naming TODO', () => {
    // ⭐ THE DISCRIMINATING HALF, and the one that catches the wrong way to make
    // the case above pass: deleting the entries from ACTION_CARD_MOVE as well
    // would silence BOTH helpers and leave the operator with no sentence at all,
    // which is the SILENCE defect this whole section exists to close.
    for (const action of ['INFRASTRUCTURE', 'DEPENDENCY']) {
      const notice = approveMoveNotice(row(action));
      expect(notice).not.toBeNull();
      expect(notice).toContain('moves the card to TODO');
      expect(notice).toContain('not a sign-off');
    }
  });

  it('each states the CLAIM the approver is making, and the two differ', () => {
    // ⛔ WHY THE PLAIN MOVE SENTENCE IS NOT ENOUGH HERE. On DROP/SPLIT/RETRY the
    // destination tells the human what they did. On these two it does not: until
    // 2026-09-14 they HELD, so a decider taught by the old behaviour reads
    // Approve as agreement with a diagnosis. It now asserts something about the
    // WORLD, and the card is re-driven on that assertion.
    const infra = approveMoveNotice(row('INFRASTRUCTURE'));
    const dep = approveMoveNotice(row('DEPENDENCY'));
    expect(infra).toMatch(/infrastructure fault is FIXED/i);
    expect(dep).toMatch(/blocking dependency is RESOLVED/i);
    // CONTROL against one hard-coded sentence serving both: they assert
    // DIFFERENT things and must not be described alike.
    expect(infra).not.toBe(dep);
    expect(dep).not.toMatch(/infrastructure fault/i);
    // CONTROL against the claim leaking onto actions that do not make one.
    expect(approveMoveNotice(row('RETRY'))).not.toMatch(/FIXED|RESOLVED/);
  });

  it('MERGE is described as conditional on the merge landing — never as a move to DONE', () => {
    const notice = approveHoldNotice(row('MERGE'));
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/pull-request merge/i);
    expect(notice).toMatch(/only if that merge lands/i);
    expect(notice).not.toContain('moves the card to');
  });

  // (b) THE QUESTION RULE, WITH ITS CONTROL.
  it('QUESTION is silent — its contract is stated once, next to the answer box', () => {
    // ⛔ The null here is the RULE, not an accident of an unimplemented action.
    // ANSWER_CONTRACT (and questionPresentation's notice) already state the
    // QUESTION contract beside the box; a second sentence in different words is
    // exactly how two surfaces drift apart.
    expect(approveHoldNotice(row('QUESTION'))).toBeNull();
    expect(approveHoldNotice(row('question'))).toBeNull();
  });

  it('CONTROL — MERGE is NOT null, so the QUESTION null is the rule and not a dead fn', () => {
    // Without this pair, `return null` for every input passes the test above.
    // ⚠️ The control used to be INFRASTRUCTURE; since 2026-09-14 that action
    // MOVES and its hold sentence is gone, so MERGE is the only remaining
    // speaking case and the only honest control.
    expect(approveHoldNotice(row('MERGE'))).not.toBeNull();
    expect(typeof approveHoldNotice(row('MERGE'))).toBe('string');
  });

  it('is case-insensitive, matching deblockActionOf/cardMoveOnApprove', () => {
    expect(approveHoldNotice(row('merge'))).toBe(approveHoldNotice(row('MERGE')));
  });

  // (c) AN UNMODELLED ACTION STAYS SILENT.
  it('an absent or unrecognised action produces NO sentence from any of the three helpers', () => {
    // `deblockActionOf` answers "what does the row SAY?", never "what will the
    // callback DO?" — so asserting an outcome for behaviour this file has not
    // mirrored would be inventing the mirror rather than reading it.
    for (const unmodelled of [undefined, '   ', 'BANANA', 'retry_but_not_really']) {
      const r = row(unmodelled);
      expect(approveHoldNotice(r)).toBeNull();
      expect(approveMoveNotice(r)).toBeNull();
      expect(approveConsequenceNotice(r)).toBeNull();
    }
    // Metadata absent entirely, not merely action-less.
    expect(approveHoldNotice({ metadata: null } as never)).toBeNull();
    expect(approveConsequenceNotice({ metadata: null } as never)).toBeNull();
  });

  it('CONTROL — the same three helpers DO speak for a modelled action', () => {
    // The pair for the case above: a blanket `return null` satisfies it otherwise.
    // ⚠️ The hold control moved from INFRASTRUCTURE to MERGE on 2026-09-14 — the
    // former now MOVES, so it can no longer witness the hold helper being alive.
    expect(approveHoldNotice(row('MERGE'))).not.toBeNull();
    expect(approveMoveNotice(row('RETRY'))).not.toBeNull();
    expect(approveConsequenceNotice(row('RETRY'))).not.toBeNull();
    expect(approveConsequenceNotice(row('INFRASTRUCTURE'))).not.toBeNull();
  });

  it('⛔ THE TWO MAPS ARE DISJOINT — no action may both move and hold', () => {
    // ⭐ THIS IS THE ASSERTION THAT ACTUALLY FAILS IF THE TWO SIDES OF THE MIRROR
    // DIVERGE. An action
    // present in both would make the UI describe a move AND a hold for one row.
    for (const held of ['QUESTION']) {
      expect(cardMoveOnApprove(row(held))).toBeNull();
      expect(approveMoveNotice(row(held))).toBeNull();
    }
    // The other direction: every action that MOVES must produce no hold sentence.
    for (const moving of ['DROP', 'SPLIT', 'RETRY', 'INFRASTRUCTURE', 'DEPENDENCY']) {
      expect(cardMoveOnApprove(row(moving))).not.toBeNull();
      expect(approveHoldNotice(row(moving))).toBeNull();
    }
  });

  // ⛔ APPROVE MOVES; LAPSE AND REJECT DO NOT. The receiver keeps that asymmetry
  // structurally (`ctx.decision !== 'approved'` is tested BEFORE ACTION_TARGET is
  // consulted), and nothing in this module may quietly speak for a non-approve
  // decision. An EXPIRED infrastructure approval must still HOLD: an expiry is a
  // deadline passing, not a human saying "I fixed it".
  it('every helper in this file is APPROVE-scoped and says nothing about a lapse', () => {
    // The only helper here that takes a decision at all refuses to demand
    // anything of a non-approve, for INFRASTRUCTURE exactly as for QUESTION.
    expect(answerRequired(row('INFRASTRUCTURE') as never, 'rejected')).toBe(false);
    expect(answerRequired(row('QUESTION') as never, 'rejected')).toBe(false);
    // CONTROL — the same predicate DOES fire on approve, so the false above is
    // the decision term and not a dead function.
    expect(answerRequired(row('QUESTION') as never, 'approved')).toBe(true);
    // And the move helpers are named for approve and parameterised by NOTHING
    // else: they cannot be handed 'expired', so no caller can obtain a
    // lapse-target from this module at all.
    expect(approveMoveNotice(row('INFRASTRUCTURE'))).toMatch(/^Approving states/);
  });
});

// (a) THE ONE FUNCTION THE UI CALLS, AND THE PRECEDENCE BETWEEN ITS TWO HALVES.
describe('approveConsequenceNotice — move first, then hold, then silence', () => {
  const row = (deblock_action?: string) => ({ metadata: deblock_action ? { deblock_action } : {} });

  // ⭐ INVERTED 2026-09-14. This case asserted that an INFRASTRUCTURE row is
  // described by the HOLD half. It is now described by the MOVE half, because
  // the receiver moves it; the case is kept (rather than deleted) so the
  // inversion is visible in the diff instead of the coverage silently vanishing.
  it('an INFRASTRUCTURE row gets the MOVE sentence, naming TODO', () => {
    const notice = approveConsequenceNotice(row('INFRASTRUCTURE'));
    expect(notice).not.toBeNull();
    expect(notice).toContain('moves the card to TODO');
    expect(notice).toBe(approveMoveNotice(row('INFRASTRUCTURE')));
    expect(notice).not.toContain('does NOT move the card');
    // ...and the hold half genuinely has nothing to say for it any more, so the
    // equality above is the precedence and not a coincidence.
    expect(approveHoldNotice(row('INFRASTRUCTURE'))).toBeNull();
  });

  it('CONTROL — MERGE still reaches the HOLD half through the same wrapper', () => {
    // ⭐ THE PAIR for the case above. Without it, "the wrapper always returns the
    // MOVE sentence" passes, and MERGE — whose advance is conditional on a pull
    // request actually landing — would be described as an unconditional move.
    const notice = approveConsequenceNotice(row('MERGE'));
    expect(notice).toBe(approveHoldNotice(row('MERGE')));
    expect(notice).not.toContain('moves the card to');
    expect(approveMoveNotice(row('MERGE'))).toBeNull();
  });

  it('CONTROL — a RETRY row gets the MOVE sentence naming TODO, not the hold copy', () => {
    // ⭐ THE DISCRIMINATING HALF. Without it, "always return the hold sentence"
    // and "always return SOMETHING non-null" both pass the case above, and the
    // button would promise a hold on a row that really does move the card.
    const notice = approveConsequenceNotice(row('RETRY'));
    expect(notice).not.toBeNull();
    expect(notice).toContain('TODO');
    expect(notice).toContain('not a sign-off');
    expect(notice).toBe(approveMoveNotice(row('RETRY')));
    expect(notice).not.toContain('does NOT move the card');
    // ...and the hold half genuinely has nothing to say for RETRY, so the
    // equality above is the precedence and not a coincidence.
    expect(approveHoldNotice(row('RETRY'))).toBeNull();
  });

  it('every moving action is described by its MOVE, every held one by its HOLD', () => {
    for (const [action, target] of [
      ['DROP', 'DROPPED'],
      ['SPLIT', 'READY'],
      ['RETRY', 'TODO'],
    ] as const) {
      expect(approveConsequenceNotice(row(action))).toContain(target);
      expect(approveConsequenceNotice(row(action))).toContain('moves the card to');
    }
    for (const [action, target] of [
      ['INFRASTRUCTURE', 'TODO'],
      ['DEPENDENCY', 'TODO'],
    ] as const) {
      expect(approveConsequenceNotice(row(action))).toContain(target);
      expect(approveConsequenceNotice(row(action))).toContain('moves the card to');
    }
    // MERGE is the only action left that the wrapper describes with a HOLD.
    expect(approveConsequenceNotice(row('MERGE'))).toBe(approveHoldNotice(row('MERGE')));
    expect(approveConsequenceNotice(row('MERGE'))).not.toContain('moves the card to');
  });

  it('QUESTION stays silent through the wrapper too', () => {
    expect(approveConsequenceNotice(row('QUESTION'))).toBeNull();
    // CONTROL, again: the wrapper is not simply mute.
    expect(approveConsequenceNotice(row('DROP'))).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE QUESTION ITSELF — `metadata.open_questions`
//
// ⛔ THE DEFECT THESE PIN IS A SHAPE, NOT A COUNT — and these tests are written
// against the shape deliberately. `deblock_action = 'QUESTION'` (what makes fr
// DEMAND an answer, and what the server hard-422s an empty approve on) and
// `metadata.open_questions` (the only field holding question TEXT) are
// INDEPENDENT: neither implies the other, in either direction, and every case
// below is written over one shape at a time for that reason.
//
// ⚠️ CORRECTED 2026-09-14 — this block used to say the two have an "EMPTY
// INTERSECTION: no row that demands an answer states a question, and no row that
// states a question demands an answer", citing two instruments at two scopes on
// 2026-09-10. That was a true reading of the producer's output on that day and is
// FALSE now: 117 of 179 pending QUESTION rows carry question text, so the
// intersection is the majority of them. Nothing here needed changing, which is
// the point — the tests pinned the shape and survived; the PROSE pinned a
// population and rotted. ⛔ Do not restore "disjoint" from a future zero either.
//
// ⚠️ DO NOT PIN A COUNT IN THIS FILE. It rots within days and the instruments do
// not agree on it. Pin the shape; quote a number only with its instrument and its
// date, e.g. "0 of 98 pending QUESTION rows carried open_questions (approvals API,
// 2026-09-10)".
//
// Before `openQuestionsOf`, nothing on the approvals surface read `open_questions`
// at all, so fr demanded an answer on exactly the rows that state no question and
// marked as unanswerable the only rows that do.
// ─────────────────────────────────────────────────────────────────────────────
describe('openQuestionsOf', () => {
  it('reads the producer question text off metadata.open_questions', () => {
    expect(
      openQuestionsOf(withMetadata({ open_questions: ['Which repo should this land in?'] })),
    ).toEqual(['Which repo should this land in?']);
  });

  // ⛔ IT IS AN ARRAY AND EVERY MEMBER IS A REAL QUESTION. A measured value is a
  // long, genuinely answerable English sentence (verbatim, truncated):
  //   "No specific requirement candidate explicitly covers the 'linking' action of
  //    the approved requirement to the project, which is part of the card objective
  //    ('Requirement approved and linked'). …"
  // An accessor that returned `raw[0]` and stopped would silently drop questions a
  // human was asked, and every single-question test above would still pass.
  it('reads EVERY member, in the order the producer declared them', () => {
    const real = [
      "No specific requirement candidate explicitly covers the 'linking' action of the approved " +
        "requirement to the project, which is part of the card objective ('Requirement approved " +
        "and linked').",
      'Should the link be created against the draft, or only once the requirement is approved?',
    ];
    const got = openQuestionsOf(withMetadata({ open_questions: real }));
    expect(got).toEqual(real);
    expect(got).toHaveLength(2);
  });

  it('accepts a bare string as a single question', () => {
    expect(openQuestionsOf(withMetadata({ open_questions: '  Which environment?  ' }))).toEqual([
      'Which environment?',
    ]);
  });

  it('is [] for every absence: missing key, null, empty array, blank string', () => {
    expect(openQuestionsOf(withMetadata({}))).toEqual([]);
    expect(openQuestionsOf(withMetadata(null))).toEqual([]);
    expect(openQuestionsOf(withMetadata({ open_questions: null }))).toEqual([]);
    expect(openQuestionsOf(withMetadata({ open_questions: [] }))).toEqual([]);
    expect(openQuestionsOf(withMetadata({ open_questions: '   ' }))).toEqual([]);
    expect(openQuestionsOf(withMetadata({ open_questions: ['', '  '] }))).toEqual([]);
  });

  it('DROPS a non-string member rather than stringifying it to [object Object]', () => {
    expect(
      openQuestionsOf(withMetadata({ open_questions: ['real?', { q: 'nested' }, 7] })),
    ).toEqual(['real?']);
  });

  it('hasStatedQuestion agrees with it', () => {
    expect(hasStatedQuestion(withMetadata({ open_questions: ['q?'] }))).toBe(true);
    expect(hasStatedQuestion(withMetadata({ deblock_action: 'QUESTION' }))).toBe(false);
  });
});

describe('questionPresentation', () => {
  it('the measured QUESTION shape: typed QUESTION carrying NO question reports `unstated`', () => {
    const row = withMetadata({
      deblock_action: 'QUESTION',
      gate_terms: ['watchdog_stall_unspecified'],
    });
    const p = questionPresentation(row);
    expect(p.state).toBe('unstated');
    expect(p.questions).toEqual([]);
    // The server still refuses an empty approve on it — that is not softened.
    expect(p.answerDemanded).toBe(true);
    expect(p.notice).toBe(UNSTATED_QUESTION_NOTICE);
  });

  it('the measured carrier shape: a stated question with deblock_action null reports `unrouted`, WITH its text', () => {
    const row = withMetadata({ open_questions: ['Should the canary be extended?'] });
    const p = questionPresentation(row);
    expect(p.state).toBe('unrouted');
    expect(p.questions).toEqual(['Should the canary be extended?']);
    // The server does not demand text here, and the notice must not pretend the
    // card moves: it is persisted + forwarded, but no callback action runs.
    expect(p.answerDemanded).toBe(false);
    expect(p.notice).toBe(UNROUTED_QUESTION_NOTICE);
  });

  // The shape NO measured row has ever had — implemented because it is the shape
  // the producer is supposed to emit, and a surface that only handled the broken
  // ones would break the day the producer was fixed.
  it('the happy path: typed QUESTION that states its question is `stated` with no caveat', () => {
    const p = questionPresentation(
      withMetadata({ deblock_action: 'QUESTION', open_questions: ['Which branch?'] }),
    );
    expect(p.state).toBe('stated');
    expect(p.questions).toEqual(['Which branch?']);
    expect(p.answerDemanded).toBe(true);
    expect(p.notice).toBeNull();
  });

  it('an ordinary row is `none` and gets no notice', () => {
    const p = questionPresentation(withMetadata({ deblock_action: 'RETRY' }));
    expect(p.state).toBe('none');
    expect(p.notice).toBeNull();
  });

  it('an UNREADABLE open_questions is not reported as an absence', () => {
    const p = questionPresentation(
      withMetadata({ deblock_action: 'QUESTION', open_questions: [{ q: 'nested' }] }),
    );
    expect(p.state).toBe('unstated');
    expect(p.notice).toBe(UNREADABLE_QUESTION_NOTICE);
    expect(p.notice).not.toBe(UNSTATED_QUESTION_NOTICE);
  });

  it('an EMPTY open_questions is a plain absence, not an unreadable value', () => {
    expect(
      questionPresentation(withMetadata({ deblock_action: 'QUESTION', open_questions: [] })).notice,
    ).toBe(UNSTATED_QUESTION_NOTICE);
  });

  // ⚠️ INVERTED, DELIBERATELY. This test used to assert
  // `answerRequired(stated, 'approved') === false` — it pinned the defect AS the
  // spec, and its stated reason was that widening would leave "most of the queue"
  // un-bulk-approvable. That fear was never measured, and the measurement refutes
  // it: on 2026-09-10, 15 of 1040 pending rows (1.4%) carry a non-empty
  // `open_questions`. RETRY (442), INFRASTRUCTURE (244), SPLIT, DEPENDENCY, MERGE
  // and every action-less row that states nothing are untouched — the negative
  // controls in `describe('answerRequired')` assert exactly that. What the old
  // assertion actually protected was the inversion itself: the answer box rendered
  // on the 137 rows that state no question and withheld from the only 15 that do.
  //
  // ⛔ WHAT IS *NOT* WIDENED, AND MUST NOT BE, IS `isQuestion`. It mirrors the n8n
  // receiver's `deblock_action === 'QUESTION'` branch and decides what the card
  // move MEANS; `questionPresentation` still reports `unrouted` here precisely
  // because approving this row re-drives no card. Two different questions, still
  // two different predicates — only the ANSWER DEMAND is the union of them.
  it('⛔ widens answerRequired but NOT isQuestion — the two stay distinct', () => {
    const stated = withMetadata({ open_questions: ['Should the canary be extended?'] });
    expect(isQuestion(stated)).toBe(false);
    expect(answerRequired(stated, 'approved')).toBe(true);
    expect(questionPresentation(stated).state).toBe('unrouted');
    // The bulk-approve carve-out follows `answerRequired`, so this row leaves the
    // bulk set — a bulk approve records no comment and the server now 422s it.
    expect(questionPresentation(stated).answerDemanded).toBe(false);
  });
});

describe('validateAnswer — the refusal must describe THIS row', () => {
  // ⛔ THE DEFECT, shipped by #1083 and measured LIVE on production before this fix.
  // Widening the answer box to rows that STATE a question but propose no deblock
  // action brought the QUESTION-typed refusal string along with it, so
  // /approvals/37afafb5-… rendered two incompatible claims a few lines apart:
  //   the notice   "This row states a question but proposes no deblock action …
  //                 answering here does not itself return the card to TODO"
  //   the refusal  "This approval is a QUESTION … the card stays BLOCKED with
  //                 block_reason approval_answer_missing"
  // The `approval_answer_missing` branch is n8n's QUESTION path, which an
  // unrouted row never reaches. Same self-contradiction class the PR set out to
  // remove, reintroduced by the fix for it.
  const empty = '';

  it('⛔ an UNROUTED row is not told it is a QUESTION', () => {
    const v = validateAnswer(empty, 'unrouted');
    expect(v.ok).toBe(false);
    expect(v.reason).not.toBeNull();
    expect(v.reason).not.toContain('This approval is a QUESTION');
    expect(v.reason).not.toContain('approval_answer_missing');
  });

  it('⛔ an UNROUTED row is not promised a mechanism it never reaches', () => {
    const v = validateAnswer(empty, 'unrouted');
    // It must still say the answer is what travels, and that reject is open.
    expect(v.reason).toContain('recorded on the');
    expect(v.reason).toContain('reject');
  });

  // ⚠️ MY FIRST VERSION OF THIS BLOCK PASSED VACUOUSLY. It used the state
  // `'answerable'`, which is not a member of QuestionState ('none' | 'stated' |
  // 'unstated' | 'unrouted'), so it fell through to the default branch and
  // asserted the default's text against a state that does not exist. vitest
  // strips types without checking them, so nothing in the pipeline would ever
  // have caught it — a green over a literal that means nothing.
  it.each(['stated', 'unstated'] as const)(
    'a QUESTION-typed row (%s) keeps the wording that is TRUE for it',
    (state) => {
      const v = validateAnswer(empty, state);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('This approval is a QUESTION');
      expect(v.reason).toContain('approval_answer_missing');
    },
  );

  it('no state given → the QUESTION wording, which is what every old caller meant', () => {
    const v = validateAnswer(empty);
    expect(v.reason).toContain('This approval is a QUESTION');
  });

  it('a non-empty answer is still accepted whatever the state', () => {
    expect(validateAnswer('an answer', 'unrouted').ok).toBe(true);
    expect(validateAnswer('an answer', 'stated').ok).toBe(true);
    expect(validateAnswer('an answer', 'unstated').ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX ASSERTION — the frontend half of the backend's `fix_assertion` demand.
//
// ⛔ THE DEAD END THIS PREVENTS. Since 2026-09-14 approving an INFRASTRUCTURE or
// DEPENDENCY hold re-drives the card to TODO, and the server refuses an EMPTY
// approve of one (`classifyAnswerDemand` → 'fix_assertion') because a re-drive can
// open a second pull request. If the UI demands no text there, the operator clicks
// Approve, gets a 422, and has no input to comply with — the original "Approve
// seemed to fail" report, rebuilt by this round's own fix.
// ─────────────────────────────────────────────────────────────────────────────
describe('answerDemandOf / answerRequired — fix assertion', () => {
  const act = (deblock_action: string, extra: Record<string, unknown> = {}) =>
    withMetadata({ deblock_action, ...extra });

  it.each(['INFRASTRUCTURE', 'DEPENDENCY'])('%s approve demands a stated fix', (action) => {
    expect(answerDemandOf(act(action), 'approved')).toBe('fix_assertion');
    expect(answerRequired(act(action), 'approved')).toBe(true);
    expect(isFixAssertion(act(action))).toBe(true);
    // It is NOT a question — `isQuestion` still mirrors the receiver's QUESTION branch.
    expect(isQuestion(act(action))).toBe(false);
  });

  it.each(['INFRASTRUCTURE', 'DEPENDENCY'])('%s REJECT is never gated', (action) => {
    expect(answerDemandOf(act(action), 'rejected')).toBeNull();
    expect(answerRequired(act(action), 'rejected')).toBe(false);
  });

  it('⛔ CONTROL — RETRY also moves the card to TODO and demands NOTHING', () => {
    // ⭐ The discriminating half. `cardMoveOnApprove(x) === 'TODO'` would satisfy
    // both cases above and sweep in RETRY — "run it again", which asserts no fix and
    // is the largest decidable population. The backend refused that derivation too.
    expect(cardMoveOnApprove(act('RETRY'))).toBe('TODO');
    expect(answerDemandOf(act('RETRY'), 'approved')).toBeNull();
    expect(answerRequired(act('RETRY'), 'approved')).toBe(false);
    expect(isFixAssertion(act('RETRY'))).toBe(false);
  });

  it('⛔ no action outside the spelled pair demands a fix, even if it moves to TODO', () => {
    for (const action of ['RETRY', 'SPLIT', 'DROP', 'MERGE', 'QUESTION']) {
      expect(answerDemandOf(act(action), 'approved')).not.toBe('fix_assertion');
    }
    expect(answerDemandOf(withMetadata({}), 'approved')).toBeNull();
  });

  it('ORDER — question_action > fix_assertion > stated_question, the server order', () => {
    expect(answerDemandOf(act('QUESTION', { open_questions: ['Which branch?'] }))).toBe(
      'question_action',
    );
    // A fix row that ALSO states a question is a fix assertion: its text re-drives
    // the card, it is not merely forwarded to an asker.
    expect(answerDemandOf(act('INFRASTRUCTURE', { open_questions: ['Which host?'] }))).toBe(
      'fix_assertion',
    );
    expect(answerDemandOf(act('RETRY', { open_questions: ['Which branch?'] }))).toBe(
      'stated_question',
    );
  });

  it('LOCKSTEP — FIX_ASSERTION_ACTIONS equals the backend set, parsed from its source', () => {
    // Read, not imported: the backend is a separate Bun package outside the vite root
    // (same pattern as `rationale.test.ts`). A member added or dropped on EITHER side
    // reds here.
    const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const src = readFileSync(
      join(REPO_ROOT, 'backend', 'src', 'domain', 'engagement', 'deblock-actions.ts'),
      'utf8',
    );
    const m = src.match(
      /export const FIX_ASSERTION_ACTIONS[^=]*=\s*new Set<DeblockAction>\(\[([^\]]*)\]\)/,
    );
    expect(m, 'could not parse FIX_ASSERTION_ACTIONS out of deblock-actions.ts').not.toBeNull();
    const backend = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
    expect(backend.length).toBeGreaterThan(0);
    expect([...FIX_ASSERTION_ACTIONS].sort()).toEqual(backend);
    // …and the backend's order is still the one mirrored above.
    expect(src).toMatch(
      /if \(effectiveAction === 'QUESTION'\) return 'question_action';[\s\S]*?return 'fix_assertion';[\s\S]*?return 'stated_question';/,
    );
  });
});

describe('fix-assertion wording is NOT the question wording', () => {
  const empty = '';

  it('the refusal names the re-drive and the duplicate PR, never a QUESTION', () => {
    const v = validateAnswer(empty, 'none', 'fix_assertion');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(FIX_ASSERTION_REFUSAL);
    expect(v.reason).toMatch(/what was fixed/);
    expect(v.reason).toContain('TODO');
    expect(v.reason).toMatch(/duplicate pull\s+request/);
    expect(v.reason).toMatch(/reject/i);
    expect(v.reason).not.toMatch(/question/i);
    expect(v.reason).not.toContain('approval_answer_missing');
  });

  it('⭐ distinct from EVERY question refusal, whatever state the row reads as', () => {
    const fix = validateAnswer(empty, 'none', 'fix_assertion').reason;
    for (const state of [undefined, 'none', 'stated', 'unstated', 'unrouted'] as const) {
      expect(validateAnswer(empty, state).reason).not.toBe(fix);
      // A fix row that also states a question reads `unrouted`; the demand still wins.
      expect(validateAnswer(empty, state, 'fix_assertion').reason).toBe(fix);
    }
  });

  it('⭐ label, placeholder and contract are distinct from the QUESTION copy', () => {
    expect(FIX_ASSERTION_LABEL).toBe('What did you fix?');
    expect(FIX_ASSERTION_LABEL).not.toMatch(/answer/i);
    expect(FIX_ASSERTION_PLACEHOLDER).not.toMatch(/answer|question/i);
    expect(FIX_ASSERTION_CONTRACT).not.toBe(ANSWER_CONTRACT);
    expect(FIX_ASSERTION_CONTRACT).not.toMatch(/ANSWER|question/i);
    expect(FIX_ASSERTION_CONTRACT).toContain('TODO');
    expect(FIX_ASSERTION_CONTRACT).toMatch(/duplicate pull request/);
  });

  it('demandedDecisionText mirrors the backend terms', () => {
    expect(demandedDecisionText('question_action')).toBe('the answer');
    expect(demandedDecisionText('stated_question')).toBe('the answer');
    expect(demandedDecisionText('fix_assertion')).toBe('a statement of what was fixed');
  });

  it('⭐ answerlessApproveTitle: a fix row never gets the "states an open question" title', () => {
    // The two-way ternary this replaced on /approvals sent every non-QUESTION demand
    // into the stated-question sentence.
    const fix = answerlessApproveTitle('fix_assertion');
    expect(fix).not.toMatch(/open question|QUESTION|Answer this question/);
    expect(fix).toContain(FIX_ASSERTION_TOGGLE);
    expect(fix).toContain('a statement of what was fixed');
    expect(answerlessApproveTitle('stated_question')).toMatch(/states an open question/);
    expect(answerlessApproveTitle('question_action')).toMatch(/This is a QUESTION/);
    expect(new Set([fix, answerlessApproveTitle('stated_question'), answerlessApproveTitle('question_action')]).size).toBe(3);
  });

  it('a non-empty fix is accepted', () => {
    expect(validateAnswer('restarted the registry', 'none', 'fix_assertion').ok).toBe(true);
  });

  it('a fix row that states a question gets no UNROUTED "proposes no action" notice', () => {
    const p = questionPresentation(
      withMetadata({ deblock_action: 'INFRASTRUCTURE', open_questions: ['Which host?'] }),
    );
    expect(p.questions).toEqual(['Which host?']);
    expect(p.notice).toBeNull();
    // CONTROL — the action-less carrier keeps its notice.
    expect(questionPresentation(withMetadata({ open_questions: ['Which host?'] })).notice).toBe(
      UNROUTED_QUESTION_NOTICE,
    );
  });
});
