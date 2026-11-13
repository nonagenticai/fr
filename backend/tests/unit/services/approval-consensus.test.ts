import { test, expect, describe } from 'bun:test';
import {
  evaluateConsensus,
  dedupeDecisions,
  type ApproverDecision,
  type RequiredApprover,
} from '../../../src/services/approval-consensus';

const U = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

describe('evaluateConsensus — card-approval flow (no required approvers)', () => {
  test('single approver approves → approved', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'approved', decided_at: new Date('2026-04-23T12:00:00Z') },
    ];
    const result = evaluateConsensus(decisions, []);
    expect(result.status).toBe('approved');
    expect(result.decidedBy).toBe(U(1));
    expect(result.decisionAt?.toISOString()).toBe('2026-04-23T12:00:00.000Z');
  });

  test('single approver rejects → rejected', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'rejected', decided_at: new Date('2026-04-23T12:00:00Z'), comment: 'no' },
    ];
    const result = evaluateConsensus(decisions, []);
    expect(result.status).toBe('rejected');
    expect(result.decidedBy).toBe(U(1));
  });

  test('no decisions yet → pending', () => {
    const result = evaluateConsensus([], []);
    expect(result.status).toBe('pending');
    expect(result.decidedBy).toBeUndefined();
  });
});

describe('evaluateConsensus — multi-approver flow', () => {
  const required: RequiredApprover[] = [
    { user_id: U(1) },
    { user_id: U(2) },
    { user_id: U(3) },
  ];

  test('one approves, others pending → pending', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'approved', decided_at: new Date('2026-04-23T12:00:00Z') },
    ];
    const result = evaluateConsensus(decisions, required);
    expect(result.status).toBe('pending');
  });

  test('all approve → approved, decidedBy is the last approver', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'approved', decided_at: new Date('2026-04-23T12:00:00Z') },
      { approver_id: U(2), decision: 'approved', decided_at: new Date('2026-04-23T12:05:00Z') },
      { approver_id: U(3), decision: 'approved', decided_at: new Date('2026-04-23T12:10:00Z') },
    ];
    const result = evaluateConsensus(decisions, required);
    expect(result.status).toBe('approved');
    expect(result.decidedBy).toBe(U(3));
    expect(result.decisionAt?.toISOString()).toBe('2026-04-23T12:10:00.000Z');
  });

  test('one rejects before others vote → rejected (any-reject kills it)', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'approved', decided_at: new Date('2026-04-23T12:00:00Z') },
      { approver_id: U(2), decision: 'rejected', decided_at: new Date('2026-04-23T12:02:00Z'), comment: 'nope' },
    ];
    const result = evaluateConsensus(decisions, required);
    expect(result.status).toBe('rejected');
    expect(result.decidedBy).toBe(U(2));
  });

  test('extra approver not in required list does NOT satisfy a missing required user', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'approved', decided_at: new Date('2026-04-23T12:00:00Z') },
      { approver_id: U(2), decision: 'approved', decided_at: new Date('2026-04-23T12:05:00Z') },
      { approver_id: U(99), decision: 'approved', decided_at: new Date('2026-04-23T12:10:00Z') },
    ];
    const result = evaluateConsensus(decisions, required);
    expect(result.status).toBe('pending');
  });
});

describe('dedupeDecisions', () => {
  test('keeps earliest decision per approver', () => {
    const decisions: ApproverDecision[] = [
      { approver_id: U(1), decision: 'approved', decided_at: new Date('2026-04-23T12:10:00Z') },
      { approver_id: U(1), decision: 'rejected', decided_at: new Date('2026-04-23T12:05:00Z') },
      { approver_id: U(2), decision: 'approved', decided_at: new Date('2026-04-23T12:00:00Z') },
    ];
    const deduped = dedupeDecisions(decisions);
    expect(deduped).toHaveLength(2);
    const u1 = deduped.find((d) => d.approver_id === U(1));
    expect(u1?.decision).toBe('rejected');
  });
});
