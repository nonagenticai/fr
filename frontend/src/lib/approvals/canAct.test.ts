import { describe, it, expect } from 'vitest';
import {
  isRequiredApprover,
  canActOnApproval,
  isSuperAdminDecider,
  isTenantMemberDecider,
} from './canAct';
import type { Approval } from '$lib/types/api';

const base = {
  id: 'a1',
  project_id: 'p1',
  requester_id: 'r1',
  status: 'pending',
  description: 'gate',
  created_at: '',
  expires_at: '',
} as unknown as Approval;

const withApprovers = (over: Partial<Approval>): Approval => ({ ...base, ...over });

describe('isRequiredApprover', () => {
  it('matches by user id', () => {
    const a = withApprovers({ required_approvers: [{ user_id: 'u1', role: 'execution_signoff' }] });
    expect(isRequiredApprover(a, { id: 'u1', roles: [] })).toBe(true);
    expect(isRequiredApprover(a, { id: 'u2', roles: [] })).toBe(false);
  });

  it('matches by a role the user holds', () => {
    const a = withApprovers({ required_approvers: [{ user_id: 'someone', role: 'execution_signoff' }] });
    expect(isRequiredApprover(a, { id: 'u2', roles: ['execution_signoff'] })).toBe(true);
    expect(isRequiredApprover(a, { id: 'u2', roles: ['other'] })).toBe(false);
  });

  it('false for null user or empty roster', () => {
    expect(isRequiredApprover(withApprovers({ required_approvers: [] }), { id: 'u1' })).toBe(false);
    expect(isRequiredApprover(withApprovers({ required_approvers: [{ user_id: 'u1' }] }), null)).toBe(
      false,
    );
  });
});

describe('canActOnApproval', () => {
  it('true for a required approver who has not decided', () => {
    const a = withApprovers({ required_approvers: [{ user_id: 'u1' }], decisions: [] });
    expect(canActOnApproval(a, { id: 'u1' })).toBe(true);
  });

  it('false once the user has already decided', () => {
    const a = withApprovers({
      required_approvers: [{ user_id: 'u1' }],
      decisions: [{ approver_id: 'u1', decision: 'approved', decided_at: '' }],
    });
    expect(canActOnApproval(a, { id: 'u1' })).toBe(false);
  });

  it('false for a non-approver even before any decision', () => {
    const a = withApprovers({ required_approvers: [{ user_id: 'u1' }], decisions: [] });
    expect(canActOnApproval(a, { id: 'stranger' })).toBe(false);
  });
});

// ── ROUND 5: THE SUPER-ADMIN ARM ────────────────────────────────────────────────
// MEASURED 2026-09-15 on production: the product owner holds `super_admin` and
// NEITHER `card_approver` NOR `execution_signoff`, and is on ZERO
// `required_approvers` rows out of 1032 pending. Every one of these assertions is
// RED against the pre-round-5 predicate, which is the point of writing them.
describe('canActOnApproval — super-admin', () => {
  it('lets a super-admin who is NOT on the roster act (the product owner case)', () => {
    const a = withApprovers({
      required_approvers: [{ user_id: 'someone-else', role: 'card_approver' }],
      decisions: [],
    });
    // Control: he is genuinely not a required approver. The roster display must
    // keep saying so — this is not a back door into `isRequiredApprover`.
    expect(isRequiredApprover(a, { id: 'george', roles: ['super_admin'] })).toBe(false);
    expect(canActOnApproval(a, { id: 'george', roles: ['super_admin'] })).toBe(true);
  });

  it('DISCRIMINATING PAIR: the same row refuses a non-super-admin stranger', () => {
    const a = withApprovers({
      required_approvers: [{ user_id: 'someone-else', role: 'card_approver' }],
      decisions: [],
    });
    expect(canActOnApproval(a, { id: 'stranger', roles: ['member'] })).toBe(false);
  });

  it('refuses a super-admin on an EMPTY roster, mirroring the backend refusal', () => {
    // The backend widens WHICH obligation may be discharged; it does not invent one.
    // A bare `hasSuperAdmin(user)` here would render an enabled button that then 422s.
    const a = withApprovers({ required_approvers: [], decisions: [] });
    expect(canActOnApproval(a, { id: 'george', roles: ['super_admin'] })).toBe(false);
  });

  it('still refuses a super-admin who has already decided', () => {
    const a = withApprovers({
      required_approvers: [{ user_id: 'someone-else', role: 'card_approver' }],
      decisions: [{ approver_id: 'george', decision: 'approved', decided_at: '' }],
    });
    expect(canActOnApproval(a, { id: 'george', roles: ['super_admin'] })).toBe(false);
  });

  it('isSuperAdminDecider separates "acting anyway" from "is on the roster"', () => {
    const offRoster = withApprovers({
      required_approvers: [{ user_id: 'someone-else', role: 'card_approver' }],
    });
    const onRoster = withApprovers({
      required_approvers: [{ user_id: 'george', role: 'card_approver' }],
    });
    expect(isSuperAdminDecider(offRoster, { id: 'george', roles: ['super_admin'] })).toBe(true);
    // A super-admin who IS rostered is acting as the approver, not as an override.
    expect(isSuperAdminDecider(onRoster, { id: 'george', roles: ['super_admin'] })).toBe(false);
    expect(isSuperAdminDecider(offRoster, { id: 'stranger', roles: ['member'] })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fr-agui P1-TEAM-b (George 2026-10-15): deciding is 1-of-ANY tenant member. Mirrors the
// backend arm (`tenantMemberArmPrecondition`) — parity-pinned by
// `backend/tests/unit/lib/tenant-member-arm-parity.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────
describe('canActOnApproval — P1-TEAM-b tenant-member arm', () => {
  const T = '0195f48b-d000-7000-8000-0000000000a1';
  const OTHER = '0195f48b-d000-7000-8000-0000000000b2';
  const row = (over: Record<string, unknown> = {}) =>
    ({
      ...base,
      tenant_id: T,
      required_approvers: [{ user_id: 'ghost', role: 'card_approver' }],
      decisions: [],
      ...over,
    }) as unknown as Approval & { tenant_id: string };

  it('a member acting in the row\'s own workspace may decide a row whose roster names someone else', () => {
    const member = { id: 'm1', roles: [], tenant_id: T };
    expect(canActOnApproval(row(), member)).toBe(true);
    expect(isTenantMemberDecider(row(), member)).toBe(true);
    expect(isRequiredApprover(row(), member)).toBe(false); // the roster display stays honest
  });

  it('⭐ P1-TEAM-c: an ACTION approval is decidable by any member (it runs as the approver)', () => {
    const member = { id: 'm1', roles: [], tenant_id: T };
    expect(canActOnApproval(row({ action_id: 'act-1' }), member)).toBe(true);
    expect(isTenantMemberDecider(row({ action_id: 'act-1' }), member)).toBe(true);
    // …but never across workspaces.
    expect(canActOnApproval(row({ action_id: 'act-1' }), { id: 'm1', roles: [], tenant_id: OTHER })).toBe(false);
  });

  it('⛔ a member of ANOTHER workspace may not', () => {
    expect(canActOnApproval(row(), { id: 'm1', roles: [], tenant_id: OTHER })).toBe(false);
    expect(canActOnApproval(row(), { id: 'm1', roles: [] })).toBe(false);
  });

  it('an EMPTY roster has no obligation to discharge — no arm', () => {
    expect(canActOnApproval(row({ required_approvers: [] }), { id: 'm1', roles: [], tenant_id: T })).toBe(false);
  });

  it('a member who already decided may not act again', () => {
    const r = row({ decisions: [{ approver_id: 'm1', decision: 'approved', decided_at: '' }] });
    expect(canActOnApproval(r, { id: 'm1', roles: [], tenant_id: T })).toBe(false);
  });

  it('a row that cannot name its tenant enables nothing (an adapter shape without tenant_id)', () => {
    expect(canActOnApproval(row({ tenant_id: undefined }), { id: 'm1', roles: [], tenant_id: T })).toBe(false);
  });

  it('⭐ the OWNER may decide a conveyor-raised row whose requester_id defaulted to them', () => {
    const conveyor = row({ requester_id: 'owner', source: 'n8n', action_id: null });
    expect(canActOnApproval(conveyor, { id: 'owner', roles: [], tenant_id: T })).toBe(true);
  });
});
