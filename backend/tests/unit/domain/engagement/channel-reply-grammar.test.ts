// tests/unit/domain/engagement/channel-reply-grammar.test.ts
//
// The reply GRAMMAR of the one shared reply→decision flow
// (`domain/engagement/channel-reply.ts`).
//
// ⛔ WHY THIS FILE EXISTS. These cases used to live in
// `tests/unit/routes/signal-webhook.test.ts`, which was deleted with the Signal channel
// (2026-10-31). Most of that file was Signal-specific (phone→uuid, the retired-channel
// gate) and went with it — but the grammar blocks were not: `parseDecision`,
// `extractApprovalId` and `stripApprovalTag` are LIVE and decide real approvals from
// Telegram today. Deleting the file silently deleted their only regression coverage, so the
// grammar cases are restored here, against the shared module, with the Signal-only ones left
// out. Anything added here must stay channel-neutral: the moment a case needs a transport,
// it belongs in that transport's own test.
//
// ⛔ IMPORT THE REAL FUNCTIONS. This file's predecessor once re-implemented `parseDecision`
// locally ("since they're not exported, we re-implement the logic here"), so every case
// asserted against a COPY while the real handler carried a `startsWith` prefix bug. A test
// that cannot see its subject is not a test of it.
import { describe, expect, test } from 'bun:test';

import {
  extractApprovalId,
  isNeedInfoRequest,
  needInfoMessage,
  parseDecision,
  stripApprovalTag,
  unmatchedReplyMessage,
} from '../../../../src/domain/engagement/channel-reply';
import { answerlessApproveDemand } from '../../../../src/domain/engagement/deblock-actions';
import { REJECT_DEFAULT_REASON } from '../../../../src/lib/approval-reply-interpreter';

const APPROVAL_ID = 'abcdef01-2345-6789-abcd-ef0123456789';

describe('extractApprovalId — the tag that binds a reply to an approval', () => {
  test('extracts from quoted text', () => {
    expect(
      extractApprovalId('some text [ApprovalId:123e4567-e89b-12d3-a456-426614174000] more text', '1'),
    ).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  test('extracts from message text when there is no quote', () => {
    expect(extractApprovalId(undefined, `1 [ApprovalId:${APPROVAL_ID}]`)).toBe(APPROVAL_ID);
  });

  test('prefers the quoted text over the message text', () => {
    expect(
      extractApprovalId(
        '[ApprovalId:11111111-1111-1111-1111-111111111111]',
        '[ApprovalId:22222222-2222-2222-2222-222222222222]',
      ),
    ).toBe('11111111-1111-1111-1111-111111111111');
  });

  test('returns null when there is no tag', () => {
    expect(extractApprovalId('no id here', 'also nothing')).toBeNull();
    expect(extractApprovalId(undefined, undefined)).toBeNull();
    expect(extractApprovalId('', '')).toBeNull();
  });

  test('is case insensitive', () => {
    expect(extractApprovalId('[APPROVALID:abcdef01-2345-6789-abcd-ef0123456789]')).toBe(APPROVAL_ID);
  });
});

describe('stripApprovalTag — the missing piece between the tag and the decision token', () => {
  test('removes a trailing inline tag so the decision token is bare', () => {
    expect(stripApprovalTag(`1 [ApprovalId:${APPROVAL_ID}]`).trim()).toBe('1');
  });

  test('is a no-op on text that never carried a tag (the quoted-reply case)', () => {
    expect(stripApprovalTag('1').trim()).toBe('1');
  });

  test('the stripped text parses identically to the untagged form', () => {
    expect(parseDecision(stripApprovalTag(`2 too risky [ApprovalId:${APPROVAL_ID}]`))).toEqual(
      parseDecision('2 too risky'),
    );
  });

  // MUTATION CONTROL: without the strip the parser sees a sentence, not a token.
  test('MUTANT: parseDecision on the raw, un-stripped text decides nothing', () => {
    expect(parseDecision(`1 [ApprovalId:${APPROVAL_ID}]`)).toBeNull();
  });
});

describe('parseDecision — the numbered grammar', () => {
  test('a bare approve carries NO comment (load-bearing: the answer demand reads this)', () => {
    for (const t of ['1', 'approve', 'yes', 'ok', '  1  ', 'APPROVE']) {
      expect(parseDecision(t)).toEqual({ decision: 'approved' });
    }
    expect('comment' in (parseDecision('1') as object)).toBe(false);
  });

  test('"2" is a reject with the shared default reason, not a channel name', () => {
    const result = parseDecision('2');
    expect(result?.decision).toBe('rejected');
    expect(result?.comment).toBe(REJECT_DEFAULT_REASON);
    expect(REJECT_DEFAULT_REASON).not.toMatch(/telegram|signal|teams/i);
  });

  test('a reject carries its reason', () => {
    expect(parseDecision('2 not ready yet')?.comment).toBe('not ready yet');
    expect(parseDecision('reject security concerns')?.comment).toBe('security concerns');
    expect(parseDecision('REJECT bad')?.comment).toBe('bad');
  });

  test('a punctuation-only reason is replaced, never recorded as "?"', () => {
    expect(parseDecision('reject: ?')?.comment).toBe(REJECT_DEFAULT_REASON);
  });

  // fr#1371: need-info used to be a REJECT, and consensus closes an approval on ANY reject.
  test('"3" / "info …" / "question …" are NOT a decision', () => {
    for (const t of ['3', '3 what is the impact', 'info details please', 'question: scope?', 'Info']) {
      expect(parseDecision(t)).toBeNull();
    }
  });

  test('unrecognised input decides nothing', () => {
    for (const t of ['hello world', 'maybe later', '4', '']) {
      expect(parseDecision(t)).toBeNull();
    }
  });
});

describe('B9 — whole-token matching (the prose that used to be a REJECTION)', () => {
  // Under the old `startsWith` implementation EVERY one of these was recorded as a rejection
  // on a live approval gate, because a message only has to carry the [ApprovalId:…] anchor to
  // be acted on.
  const INNOCENT_PROSE = [
    'Note: this looks fine',
    'Nothing blocking here',
    'November deadline is fine',
    '20 minutes late but ok',
    'informally approved',
    'nothing further from me',
  ];

  for (const text of INNOCENT_PROSE) {
    test(`prose is NOT a decision: ${JSON.stringify(text)}`, () => {
      expect(parseDecision(text)).toBeNull();
    });
  }

  test('the real tokens still parse', () => {
    expect(parseDecision('2')?.decision).toBe('rejected');
    expect(parseDecision('2 not enough tests')?.comment).toBe('not enough tests');
    expect(parseDecision('reject too risky')?.decision).toBe('rejected');
    expect(parseDecision('3 which env?')).toBeNull();
    expect(parseDecision('info')).toBeNull();
  });

  // ⚠️ A LIMIT OF THE GRAMMAR, asserted rather than hidden. Whole-token matching fixes PREFIX
  // collisions ("informally" is info+rmally, no boundary) but a message that genuinely BEGINS
  // with a bare token word followed by a space IS that token.
  test('KNOWN LIMIT: a message starting with a bare token word is that token', () => {
    expect(parseDecision('question of scope aside, go ahead')).toBeNull();
    expect(parseDecision('nothing blocking here')).toBeNull();
    expect(parseDecision('informally approved')).toBeNull();
  });

  test('approve stays an EXACT match — loosening an approval path is the worst change', () => {
    expect(parseDecision('1')?.decision).toBe('approved');
    expect(parseDecision('ok')?.decision).toBe('approved');
    expect(parseDecision('okay')).toBeNull();
    expect(parseDecision('approve the budget')).toBeNull();
    expect(parseDecision('yes but only after review')).toBeNull();
  });

  // MUTATION CONTROL: reintroduce the exact bug and prove these cases would catch it.
  // Without this, "the prose returns null" is satisfied by ANY parser that returns null a lot.
  test('MUTANT: startsWith turns reassuring prose into a rejection', () => {
    const buggy = (text: string) => {
      const t = text.trim().toLowerCase();
      if (t === '1' || t === 'approve' || t === 'yes' || t === 'ok') return { decision: 'approved' as const };
      if (t.startsWith('2') || t.startsWith('reject') || t.startsWith('no')) return { decision: 'rejected' as const };
      if (t.startsWith('3') || t.startsWith('info') || t.startsWith('question')) return { decision: 'rejected' as const };
      return null;
    };
    expect(INNOCENT_PROSE.filter((t) => buggy(t)?.decision === 'rejected').length).toBe(INNOCENT_PROSE.length);
    expect(INNOCENT_PROSE.filter((t) => parseDecision(t) !== null).length).toBe(0);
  });
});

describe('parseDecision — approve carrying the answer', () => {
  test('`approve: <answer>` records the answer as the comment', () => {
    expect(parseDecision('approve: ship it')).toEqual({ decision: 'approved', comment: 'ship it' });
  });

  test('the pasted template is NOT a decision', () => {
    expect(parseDecision('approve: <your answer>')).toBeNull();
  });

  // The demand guard is what the comment field exists for: a bare approve must still be
  // refused on a row that owes an answer, and the widened form must satisfy it.
  test('answerlessApproveDemand is satisfied ONLY by the approve-with-answer form', () => {
    const metadata = { open_questions: ['Which repo should this target?'] };
    expect(answerlessApproveDemand({ decision: 'approved', comment: parseDecision('1')?.comment, metadata })).not.toBeNull();
    expect(
      answerlessApproveDemand({ decision: 'approved', comment: parseDecision('approve: main repo')?.comment, metadata }),
    ).toBeNull();
  });

  test('REJECT is never gated by the answer demand', () => {
    expect(
      answerlessApproveDemand({
        decision: 'rejected',
        comment: parseDecision('2 not yet')?.comment,
        metadata: { open_questions: ['Which repo should this target?'] },
      }),
    ).toBeNull();
  });
});

describe('need-info replies record nothing and point at fr', () => {
  test('isNeedInfoRequest recognises the need-info forms and nothing else', () => {
    for (const t of ['3', '3 what is the impact', 'info', 'info details please', 'question about scope']) {
      expect(isNeedInfoRequest(t)).toBe(true);
    }
    for (const t of ['1', '2 too risky', '30 minutes', 'informally fine', 'questionable']) {
      expect(isNeedInfoRequest(t)).toBe(false);
    }
  });

  test('needInfoMessage names the approval, links fr and records nothing', () => {
    const m = needInfoMessage(APPROVAL_ID);
    expect(m).toContain('Nothing was recorded');
    expect(m).toContain(`#${APPROVAL_ID.slice(0, 8)}`);
    expect(m).toContain(`/approvals/${APPROVAL_ID}`);
  });
});

describe('unmatchedReplyMessage', () => {
  test('names the on-channel exits and the fr exit, and guesses NO approval', () => {
    const m = unmatchedReplyMessage();
    expect(m).toContain('nothing was recorded');
    expect(m).toContain('[ApprovalId:');
    expect(m).toContain('in fr');
    // It must never invent an id: an unmatched message has not resolved one.
    expect(m).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });
});
