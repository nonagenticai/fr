// tests/unit/domain/engagement/adapters/telegram-adapter.test.ts
//
// Telegram and `metadata.proposed_answer` on a QUESTION row: the notification footer, and
// what the webhook records for the replies that footer invites. Real formatter, real
// parsers (`parseDecision`, laya's `toChatDecision`), real fill (`withProposedAnswer`).
//
// ⛔ The free-text case is the one an audit caught: laya reads "approve, but use the main
// repo" as an approve, `toChatDecision` drops the words because the row owes an answer, and
// the fill used to record the PROPOSAL over them. The webhook passes `fromFreeText` for a
// laya read, so that approve is not filled and goes to the answer ask, as before proposals.
import { test, expect, describe } from 'bun:test';
import {
  FOOTER_NOTE_ACCEPTS_PROPOSED,
  TelegramAdapter,
} from '../../../../../src/domain/engagement/adapters/telegram';
import {
  answerlessApproveDemand,
  PROPOSED_ANSWER_NOTE,
  withProposedAnswer,
} from '../../../../../src/domain/engagement/deblock-actions';
import { parseDecision } from '../../../../../src/domain/engagement/channel-reply';
import { toChatDecision } from '../../../../../src/lib/approval-reply-interpreter';

type Approval = Parameters<TelegramAdapter['send']>[0];

const ID = '123e4567-e89b-12d3-a456-426614174000';
const QUESTION = { deblock_action: 'QUESTION', open_questions: ['Which repo?'], proposed_answer: 'Use the fixtures repo' };

function approval(metadata: Record<string, unknown> | null): Approval {
  return {
    id: ID, project_id: null, description: 'Which repo?', card_id: null, callback_path: null,
    source: null, metadata, status: 'pending', expires_at: new Date(), requester_id: null,
  } as Approval;
}

const adapter = new TelegramAdapter();
const formatMessage = (a: Approval) => adapter['formatMessage'](a);

/** What the webhook records for a decision: the fill, then the answer demand. */
function recorded(decision: { decision: 'approved' | 'rejected'; comment?: string }, fromFreeText: boolean) {
  const comment = withProposedAnswer({ decision: decision.decision, comment: decision.comment, metadata: QUESTION, fromFreeText });
  return { comment, demand: answerlessApproveDemand({ decision: decision.decision, comment, metadata: QUESTION }) };
}

describe('Telegram footer — proposed answer', () => {
  test('a QUESTION row shows the proposal, the note, and `1 - Approve (accepts the proposed answer)`', () => {
    const msg = formatMessage(approval(QUESTION));
    expect(msg).toContain('Proposed answer: Use the fixtures repo');
    expect(msg).toContain(PROPOSED_ANSWER_NOTE);
    expect(msg).toContain(`1 - Approve   (${FOOTER_NOTE_ACCEPTS_PROPOSED})`);
  });

  test('CONTROL: an INFRASTRUCTURE row with proposed_answer shows no proposal (fix assertion menu instead)', () => {
    const msg = formatMessage(approval({ deblock_action: 'INFRASTRUCTURE', proposed_answer: 'Use the fixtures repo' }));
    expect(msg).not.toContain('Proposed answer');
    expect(msg).not.toContain(FOOTER_NOTE_ACCEPTS_PROPOSED);
    expect(msg).toContain('2 - Reject');
  });
});

describe('Telegram webhook — what a reply records on a QUESTION row with a proposal', () => {
  test('a bare `1` (and the footer line echoed back) records the proposal', () => {
    for (const reply of ['1', 'approve', `1 - Approve   (${FOOTER_NOTE_ACCEPTS_PROPOSED})`]) {
      const d = parseDecision(reply);
      expect(d, reply).toEqual({ decision: 'approved' });
      expect(recorded(d!, false)).toEqual({ comment: 'Use the fixtures repo', demand: null });
    }
  });

  test('`approve: <text>` records the typed text, not the proposal', () => {
    expect(recorded(parseDecision('approve: use the main repo')!, false)).toEqual({ comment: 'use the main repo', demand: null });
  });

  test('a free-text approve laya read never records the proposal over the human\'s words', () => {
    const owes = answerlessApproveDemand({ decision: 'approved', comment: undefined, metadata: QUESTION }) !== null;
    expect(owes).toBe(true);
    const d = toChatDecision({ kind: 'approve', comment: 'approve, but use the main repo', layaSaysExtra: true }, owes);
    const r = recorded(d, true);
    expect(r.comment).not.toBe('Use the fixtures repo');
    expect(r.comment).toBeUndefined();
    // Still owed ⇒ the webhook asks for the answer and records nothing yet (pre-proposal behaviour).
    expect(r.demand).toBe('question_action');
  });
});
