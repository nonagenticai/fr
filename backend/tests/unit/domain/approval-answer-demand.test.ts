// tests/unit/domain/approval-answer-demand.test.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHICH APPROVALS OWE AN ANSWER — and the inversion this predicate replaces.
// ═══════════════════════════════════════════════════════════════════════════
//
// ⛔ THE DEFECT, MEASURED ON PROD 2026-09-10, NOT INFERRED. Of 1040 pending
// approvals: 137 carried `metadata.deblock_action = 'QUESTION'` and ZERO of them
// carried any `metadata.open_questions` — fr demanded an answer with nothing
// stated to answer. Exactly 15 rows carried a non-empty `open_questions` (a real,
// readable question, e.g. `Goal-tree: decision "Set project_type to feature" does
// not trace to a necessary condition/objective`) and ALL 15 had `deblock_action`
// NULL — so the guard demanded nothing from the only rows that ask something.
// The two sets are DISJOINT, and `PUT /api/approvals/:id` gated on the action
// alone, so the server refused an empty approve on exactly the rows with no
// question and accepted one on every row that had one.
//
// ⭐ THE SERVER AND THE UI SHARE THIS PREDICATE BY CONSTRUCTION.
// `frontend/src/lib/approvals/question.ts :: answerRequired` is the same union.
// A server that demands an answer the UI never asked for — or a UI that demands
// one the server does not — is the failure this file pins shut.
//
// ⛔ AND IT IS PINNED AS A PURE FUNCTION FOR A REASON THIS REPO LEARNED THE HARD
// WAY. The rule used to be an inline `=== 'QUESTION'` inside a 300-line handler
// behind a database and an auth check, so the only thing testing it was a grep
// over the file; a mutation run that disabled a sibling refusal outright left
// every grepped string in place and all 67 tests passed. A presence check cannot
// fail for a behaviour change.

import { describe, expect, test } from 'bun:test';
import {
  answerlessApproveDemand,
  answerRequiredMessage,
  classifyAnswerDemand,
  demandedDecisionText,
  FIX_ASSERTION_ACTIONS,
  PROPOSED_ANSWER_MAX_CHARS,
  proposedAnswer,
  statedOpenQuestions,
  withProposedAnswer,
  type AnswerDemand,
} from '../../../src/domain/engagement/deblock-actions';
import { apiAnswerRequiredMessage } from '../../../src/routes/approvals';

describe('statedOpenQuestions', () => {
  test('reads an array of strings verbatim, trimmed', () => {
    expect(statedOpenQuestions({ open_questions: ['  Which repo should this land in?  '] })).toEqual(
      ['Which repo should this land in?'],
    );
  });

  test('reads a bare non-empty string as a single question', () => {
    expect(statedOpenQuestions({ open_questions: 'Which environment?' })).toEqual([
      'Which environment?',
    ]);
  });

  test('EVERY member is returned, not just the first', () => {
    // A caller that read `[0]` and stopped would silently drop questions a human
    // was asked. The producer emits arrays.
    expect(statedOpenQuestions({ open_questions: ['first?', 'second?'] })).toEqual([
      'first?',
      'second?',
    ]);
  });

  test('an absent, null, empty or blank value is a plain absence', () => {
    expect(statedOpenQuestions({})).toEqual([]);
    expect(statedOpenQuestions(null)).toEqual([]);
    expect(statedOpenQuestions(undefined)).toEqual([]);
    expect(statedOpenQuestions({ open_questions: null })).toEqual([]);
    expect(statedOpenQuestions({ open_questions: [] })).toEqual([]);
    expect(statedOpenQuestions({ open_questions: '   ' })).toEqual([]);
    expect(statedOpenQuestions({ open_questions: ['', '  '] })).toEqual([]);
  });

  test('a non-string member is DROPPED, never stringified', () => {
    // `String(obj)` would hand the decider the literal `[object Object]` as if it
    // were the producer's question — the defect this must not hide.
    expect(statedOpenQuestions({ open_questions: ['real?', { q: 'nested' }, 7] })).toEqual([
      'real?',
    ]);
    expect(statedOpenQuestions({ open_questions: [{ q: 'nested' }] })).toEqual([]);
    expect(statedOpenQuestions({ open_questions: 42 })).toEqual([]);
  });
});

describe('classifyAnswerDemand', () => {
  // ── (a) THE HALF THAT WAS MISSING ────────────────────────────────────────────
  test('a row that STATES a question owes an answer even with NO deblock_action', () => {
    // The measured carrier shape: all 15 pending rows carrying a readable question
    // had `deblock_action` NULL, and the old `=== 'QUESTION'` guard returned null
    // here — so an approve delivering no answer to a stated question was accepted.
    expect(
      classifyAnswerDemand(undefined, {
        open_questions: [
          'Goal-tree: decision "Set project_type to feature" does not trace to a necessary condition/objective',
        ],
      }),
    ).toBe('stated_question');
  });

  test('a stated question on a NON-question action still owes an answer', () => {
    expect(classifyAnswerDemand('RETRY', { open_questions: ['Which branch?'] })).toBe(
      'stated_question',
    );
  });

  // ── (b) THE HALF THAT MUST *NOT* CHANGE ──────────────────────────────────────
  test('⛔ a typed QUESTION with NO stated question STILL owes an answer', () => {
    // ⛔ DO NOT "FIX" THIS BY RETURNING null. It looks like the same inversion read
    // backwards — 137 rows demanding an answer they state no question for — and it
    // is not. `approval-callback.json :: Resolve Target List` computes
    // `questionAnswered = action === 'QUESTION' && decision === 'approved' &&
    // answerText.length > 0` and never reads `open_questions`, so an empty approve
    // here takes the HOLDING branch, stamps `block_reason approval_answer_missing`,
    // and SPENDS the row — no second decision is accepted, so nothing can ever
    // release the card. Dropping the demand converts a refusal into a one-click
    // permanent strand on the LARGEST population this guard protects.
    expect(classifyAnswerDemand('QUESTION', { gate_terms: ['watchdog_stall_unspecified'] })).toBe(
      'question_action',
    );
    expect(classifyAnswerDemand('QUESTION', { open_questions: [] })).toBe('question_action');
    expect(classifyAnswerDemand('QUESTION', null)).toBe('question_action');
  });

  test('the QUESTION arm WINS on a row that is both — the messages differ', () => {
    // Only the `question_action` refusal is true about the card move. A
    // `stated_question` message on this row would tell the decider their answer
    // does not re-drive the card, when it does.
    expect(classifyAnswerDemand('QUESTION', { open_questions: ['Which branch?'] })).toBe(
      'question_action',
    );
  });

  // ── NEGATIVE CONTROLS — the queue must stay decidable ────────────────────────
  test('the ordinary queue owes nothing: RETRY, SPLIT, MERGE, action-less', () => {
    // 442 RETRY of 1040 pending on 2026-09-10. If any of these started demanding
    // text the conveyor would halt, and every positive case above would still be
    // green — so they are asserted here.
    //
    // ⚠️ INFRASTRUCTURE and DEPENDENCY USED to be asserted null here. They left this
    // list on 2026-09-14 (Phase-4 re-drive: approving one now moves the card to TODO)
    // and are pinned as `fix_assertion` below. RETRY stays: it asserts no fix.
    expect(classifyAnswerDemand('RETRY', {})).toBeNull();
    expect(classifyAnswerDemand('SPLIT', { open_questions: [] })).toBeNull();
    expect(classifyAnswerDemand('MERGE', undefined)).toBeNull();
    expect(classifyAnswerDemand(undefined, {})).toBeNull();
  });

  test('INFRASTRUCTURE and DEPENDENCY owe a statement of what was fixed', () => {
    expect(classifyAnswerDemand('INFRASTRUCTURE', {})).toBe('fix_assertion');
    expect(classifyAnswerDemand('DEPENDENCY', null)).toBe('fix_assertion');
    // Exactly these two — a third is a decision somebody makes on purpose.
    expect([...FIX_ASSERTION_ACTIONS].sort()).toEqual(['DEPENDENCY', 'INFRASTRUCTURE']);
  });

  test('ORDER: question_action > fix_assertion > stated_question', () => {
    // A hold that also states a question reports the arm that names the CARD MOVE.
    expect(classifyAnswerDemand('INFRASTRUCTURE', { open_questions: ['Which host?'] })).toBe(
      'fix_assertion',
    );
  });

  test('an unreadable open_questions is not a stated question', () => {
    // `[object Object]` is the producer defect, not something anyone was asked, so
    // it must not manufacture a refusal on a row that is otherwise decidable.
    expect(classifyAnswerDemand(undefined, { open_questions: [{ q: 'nested' }] })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fix_assertion — THE THIRD DEMAND, ON EVERY SEAT'S WORDING (2026-09-14)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⛔ THE DEFECT THESE PIN. `fix_assertion` was added to `AnswerDemand` while both
// message builders were two-way ternaries `=== 'question_action' ? Q : STATED`, so
// an empty approve of an INFRASTRUCTURE hold was refused, on every seat, with
// "This approval states an open question (metadata.open_questions)" — false, and
// `tsc` exit 0. A refusal existing was never the property; its TEXT being true is.

const STATED_QUESTION_WORDING = ['states an open question', 'open_questions'];

/** The chat seats' channel sentence, echoed so a test can see what was demanded. */
const seatSentence = (demanded: string) => `[SEAT: supply ${demanded}]`;

/** Every message builder a seat uses, keyed by seat, for one demand kind. */
function everySeatMessage(demand: Exclude<AnswerDemand, null>): Record<string, string> {
  return {
    chat: answerRequiredMessage(demand, seatSentence),
    api: apiAnswerRequiredMessage(demand, []),
    'api (broken-gate row)': apiAnswerRequiredMessage(demand, ['watchdog_stall_unspecified']),
  };
}

describe('answerlessApproveDemand on an INFRASTRUCTURE / DEPENDENCY hold', () => {
  for (const action of ['INFRASTRUCTURE', 'DEPENDENCY'] as const) {
    test(`${action}: an EMPTY approve is refused as fix_assertion`, () => {
      expect(
        answerlessApproveDemand({ decision: 'approved', comment: undefined, metadata: { deblock_action: action } }),
      ).toBe('fix_assertion');
      // Whitespace is empty: the receiver trims.
      expect(
        answerlessApproveDemand({ decision: 'approved', comment: '  \n ', metadata: { deblock_action: action } }),
      ).toBe('fix_assertion');
    });

    test(`${action}: an approve WITH a stated fix is accepted`, () => {
      expect(
        answerlessApproveDemand({
          decision: 'approved',
          comment: 'Restarted registry.example.com; DOCKER-USER rule re-asserted.',
          metadata: { deblock_action: action },
        }),
      ).toBeNull();
    });

    test(`${action}: a REJECT with no text is never refused`, () => {
      // `answerlessApproveDemand` returns null for any non-approve BEFORE the
      // classifier runs — the exit that is never blocked, on all four seats.
      expect(
        answerlessApproveDemand({ decision: 'rejected', comment: undefined, metadata: { deblock_action: action } }),
      ).toBeNull();
      expect(
        answerlessApproveDemand({ decision: 'rejected', comment: '', metadata: { deblock_action: action } }),
      ).toBeNull();
    });
  }

  test('the decider override is honoured: stored RETRY + supplied INFRASTRUCTURE is a hold', () => {
    expect(
      answerlessApproveDemand({
        decision: 'approved',
        comment: undefined,
        metadata: { deblock_action: 'RETRY' },
        suppliedAction: 'INFRASTRUCTURE',
      }),
    ).toBe('fix_assertion');
  });

  test('⛔ CONTROL: RETRY with no text is NOT refused — it asserts no fix', () => {
    // Sweeping RETRY in (e.g. via `APPROVED_ACTION_TARGET[a] === 'TODO'`) would
    // halt the largest decidable population in the queue.
    expect(
      answerlessApproveDemand({ decision: 'approved', comment: undefined, metadata: { deblock_action: 'RETRY' } }),
    ).toBeNull();
  });
});

describe('the fix_assertion refusal TEXT is true, on every seat', () => {
  test('⭐ THE FALL-THROUGH: no seat tells a hold\'s approver it "states an open question"', () => {
    // RED on the pre-repair two-way ternaries, where fix_assertion took the
    // stated-question arm on both the chat seats and the API route.
    for (const [seat, message] of Object.entries(everySeatMessage('fix_assertion'))) {
      for (const wording of STATED_QUESTION_WORDING) {
        expect({ seat, contains: message.includes(wording) }).toEqual({ seat, contains: false });
      }
      // Nor the QUESTION arm's strand claim, which is equally false on a hold.
      expect({ seat, contains: message.includes('approval_answer_missing') }).toEqual({
        seat,
        contains: false,
      });
    }
  });

  test('names the hold, the re-drive to TODO, the fix statement, the duplicate PR, and REJECT', () => {
    for (const [seat, message] of Object.entries(everySeatMessage('fix_assertion'))) {
      const has = (s: string) => ({ seat, s, has: message.includes(s) });
      expect(has('INFRASTRUCTURE or DEPENDENCY hold')).toEqual({ seat, s: 'INFRASTRUCTURE or DEPENDENCY hold', has: true });
      expect(has('re-drives the card to TODO')).toEqual({ seat, s: 're-drives the card to TODO', has: true });
      expect(has('State what was fixed')).toEqual({ seat, s: 'State what was fixed', has: true });
      expect(has('DUPLICATE PULL REQUEST')).toEqual({ seat, s: 'DUPLICATE PULL REQUEST', has: true });
      expect(has('rejecting is always allowed')).toEqual({ seat, s: 'rejecting is always allowed', has: true });
    }
  });

  test('the seat is told to supply what was fixed — never "the answer"', () => {
    expect(demandedDecisionText('fix_assertion')).toBe('a statement of what was fixed');
    const chat = answerRequiredMessage('fix_assertion', seatSentence);
    expect(chat).toContain('[SEAT: supply a statement of what was fixed]');
    expect(chat).not.toContain('the answer');
    const api = apiAnswerRequiredMessage('fix_assertion', []);
    expect(api).toContain('Approve again WITH a statement of what was fixed in `comment`');
    expect(api).not.toContain('the answer');
  });

  test('CONTROLS: the two question arms keep their own, distinct wording', () => {
    // Without these, a builder that returned the fix text for EVERY kind would pass
    // the fall-through test above.
    const q = everySeatMessage('question_action');
    const st = everySeatMessage('stated_question');
    const fx = everySeatMessage('fix_assertion');
    for (const seat of Object.keys(fx)) {
      expect(q[seat]).toContain('approval is a QUESTION');
      expect(q[seat]).toContain('approval_answer_missing');
      expect(st[seat]).toContain('states an open question');
      expect(new Set([q[seat], st[seat], fx[seat]]).size).toBe(3);
      for (const m of [q[seat], st[seat]]) expect(m).not.toContain('DUPLICATE PULL REQUEST');
    }
    expect(answerRequiredMessage('question_action', seatSentence)).toContain('[SEAT: supply the answer]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// metadata.proposed_answer — a bare approve ACCEPTS the asker's proposal.
// ═══════════════════════════════════════════════════════════════════════════
// Every seat runs `withProposedAnswer` BEFORE `answerlessApproveDemand`, so the value the
// INSERT writes is the proposal and the demand is met. A typed comment always wins; reject
// is untouched.
describe('withProposedAnswer — a bare approve accepts metadata.proposed_answer', () => {
  const md = { deblock_action: 'QUESTION', open_questions: ['Which repo?'], proposed_answer: '  Use the fixtures repo ' };

  test('proposedAnswer reads a non-empty string, trimmed; anything else is null', () => {
    expect(proposedAnswer(md)).toBe('Use the fixtures repo');
    for (const v of [undefined, null, '', '   ', 42, ['x'], { a: 1 }]) {
      expect(proposedAnswer({ proposed_answer: v })).toBeNull();
    }
    expect(proposedAnswer(null)).toBeNull();
  });

  test('proposedAnswer is capped at PROPOSED_ANSWER_MAX_CHARS (2000), not only by the create schema', () => {
    expect(PROPOSED_ANSWER_MAX_CHARS).toBe(2000);
    const long = { ...md, proposed_answer: 'y'.repeat(2500) };
    expect(proposedAnswer(long)).toBe('y'.repeat(2000));
    expect(withProposedAnswer({ decision: 'approved', comment: undefined, metadata: long })).toHaveLength(2000);
  });

  test.each([[undefined], [null], [''], ['  \n ']])('an empty approve (%p) records the proposal and owes nothing', (comment) => {
    const persisted = withProposedAnswer({ decision: 'approved', comment, metadata: md });
    expect(persisted).toBe('Use the fixtures repo');
    expect(answerlessApproveDemand({ decision: 'approved', comment: persisted, metadata: md })).toBeNull();
  });

  test('a typed comment wins over the proposal', () => {
    expect(withProposedAnswer({ decision: 'approved', comment: 'Use the main repo', metadata: md })).toBe('Use the main repo');
  });

  test('a reject is returned unchanged (never filled with the proposal)', () => {
    expect(withProposedAnswer({ decision: 'rejected', comment: undefined, metadata: md })).toBeUndefined();
    expect(withProposedAnswer({ decision: 'rejected', comment: 'no', metadata: md })).toBe('no');
  });

  // ⛔ QUESTION ONLY. A fix assertion owes a statement of what was FIXED; a stray proposal
  // must never stand in for it, and an action-less row ignores the key too.
  test.each([['INFRASTRUCTURE', 'fix_assertion'], ['DEPENDENCY', 'fix_assertion'], [undefined, 'stated_question']] as const)(
    'a %p row ignores proposed_answer: a bare approve is not filled and is still refused (%p)',
    (action, demand) => {
      const other = { deblock_action: action, open_questions: ['Which repo?'], proposed_answer: 'Use the fixtures repo' };
      expect(proposedAnswer(other)).toBeNull();
      const persisted = withProposedAnswer({ decision: 'approved', comment: undefined, metadata: other });
      expect(persisted).toBeUndefined();
      expect(answerlessApproveDemand({ decision: 'approved', comment: persisted, metadata: other })).toBe(demand);
    },
  );

  test('the API decider\'s override decides: QUESTION overridden to INFRASTRUCTURE is not filled', () => {
    expect(withProposedAnswer({ decision: 'approved', comment: undefined, metadata: md, suppliedAction: 'INFRASTRUCTURE' }))
      .toBeUndefined();
    // …and a stored RETRY overridden to QUESTION is.
    const retry = { ...md, deblock_action: 'RETRY' };
    expect(withProposedAnswer({ decision: 'approved', comment: undefined, metadata: retry })).toBeUndefined();
    expect(withProposedAnswer({ decision: 'approved', comment: undefined, metadata: retry, suppliedAction: 'QUESTION' }))
      .toBe('Use the fixtures repo');
  });

  test('an approve read from free text (fromFreeText) is never filled: the human wrote words', () => {
    const persisted = withProposedAnswer({ decision: 'approved', comment: undefined, metadata: md, fromFreeText: true });
    expect(persisted).toBeUndefined();
    expect(answerlessApproveDemand({ decision: 'approved', comment: persisted, metadata: md })).toBe('question_action');
  });

  test('CONTROL: without a proposal the empty approve is still refused', () => {
    const bare = { deblock_action: 'QUESTION', open_questions: ['Which repo?'] };
    const persisted = withProposedAnswer({ decision: 'approved', comment: undefined, metadata: bare });
    expect(persisted).toBeUndefined();
    expect(answerlessApproveDemand({ decision: 'approved', comment: persisted, metadata: bare })).toBe('question_action');
  });
});
