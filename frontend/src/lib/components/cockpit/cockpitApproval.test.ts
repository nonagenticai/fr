import { describe, it, expect } from 'vitest';
import { cockpitApprovalActable, pendingApprovals } from './cockpitApproval';
import type { CockpitApproval } from '$lib/types/cockpit';

const approval = (over: Partial<CockpitApproval>): CockpitApproval => ({
  id: 'a1',
  kind: 'execution_signoff',
  status: 'pending',
  description: 'Security sign-off',
  card_id: 'c1',
  created_at: null,
  expires_at: null,
  required_approvers: [],
  decisions: [],
  ...over,
});

describe('cockpitApprovalActable', () => {
  const user = { id: 'u1', roles: ['workspace-admin'] };

  it('is false for a null user', () => {
    expect(cockpitApprovalActable(approval({}), null)).toBe(false);
  });

  it('is true for a required approver (by user id) who has not decided', () => {
    const a = approval({ required_approvers: [{ user_id: 'u1', role: null }] });
    expect(cockpitApprovalActable(a, user)).toBe(true);
  });

  it('matches a required approver by role (null role coerced, not matched)', () => {
    const a = approval({ required_approvers: [{ user_id: 'other', role: 'workspace-admin' }] });
    expect(cockpitApprovalActable(a, user)).toBe(true);
  });

  it('is false once the user has already recorded a decision', () => {
    const a = approval({
      required_approvers: [{ user_id: 'u1', role: null }],
      decisions: [{ approver_id: 'u1', decision: 'approved', comment: null, decided_at: '2026-07-08T00:00:00Z' }],
    });
    expect(cockpitApprovalActable(a, user)).toBe(false);
  });

  it('is false for a non-approver', () => {
    const a = approval({ required_approvers: [{ user_id: 'someone-else', role: null }] });
    expect(cockpitApprovalActable(a, user)).toBe(false);
  });
});

describe('pendingApprovals', () => {
  it('keeps only pending approvals', () => {
    const rows = [
      approval({ id: 'a', status: 'pending' }),
      approval({ id: 'b', status: 'approved' }),
      approval({ id: 'c', status: 'pending' }),
    ];
    expect(pendingApprovals(rows).map((a) => a.id)).toEqual(['a', 'c']);
  });
});
