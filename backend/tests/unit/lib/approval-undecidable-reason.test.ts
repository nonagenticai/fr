// tests/unit/lib/approval-undecidable-reason.test.ts
//
// Issues #888 and #890 — an approval a human cannot answer.
//
// This route already refuses to mint an approval nobody can be TOLD about
// ("a 24-hour timer, not a gate": 316 of 362 named no one, 335 expired unread).
// Two producers were minting the same defect from the other end — rows nobody
// could ANSWER:
//
//   #888  "BLOCK REASON [unknown_no_reason_persisted, source=placeholder-no-evidence]:
//          No reason provided"  — 8 of 10 pending rows, verbatim.
//   #890  'Author worker error: 500 INTERNAL_ERROR "Connection error."'
//          — 6 pending rows, identical, a crashed worker laundered into a question.
//
// 341 approvals have expired unanswered.
//
// ⚠️ THE FALSE-POSITIVE DIRECTION IS THE DANGEROUS ONE. Refusing a REAL gate
// strands a card in BLOCKED — worse than the problem being fixed. Half of these
// cases therefore assert that decidable reasons still PASS, including ones that
// merely mention an error. Those are not padding; they are the actual risk.

import { test, expect, describe } from 'bun:test';

import { classifyUndecidableReason } from '../../../src/lib/approval-rationale';

describe('the measured production strings are caught', () => {
  test('#888 — the placeholder 8 of 10 pending rows carried', () => {
    expect(
      classifyUndecidableReason(
        'BLOCK REASON [unknown_no_reason_persisted, source=placeholder-no-evidence]: No reason provided',
      ),
    ).toBe('placeholder');
  });

  test('#890 — the crashed author worker', () => {
    expect(
      classifyUndecidableReason(
        'Author worker error: 500 INTERNAL_ERROR "Connection error."',
      ),
    ).toBe('upstream_error');
  });
});

describe('nothing-values are caught', () => {
  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['No reason provided', 'placeholder'],
    ['no reason given', 'placeholder'],
    ['n/a', 'placeholder'],
    ['unknown', 'placeholder'],
    ['—', 'placeholder'],
    ['BLOCK REASON [whatever]:', 'placeholder'],
  ])('%p -> %p', (input, expected) => {
    expect(classifyUndecidableReason(input as string)).toBe(expected as never);
  });

  test('a machine token anywhere in the value is enough', () => {
    // These cannot occur in prose, so substring matching is safe for them.
    expect(
      classifyUndecidableReason('Gate Check said source=placeholder-no-evidence here'),
    ).toBe('placeholder');
  });
});

describe('a real gate is NEVER refused', () => {
  // The half that protects against the worse failure.
  test.each([
    'Gate Check term 3 fired: the migration has no rollback path.',
    'The PR changes a public API without a version bump.',
    'Deploy blocked: staging smoke test failed on /health, needs a human call.',
    // Mentions an error but is a decidable proposition — must NOT be refused.
    'The build hit 500 INTERNAL_ERROR twice; approve to retry or reject to hold.',
    'Connection error handling was removed in this diff — is that intended?',
    // Contains the word "unknown" but says something.
    'Impact on unknown downstream consumers; approve to proceed anyway.',
  ])('%p is decidable', (reason) => {
    expect(classifyUndecidableReason(reason)).toBeNull();
  });

  test('a reason that merely starts with a capitalised word is not a wrapper', () => {
    expect(
      classifyUndecidableReason('BLOCKED because the schema drifted from the ORM.'),
    ).toBeNull();
  });
});
