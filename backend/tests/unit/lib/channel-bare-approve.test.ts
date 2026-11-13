// WHAT A BARE APPROVE MEANS IS THE ROW'S ANSWER, NOT THE SEAT'S.
//
// Owner ruling 2026-10-31: "any channel for any project any card-type always works exactly
// the same, if via any channel the approval message for choices [1,2,3] can be '1' as
// response, that applies to all channels and all cases!"
//
// Before this module both derivations lived in routes/telegram-webhook.ts, so the same `1`
// on the same row approved everything from Telegram and was refused from Teams and
// `approvals.decide`. These tests pin the rule at its one home; the seats that call it are
// covered by typecheck (they no longer contain a second copy).
import { describe, expect, test } from 'bun:test';

import {
  bareApproveArm,
  isApproveAllMenuReply,
  isPlainApprove,
  resolveBareApprove,
} from '../../../src/lib/channel-bare-approve';
import { proposedAnswer } from '../../../src/domain/engagement/deblock-actions';

const BUG_FIX_MARKER = 'bug_fix_authorization';
const APPROVE = { approvalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', decision: 'approve' } as const;

/** A marked bug-fix authorization: fix ALL cited bugs when approved in one word. */
const BUG_FIX_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tenant_id: '11111111-2222-3333-4444-555555555555',
  kind: 'execution.ready_signoff',
  metadata: { approval_kind: BUG_FIX_MARKER, bug_ids: ['b1', 'b2'], report_hash: 'h' },
};

/** A QUESTION row whose producer sentence names the reviewer's recommendation. */
function questionRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tenant_id: '11111111-2222-3333-4444-555555555555',
    kind: 'generic',
    metadata: {
      deblock_action: 'QUESTION',
      open_questions: [
        'The reviewer recommends "BLOCKED". Approve with "yes" to accept that, or state what to do instead.',
      ],
      ...extra,
    },
  };
}

describe('isPlainApprove', () => {
  test('a bare approve is a plain approve', () => {
    expect(isPlainApprove(APPROVE)).toBe(true);
    expect(isPlainApprove({ ...APPROVE, comment: 'approve' })).toBe(true);
    expect(isPlainApprove({ ...APPROVE, comment: '  Yes.  ' })).toBe(true);
  });

  test('a TYPED ANSWER is never a plain approve — the human\'s own words are not replaced', () => {
    expect(isPlainApprove({ ...APPROVE, comment: 'approve only the first one' })).toBe(false);
    expect(isPlainApprove({ ...APPROVE, comment: 'retry against staging' })).toBe(false);
  });

  test('a caller that already supplied the structured fields said what it meant', () => {
    expect(isPlainApprove({ ...APPROVE, g12_decision: { rule_row: 'A1' } })).toBe(false);
    expect(isPlainApprove({ ...APPROVE, rejected_bug_ids: ['b2'] })).toBe(false);
  });

  test('a reject is not an approve', () => {
    expect(isPlainApprove({ ...APPROVE, decision: 'reject' })).toBe(false);
  });
});

describe('bareApproveArm', () => {
  test('approve-all: a marked bug-fix authorization', () => {
    expect(bareApproveArm(BUG_FIX_ROW)).toBe('approve-all');
  });

  test('accepts-blocked: a QUESTION row whose reviewer recommends BLOCKED', () => {
    expect(bareApproveArm(questionRow())).toBe('accepts-blocked');
  });

  test('none: the same row once it carries a PROPOSED ANSWER (fr#1687) — the approve stands', () => {
    expect(bareApproveArm(questionRow({ proposed_answer: 'retry against staging' }))).toBe('none');
  });

  test('none: an INFRASTRUCTURE hold — it owes a statement of what was fixed, not an acceptance', () => {
    expect(bareApproveArm(questionRow({ deblock_action: 'INFRASTRUCTURE' }))).toBe('none');
  });

  test('none: a row that owes nothing at all', () => {
    expect(bareApproveArm({ ...BUG_FIX_ROW, kind: 'generic', metadata: {} })).toBe('none');
  });
});

describe('resolveBareApprove', () => {
  test('approve-all completes the G-12 body every channel needs', async () => {
    const out = await resolveBareApprove(BUG_FIX_ROW, { ...APPROVE }, { approveAllForm: true });
    expect(out.input.decision).toBe('approve');
    expect((out.input.g12_decision as Record<string, unknown>).rule_row).toBeDefined();
    expect(out.preface).toContain('Approved ALL 2 bugs');
  });

  test('accepts-blocked records a REJECT, so the card stays BLOCKED', async () => {
    const out = await resolveBareApprove(questionRow(), { ...APPROVE });
    expect(out.input.decision).toBe('reject');
    expect(out.input.comment).toContain('Accepted reviewer recommendation: BLOCKED');
    expect(out.preface).toContain('recorded as a REJECT');
  });

  test('a reply an LLM read as an approval claims NEITHER derivation', async () => {
    expect((await resolveBareApprove(BUG_FIX_ROW, { ...APPROVE }, { bareGrammar: false, approveAllForm: true })).input.g12_decision)
      .toBeUndefined();
    expect((await resolveBareApprove(questionRow(), { ...APPROVE }, { bareGrammar: false })).input.decision)
      .toBe('approve');
  });

  test('a typed answer passes through untouched, on every arm', async () => {
    const typed = { ...APPROVE, comment: 'fix only the first two' };
    expect((await resolveBareApprove(BUG_FIX_ROW, typed, { approveAllForm: true })).input).toEqual(typed);
    expect((await resolveBareApprove(questionRow(), typed)).input.decision).toBe('approve');
  });

  test('approve-all needs the menu form: `yes` on a bug-fix row is refused, not approve-ALL', async () => {
    // The owner's 2026-10-02 ruling is three forms. A seat that cannot prove the form (Teams'
    // button, an mcp bare approve) must not fix every cited bug having shown nothing.
    const out = await resolveBareApprove(BUG_FIX_ROW, { ...APPROVE, comment: 'yes' });
    expect(out.input.g12_decision).toBeUndefined();
  });

  test('isApproveAllMenuReply admits exactly the three menu forms', () => {
    for (const ok of ['1', ' 1 ', 'Approve', 'approve', '1 - Approve', '1: approve', '[ApprovalId:abc] 1']) {
      expect(isApproveAllMenuReply(ok), ok).toBe(true);
    }
    for (const no of ['yes', 'ok', '2', '1 - Approve please', 'approve the first bug']) {
      expect(isApproveAllMenuReply(no), no).toBe(false);
    }
  });

  test('a proposed answer is honoured on a QUESTION row only (fr#1687 is QUESTION-only)', () => {
    expect(proposedAnswer(questionRow({ proposed_answer: 'x' }).metadata)).toBe('x');
    // A stray key on an INFRASTRUCTURE hold must NOT suppress the ask: nobody would fill it.
    expect(proposedAnswer(questionRow({ proposed_answer: 'x', deblock_action: 'INFRASTRUCTURE' }).metadata)).toBeNull();
  });
});
