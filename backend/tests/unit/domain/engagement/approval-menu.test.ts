// ONE MENU, EVERY TEXT CHANNEL (owner ruling 2026-10-31).
//
// The menu a human reads and the rule that runs on their `1` are the SAME predicate
// (`bareApproveArm`), so a channel can never offer an option the decide path refuses. These
// pin the three shapes — and the absence of any per-transport variation.
import { describe, expect, test } from 'bun:test';

import {
  approvalMenuLines,
  FOOTER_ANSWER_PLACEHOLDER,
  FOOTER_NOTE_ACCEPTS_BLOCKED,
} from '../../../../src/domain/engagement/approval-menu';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const PLAIN = { id: ID, kind: 'generic', metadata: {} };

const BUG_FIX = {
  id: ID,
  kind: 'execution.ready_signoff',
  metadata: { approval_kind: 'bug_fix_authorization', bug_ids: ['b1'], report_hash: 'h' },
};

const QUESTION_BLOCKED = {
  id: ID,
  kind: 'generic',
  metadata: {
    deblock_action: 'QUESTION',
    open_questions: [
      'The reviewer recommends "BLOCKED". Approve with "yes" to accept that, or state what to do instead.',
    ],
  },
};

const QUESTION_OPEN = { id: ID, kind: 'generic', metadata: { deblock_action: 'QUESTION', open_questions: ['which repo?'] } };

describe('approvalMenuLines', () => {
  test('a plain row offers the same three numbered replies on every channel', () => {
    const lines = approvalMenuLines(PLAIN);
    expect(lines[0]).toBe('Reply to THIS message with:');
    expect(lines[1]).toBe('1 - Approve');
    expect(lines.join('\n')).toContain(`approve: ${FOOTER_ANSWER_PLACEHOLDER}`);
    expect(lines.join('\n')).toContain('2 - Reject');
    expect(lines.join('\n')).toContain('3 - Question');
  });

  test('an approve-all row offers only `1` and names the fr link for anything finer', () => {
    const lines = approvalMenuLines(BUG_FIX);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Reply 1 to approve ALL');
    expect(lines[0]).toContain(`/approvals/${ID}`);
  });

  test('a BLOCKED recommendation says so, because `1` is recorded as a REJECT', () => {
    expect(approvalMenuLines(QUESTION_BLOCKED).join('\n')).toContain(FOOTER_NOTE_ACCEPTS_BLOCKED);
    expect(approvalMenuLines(PLAIN).join('\n')).not.toContain(FOOTER_NOTE_ACCEPTS_BLOCKED);
  });

  test('no channel carries a "what happens next" note — the options are the whole message', () => {
    expect(approvalMenuLines(QUESTION_OPEN).join('\n')).not.toContain("I'll ask for your answer");
  });
});
