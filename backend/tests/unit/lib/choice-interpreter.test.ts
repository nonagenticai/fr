// ONE INTERPRETER FOR EVERY CHANNEL (owner ruling 2026-10-31): the choices WE SENT are the
// question, laya answers which one was chosen with a score, and a score below the threshold
// is NOT a decision — the human is asked again.
//
// These pin the pure half: the request built from an option list, the rule over laya's
// answers, and the re-ask text. The transport is remote and is verified live, never faked
// (backend/CLAUDE.md: no test doubles).
import { describe, expect, test } from 'bun:test';

import {
  APPROVAL_CHOICES,
  buildChoiceRequest,
  decideFromChoiceAnswers,
  unclearChoiceMessage,
} from '../../../src/lib/approval-reply-interpreter';

const APPROVE = { choice: 'approve', confidence: 0.93 };
const AGREES = { choice: 'agrees', confidence: 0.9 };
const STANCE_NEITHER = { choice: 'neither', confidence: 0.9 };
const EXTRA_DECISION_ONLY = { choice: 'decision_only', confidence: 0.9 };

const OTHER_CHOICES = [
  { id: 'drop', label: '1 - Drop the card' },
  { id: 'retry', label: '2 - Retry it' },
];

describe('buildChoiceRequest', () => {
  test('the approval menu keeps its measured questions (a single 3-way is not enough)', () => {
    const req = buildChoiceRequest({ request: 'ship it?', reply: 'ok', options: APPROVAL_CHOICES }) as any;
    expect(Object.keys(req.questions).sort()).toEqual(['agrees', 'decision', 'extra', 'stance']);
  });

  test('any other option set asks exactly the question the seat needs', () => {
    const req = buildChoiceRequest({ request: 'what now?', reply: 'retry it', options: OTHER_CHOICES }) as any;
    expect(Object.keys(req.questions).sort()).toEqual(['choice', 'extra']);
    expect(Object.keys(req.questions.choice.criteria).sort()).toEqual(['drop', 'retry']);
    // The label is what the human READ, so it is what laya matches against.
    expect(req.questions.choice.criteria.retry).toBe('2 - Retry it');
  });
});

describe('decideFromChoiceAnswers', () => {
  test('a confident option from the supplied set is the answer', () => {
    const out = decideFromChoiceAnswers(
      { choice: { choice: 'retry', confidence: 0.88 }, extra: EXTRA_DECISION_ONLY },
      { reply: 'retry it', options: OTHER_CHOICES },
    );
    expect(out).toMatchObject({ kind: 'choice', choice: 'retry' });
  });

  test('a LOW score is not a decision — the caller re-asks and records nothing', () => {
    const out = decideFromChoiceAnswers(
      { choice: { choice: 'retry', confidence: 0.31 }, extra: EXTRA_DECISION_ONLY },
      { reply: 'hmm', options: OTHER_CHOICES },
    );
    expect(out).toEqual({ kind: 'unclear' });
  });

  test('an option we never offered is not a decision either', () => {
    const out = decideFromChoiceAnswers(
      { choice: { choice: 'drop', confidence: 0.99 }, extra: EXTRA_DECISION_ONLY },
      { reply: 'nuke it', options: [{ id: 'retry', label: '2 - Retry it' }] },
    );
    expect(out).toEqual({ kind: 'unclear' });
  });

  test('the approval menu still needs corroboration — a lone 3-way cannot approve', () => {
    const approved = decideFromChoiceAnswers(
      { decision: APPROVE, agrees: AGREES, stance: STANCE_NEITHER, extra: EXTRA_DECISION_ONLY },
      { reply: 'ok', options: APPROVAL_CHOICES },
    );
    // `stance: neither` is fine for an approve (it corroborates a REJECT), so this approves.
    expect(approved).toMatchObject({ kind: 'choice', choice: 'approve' });

    const uncorroborated = decideFromChoiceAnswers(
      { decision: APPROVE, agrees: { choice: 'does_not_agree', confidence: 0.9 }, stance: STANCE_NEITHER, extra: EXTRA_DECISION_ONLY },
      { reply: 'ok', options: APPROVAL_CHOICES },
    );
    expect(['unclear']).toContain(uncorroborated.kind === 'choice' ? uncorroborated.choice : uncorroborated.kind);
  });

  test('a question is not a decision on any channel', () => {
    const out = decideFromChoiceAnswers(
      {
        decision: { choice: 'question', confidence: 0.9 },
        agrees: { choice: 'does_not_agree', confidence: 0.9 },
        stance: STANCE_NEITHER,
        extra: EXTRA_DECISION_ONLY,
      },
      { reply: 'which repo?', options: APPROVAL_CHOICES },
    );
    expect(out).toMatchObject({ kind: 'choice', choice: 'question' });
  });
});

describe('the corroboration survives the unquoted path', () => {
  // ⛔ REGRESSION GUARD: gating the corroboration on `!allowUnrelated` silently dropped
  // `agrees`/`stance` for the Telegram unquoted read and let a lone 3-way score record a
  // decision — the exact hazard the module header cites (reject at 0.80 for "goedgekeurd").
  test('the approval questions are still asked when an `unrelated` option is added', () => {
    const req = buildChoiceRequest({
      request: 'ship it?',
      reply: 'goedgekeurd',
      options: APPROVAL_CHOICES,
      allowUnrelated: true,
    }) as any;
    expect(Object.keys(req.questions).sort()).toEqual(['agrees', 'decision', 'extra', 'stance']);
    expect(Object.keys(req.questions.decision.criteria)).toContain('unrelated');
  });

  test('a lone `reject` with no corroboration is still not a decision', () => {
    const out = decideFromChoiceAnswers(
      {
        decision: { choice: 'reject', confidence: 0.8 },
        agrees: { choice: 'does_not_agree', confidence: 0.8 },
        // stance missing entirely: the corroboration cannot be satisfied.
        extra: EXTRA_DECISION_ONLY,
      },
      { reply: 'goedgekeurd', options: APPROVAL_CHOICES, allowUnrelated: true },
    );
    expect(['unavailable', 'unclear']).toContain(out.kind);
  });
});

describe('unclearChoiceMessage', () => {
  test('shows the same options again and says nothing was recorded', () => {
    const text = unclearChoiceMessage(['1 - Approve', '2 - Reject (include reason after number)']);
    expect(text).toContain('nothing was recorded');
    expect(text).toContain('1 - Approve');
    expect(text).toContain('2 - Reject');
  });
});
