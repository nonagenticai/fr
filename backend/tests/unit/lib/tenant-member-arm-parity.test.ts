// tests/unit/lib/tenant-member-arm-parity.test.ts
//
// fr-agui P1-TEAM-b — the decide rule exists twice: the backend
// (`domain/engagement/decision-guards.ts`, read by all four decide seats) and the UI
// (`frontend/src/lib/approvals/tenantMemberArm.ts`, read by `canAct.ts` /
// `ApprovalDecisionSurface.svelte`, whose header says they change together). A term on
// one side only renders an Approve the server refuses, or hides one it would accept.
// This pins the two EQUAL over a case matrix, plus the PUSH_CHANNELS set the "no push
// channel" banner mirrors.
//
// The frontend modules are pure TS with no `$lib` imports, so Bun loads them directly;
// imported by computed URL so the backend `tsc` program does not compile a frontend file
// (the `wm-byo-errors-parity.test.ts` precedent).
import { describe, expect, test } from 'bun:test';
import { tenantMemberArmPrecondition } from '../../../src/domain/engagement/decision-guards';
import { PUSH_CHANNELS as BE_PUSH } from '../../../src/domain/engagement/approval-routing';

const ARM = new URL('../../../../frontend/src/lib/approvals/tenantMemberArm.ts', import.meta.url).href;
const PUSH = new URL('../../../../frontend/src/lib/approvals/pushChannels.ts', import.meta.url).href;
type Row = {
  required_approvers?: Array<{ user_id?: string | null; role?: string | null }>;
  tenant_id?: string | null;
  action_id?: string | null;
};
type U = { id: string; roles?: string[]; tenant_id?: string | null };
const fe = (await import(ARM)) as {
  tenantMemberArmApplies: (a: Row, u: U | null) => boolean;
};
const fePush = (await import(PUSH)) as { PUSH_CHANNELS: ReadonlySet<string> };

const T = '0195f48b-d000-7000-8000-0000000000a1';
const OTHER = '0195f48b-d000-7000-8000-0000000000b2';
const ME = 'me';

const ROSTERS: Array<Row['required_approvers']> = [
  [],
  [{ user_id: 'ghost' }],
  [{ user_id: ME }],
  [{ user_id: 'ghost', role: 'card_approver' }],
  [{ user_id: 'ghost' }, { user_id: 'ghost-2' }],
];
const ROW_TENANTS = [T, OTHER, null, ''];
const ACTION_IDS: Array<string | null | undefined> = [undefined, null, '', '0195f48b-d000-7000-8000-00000000ac71'];
const USERS: U[] = [
  { id: ME, tenant_id: T },
  { id: ME, tenant_id: OTHER },
  { id: ME, tenant_id: null },
  { id: ME, tenant_id: T, roles: ['card_approver'] },
];

/** The backend's arm, as the web seat composes it for a caller who is a member. */
function backendArm(a: Row, u: U): boolean {
  const roles = u.roles ?? [];
  const matched = (a.required_approvers ?? []).some(
    (r) => r.user_id === u.id || (!!r.role && roles.includes(r.role)),
  );
  return tenantMemberArmPrecondition({
    approvalTenantId: a.tenant_id,
    callerTenantId: u.tenant_id,
    callerMatchedARosterRow: matched,
    rosterSize: (a.required_approvers ?? []).length,
    superAdminDecider: false,
  });
}

describe('tenant-member arm — backend precondition ≡ frontend tenantMemberArmApplies', () => {
  let cases = 0;
  for (const roster of ROSTERS) {
    for (const tenant of ROW_TENANTS) {
      for (const user of USERS) {
        for (const action_id of ACTION_IDS) {
          const row: Row = { required_approvers: roster, tenant_id: tenant, action_id };
          const label = `roster=${JSON.stringify(roster)} row=${tenant} action=${action_id} user=${JSON.stringify(user)}`;
          cases++;
          test(label, () => {
            expect(fe.tenantMemberArmApplies(row, user)).toBe(backendArm(row, user));
          });
        }
      }
    }
  }
  test('the matrix is not vacuous: both answers occur', () => {
    const answers = new Set<boolean>();
    for (const roster of ROSTERS)
      for (const tenant of ROW_TENANTS)
        for (const user of USERS) answers.add(backendArm({ required_approvers: roster, tenant_id: tenant }, user));
    expect(answers).toEqual(new Set([true, false]));
    expect(cases).toBe(ROSTERS.length * ROW_TENANTS.length * USERS.length * ACTION_IDS.length);
    // P1-TEAM-c: an action approval opens the arm too, on BOTH sides (it runs as the approver).
    const open = { required_approvers: [{ user_id: 'ghost' }], tenant_id: T };
    expect(backendArm(open, USERS[0]!)).toBe(true);
    expect(backendArm({ ...open, action_id: 'act-1' }, USERS[0]!)).toBe(true);
    expect(fe.tenantMemberArmApplies({ ...open, action_id: 'act-1' }, USERS[0]!)).toBe(true);
  });
});

describe('PUSH_CHANNELS — the banner mirrors the routing set', () => {
  test('identical sets', () => {
    expect([...fePush.PUSH_CHANNELS].sort()).toEqual([...BE_PUSH].sort());
  });
});
