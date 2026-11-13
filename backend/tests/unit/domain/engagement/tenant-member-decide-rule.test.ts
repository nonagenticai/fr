// tests/unit/domain/engagement/tenant-member-decide-rule.test.ts
//
// fr-agui P1-TEAM-b (George 2026-10-15) — the PURE halves of the new decide rule, shared
// by all four decide seats:
//
//   * `tenantMemberArmPrecondition` — when the 1-of-any tenant-member arm may be
//     considered at all (the membership read then fails closed);
//   * `isSystemRaisedApproval` / `isHumanRequesterDecidingOwnApproval` — the requester of a
//     conveyor/system-raised row is the SYSTEM, so the owner its `requester_id` defaulted to
//     is not locked out; a HUMAN-raised row keeps the self-decision refusal;
//   * (the chat-seat discharge rule now lives in the shared decide path) — the
//     roster is never enumerated per member (no N-of-N gate).
//
// MUTATIONS shown red (P1-TEAM-b report): the arm's tenant-equality term dropped; the
// owner-on-conveyor exemption broken (`isSystemRaisedApproval` → false); the action_id term
// dropped (an action approval whose X-Channel says `n8n` would become self-decidable).

import { describe, expect, test } from 'bun:test';
import {
  isHumanRequesterDecidingOwnApproval,
  isSystemRaisedApproval,
  tenantMemberArmPrecondition,
} from '../../../../src/domain/engagement/decision-guards';

const T = '0195f48b-d000-7000-8000-0000000000a1';
const OTHER = '0195f48b-d000-7000-8000-0000000000b2';
const OWNER = 'owner-1';

describe('tenantMemberArmPrecondition', () => {
  const base = {
    approvalTenantId: T,
    callerTenantId: T,
    callerMatchedARosterRow: false,
    rosterSize: 1,
    superAdminDecider: false,
  };

  test('open for an unrostered caller acting in the approval\'s own tenant, on a non-empty roster', () => {
    expect(tenantMemberArmPrecondition(base)).toBe(true);
  });

  test('⛔ CLOSED for a caller acting in ANOTHER tenant (the home-view read relaxation never becomes a write)', () => {
    expect(tenantMemberArmPrecondition({ ...base, callerTenantId: OTHER })).toBe(false);
    expect(tenantMemberArmPrecondition({ ...base, callerTenantId: null })).toBe(false);
    expect(tenantMemberArmPrecondition({ ...base, approvalTenantId: null, callerTenantId: null })).toBe(false);
    expect(tenantMemberArmPrecondition({ ...base, approvalTenantId: '', callerTenantId: '' })).toBe(false);
  });

  test('closed on an EMPTY roster (no obligation to discharge — never approve into nothing)', () => {
    expect(tenantMemberArmPrecondition({ ...base, rosterSize: 0 })).toBe(false);
    // P1-TEAM-c: an ACTION approval is no longer special here — any member may approve it
    // and it runs AS the approver (`resolvePendingAction`); the precondition has no term.
    expect(tenantMemberArmPrecondition({ ...base })).toBe(true);
  });

  test('closed when the caller already matched a row (their candidate set is unchanged) or is the super-admin arm', () => {
    expect(tenantMemberArmPrecondition({ ...base, callerMatchedARosterRow: true })).toBe(false);
    expect(tenantMemberArmPrecondition({ ...base, superAdminDecider: true })).toBe(false);
  });
});

describe('isSystemRaisedApproval / isHumanRequesterDecidingOwnApproval — the requester exemption', () => {
  test('a conveyor-raised row (source n8n, no action) is SYSTEM-raised: the owner it names may decide it', () => {
    const conveyor = { source: 'n8n', action_id: null, requester_id: OWNER };
    expect(isSystemRaisedApproval(conveyor)).toBe(true);
    // ⭐ THE NON-REGRESSION: the owner decides conveyor sign-offs today and must keep doing so.
    expect(isHumanRequesterDecidingOwnApproval(conveyor, OWNER)).toBe(false);
  });

  test('a HUMAN-raised row (web / default) keeps the refusal: the requester may not decide it', () => {
    for (const source of ['web', null, undefined, 'telegram', 'agent']) {
      const human = { source, action_id: null, requester_id: OWNER };
      expect(isSystemRaisedApproval(human)).toBe(false);
      expect(isHumanRequesterDecidingOwnApproval(human, OWNER)).toBe(true);
      // CONTROL: somebody else deciding it is never this guard's business.
      expect(isHumanRequesterDecidingOwnApproval(human, 'someone-else')).toBe(false);
    }
  });

  test('⛔ an ACTION approval is never system-raised, even when its caller-controlled X-Channel said n8n', () => {
    const action = { source: 'n8n', action_id: '0195f48b-d000-7000-8000-00000000ac71', requester_id: OWNER };
    expect(isSystemRaisedApproval(action)).toBe(false);
    expect(isHumanRequesterDecidingOwnApproval(action, OWNER)).toBe(true);
  });

  test('⛔ an n8n-source row minted with a PERSON\'s JWT (metadata.requested_via = jwt) is human-raised: the guard applies', () => {
    const jwtMint = { source: 'n8n', action_id: null, requester_id: 'owner', metadata: { requested_via: 'jwt', requested_by_user_id: 'owner' } };
    expect(isSystemRaisedApproval(jwtMint)).toBe(false);
    expect(isHumanRequesterDecidingOwnApproval(jwtMint, 'owner')).toBe(true);
    // CONTROL: the licence (conveyor seat) mint of the same row is system-raised.
    const licenceMint = { ...jwtMint, metadata: { requested_via: 'licence' } };
    expect(isSystemRaisedApproval(licenceMint)).toBe(true);
    expect(isHumanRequesterDecidingOwnApproval(licenceMint, 'owner')).toBe(false);
  });

  test('a requester-less row has nobody to protect', () => {
    expect(isHumanRequesterDecidingOwnApproval({ source: 'web', requester_id: null }, OWNER)).toBe(false);
  });
});

