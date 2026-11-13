// tests/unit/services/approval-roster-quorum.test.ts
//
// fr#1059 — `evaluateRosterQuorum`, THE one quorum rule every decision seat (HTTP,
// Telegram, Teams) calls. George's ruling 2026-10-03 ("role slot"): a roster row is
// an OBLIGATION, discharged by its named user OR any holder of its role; quorum asks "is
// every obligation discharged?", never "did every NAMED user decide?". Every branch below,
// plus the discriminating case that FAILS under the old "named person required" meaning.

import { test, expect, describe } from 'bun:test';
import {
  evaluateConsensus,
  evaluateRosterQuorum,
} from '../../../src/services/approval-consensus';

const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_X = 'user-x-role-holder-not-named';
const ROLE = 'execution_signoff';

const rowA = { id: 'ra-a', user_id: USER_A, role: ROLE };
const rowB = { id: 'ra-b', user_id: USER_B, role: ROLE };

describe('evaluateRosterQuorum — every branch', () => {
  test('no decisions → pending', () => {
    expect(evaluateRosterQuorum([rowA], [])).toBe('pending');
  });

  test('any rejection → rejected, even alongside approvals that would complete it', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: 'ra-a' },
          { decision: 'approved', required_approver_id: 'ra-b' },
          { decision: 'rejected', required_approver_id: 'ra-b' },
        ],
      ),
    ).toBe('rejected');
  });

  test('rejection with an empty roster → rejected', () => {
    expect(evaluateRosterQuorum([], [{ decision: 'rejected', required_approver_id: null }])).toBe(
      'rejected',
    );
  });

  test('decisions present but none approved/rejected (unknown value) → pending', () => {
    expect(evaluateRosterQuorum([rowA], [{ decision: 'abstained', required_approver_id: 'ra-a' }])).toBe(
      'pending',
    );
  });

  test('empty roster + one approval → approved (card-approval flow)', () => {
    expect(evaluateRosterQuorum([], [{ decision: 'approved', required_approver_id: null }])).toBe(
      'approved',
    );
  });

  test('pre-108 decision (null required_approver_id): count compare — short → pending', () => {
    expect(
      evaluateRosterQuorum([rowA, rowB], [{ decision: 'approved', required_approver_id: null }]),
    ).toBe('pending');
  });

  test('pre-108 decision (null required_approver_id): count compare — equal → approved', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: null },
          { decision: 'approved', required_approver_id: 'ra-a' },
        ],
      ),
    ).toBe('approved');
  });

  test('every obligation discharged → approved', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: 'ra-b' },
          { decision: 'approved', required_approver_id: 'ra-a' },
        ],
      ),
    ).toBe('approved');
  });

  test('one of two obligations discharged → pending', () => {
    expect(
      evaluateRosterQuorum([rowA, rowB], [{ decision: 'approved', required_approver_id: 'ra-a' }]),
    ).toBe('pending');
  });

  test('two approvals on the SAME obligation do not discharge the other one → pending', () => {
    // Discriminates the obligation check from a count compare (2 approvals, 2 rows).
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: 'ra-a' },
          { decision: 'approved', required_approver_id: 'ra-a' },
        ],
      ),
    ).toBe('pending');
  });

  test('an approval naming a row NOT on the roster discharges nothing → pending', () => {
    expect(
      evaluateRosterQuorum([rowA], [{ decision: 'approved', required_approver_id: 'ra-elsewhere' }]),
    ).toBe('pending');
  });
});

describe('evaluateRosterQuorum — ROLE SLOT, not "named person required" (fr#1059)', () => {
  // ⛔ This test is titled for the meaning it refutes. Under "a row requires the PERSON it
  // names", X (≠ A) approving rowA leaves rowA's person undecided ⇒ pending. Under the
  // ruling ("role slot"), X holds rowA's role and discharged it ⇒ approved.
  test('ROLE SLOT (fails under "named person required"): X approves rowA naming A → approved', () => {
    const decisions = [
      { approver_id: USER_X, decision: 'approved', required_approver_id: 'ra-a' },
    ];
    expect(evaluateRosterQuorum([rowA], decisions)).toBe('approved');
  });

  test('the OLD chat-seat rule (evaluateConsensus, every named user decided) says pending here — the split-brain', () => {
    // Documents what the chat seats used to compute for the same facts. If the two agreed,
    // the role-slot test above would not be discriminating.
    const old = evaluateConsensus(
      [{ approver_id: USER_X, decision: 'approved' }],
      [{ user_id: USER_A }],
    );
    expect(old.status).toBe('pending');
    expect(
      evaluateRosterQuorum([rowA], [{ decision: 'approved', required_approver_id: 'ra-a' }]),
    ).not.toBe(old.status);
  });

  test('split-brain shape: X discharges rowA (web), B discharges rowB (chat) → approved', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: 'ra-a' }, // by X, role holder
          { decision: 'approved', required_approver_id: 'ra-b' }, // by B, named
        ],
      ),
    ).toBe('approved');
    // the old rule: A never decided ⇒ pending forever
    expect(
      evaluateConsensus(
        [
          { approver_id: USER_X, decision: 'approved' },
          { approver_id: USER_B, decision: 'approved' },
        ],
        [{ user_id: USER_A }, { user_id: USER_B }],
      ).status,
    ).toBe('pending');
  });
});

describe('evaluateRosterQuorum — role slots are fungible (a matching, not a lookup)', () => {
  const USER_C = 'user-c';
  const SUPER = 'user-super-admin';
  const rowC = { id: 'ra-c', user_id: USER_C, role: ROLE };
  const rowNoRole = { id: 'ra-n', user_id: USER_B, role: null };

  test('order independence: X stands in on B\'s row, B decides its own row → approved (A never acted)', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: 'ra-b', approver_id: USER_X },
          { decision: 'approved', required_approver_id: 'ra-b', approver_id: USER_B },
        ],
      ),
    ).toBe('approved');
  });

  test('…and the same pair in the other row order → approved', () => {
    expect(
      evaluateRosterQuorum(
        [rowB, rowA],
        [
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_X },
          { decision: 'approved', required_approver_id: 'ra-b', approver_id: USER_B },
        ],
      ),
    ).toBe('approved');
  });

  test('a named user\'s own decision fills ONLY its own row: A twice-recorded on rowA does not cover rowB', () => {
    // (UNIQUE (approval_id, approver_id) forbids this in the DB; the rule must not need it.)
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [{ decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_A }],
      ),
    ).toBe('pending');
  });

  test('a stand-in never covers a row that asks for NO role', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowNoRole],
        [
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_A },
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_X },
        ],
      ),
    ).toBe('pending');
  });

  test('a stand-in only covers rows of ITS row\'s role', () => {
    const rowOther = { id: 'ra-o', user_id: USER_C, role: 'card_approver' };
    expect(
      evaluateRosterQuorum(
        [rowA, rowOther],
        [
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_A },
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_X },
        ],
      ),
    ).toBe('pending');
  });

  test('one stand-in covers ONE slot: 3 slots, 1 stand-in + 1 named → pending', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB, rowC],
        [
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: SUPER },
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_A },
        ],
      ),
    ).toBe('pending');
  });

  test('validator scenario: override on rowA + A + C → approved; the override is ONE slot of the role (stamped on the HTTP seat)', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB, rowC],
        [
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: SUPER },
          { decision: 'approved', required_approver_id: 'ra-a', approver_id: USER_A },
          { decision: 'approved', required_approver_id: 'ra-c', approver_id: USER_C },
        ],
      ),
    ).toBe('approved');
  });

  test('a decision without approver_id is read as the row\'s own named user (never fungible)', () => {
    expect(
      evaluateRosterQuorum(
        [rowA, rowB],
        [
          { decision: 'approved', required_approver_id: 'ra-b' },
          { decision: 'approved', required_approver_id: 'ra-b', approver_id: USER_B },
        ],
      ),
    ).toBe('pending');
  });
});
