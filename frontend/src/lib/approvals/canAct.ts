// Shared approval-authorization helpers for the UI.
//
// The backend gates approval decisions to the approval's registered required
// approvers (execution_signoff stakeholders for n8n ready-signoff gates) OR to a
// super-admin, who may discharge any one of that approval's roster obligations; a
// caller who is neither just gets a 422 "not authorized". These helpers let every
// surface (the NEEDS YOU queue, the dedicated review page) decide, from the SAME
// rule, whether to offer the Approve/Reject controls or render the approval
// read-only. Single source of truth — unit-tested.
//
// ⛔ "The SAME rule" is the whole contract, and it is easy to half-change. Round 5
// added the super-admin arm HERE and in `handleUpdateApproval`; if you change one,
// change the other in the same commit, and keep a test that fails when they drift.
//
// ⭐ P1-TEAM-b (George 2026-10-15) added a THIRD arm on both sides: any member of the
// approval's tenant may decide it (1-of-any — one obligation discharged). The arm lives
// in `./tenantMemberArm.ts` (no `$lib` imports) so the backend parity test
// `tests/unit/lib/tenant-member-arm-parity.test.ts` pins it EQUAL to
// `domain/engagement/decision-guards.ts`.

import type { Approval } from '$lib/types/api';
import { hasSuperAdmin } from '$lib/utils/auth-guards';
import { tenantMemberArmApplies } from './tenantMemberArm';

export interface ApproverIdentity {
  id: string;
  roles?: string[];
  /** The ACTIVE workspace (`auth.user.tenant_id`). Drives the P1-TEAM-b tenant-member arm. */
  tenant_id?: string | null;
}

/**
 * True iff `user` would decide this row through the P1-TEAM-b TENANT-MEMBER arm — not
 * rostered, not a super-admin (that arm already says why), and acting in the row's own
 * tenant. Separate from `isRequiredApprover` for the same reason `isSuperAdminDecider` is:
 * a member is NOT a required approver, and the roster display must not claim otherwise.
 */
export function isTenantMemberDecider(
  a: Pick<Approval, 'required_approvers'> & { tenant_id?: string | null },
  user: ApproverIdentity | null | undefined,
): boolean {
  return !!user && !hasSuperAdmin(user) && tenantMemberArmApplies(a, user);
}

/**
 * True iff `user` is a required approver of the approval — matched by user id,
 * or by a role they hold (mirrors the backend's `user_id OR role` matcher in
 * handleListMyApprovals). Independent of whether they've already decided.
 */
export function isRequiredApprover(
  a: Pick<Approval, 'required_approvers'>,
  user: ApproverIdentity | null | undefined,
): boolean {
  if (!user) return false;
  const roles = user.roles ?? [];
  return (a.required_approvers ?? []).some(
    (r) => r.user_id === user.id || (!!r.role && roles.includes(r.role)),
  );
}

/**
 * True iff `user` is deciding as a super-admin rather than as a rostered approver.
 *
 * ⚠️ DELIBERATELY SEPARATE FROM `isRequiredApprover`, which stays honest: a
 * super-admin is NOT a required approver, and folding them together would make the
 * roster display claim a name that is not on it. This answers the different question
 * "may they act anyway", so a surface can both offer the controls AND say why.
 */
export function isSuperAdminDecider(
  a: Pick<Approval, 'required_approvers'>,
  user: ApproverIdentity | null | undefined,
): boolean {
  return !!user && hasSuperAdmin(user) && !isRequiredApprover(a, user);
}

/**
 * True iff `user` may still ACT on the approval — a required approver, OR a
 * super-admin, who has not already recorded a decision. Drives whether
 * Approve/Reject render.
 *
 * ⭐ THE SUPER-ADMIN ARM IS WHY ROUND 5 EXISTS. MEASURED 2026-09-15: the product
 * owner holds `super_admin` and neither `card_approver` nor `execution_signoff`, and
 * is on ZERO `required_approvers` rows out of 1032 pending. Every surface correctly
 * rendered him the read-only note, and the backend correctly 422'd him — the UI and
 * the API agreed perfectly with each other and left the owner of the product unable
 * to decide anything at all.
 *
 * ⛔ THIS MUST STAY IN STEP WITH `handleUpdateApproval` (routes/approvals.ts). The
 * backend widens WHICH roster obligation a super-admin may discharge; it does not
 * skip the roster. So a super-admin still gets a refusal on a row whose roster is
 * EMPTY, and this predicate must not promise otherwise — hence the roster-length
 * check, not a bare `hasSuperAdmin`. A button that renders enabled and then 422s is
 * worse than one that explains itself.
 */
export function canActOnApproval(
  a: Pick<Approval, 'required_approvers' | 'decisions'> & { tenant_id?: string | null },
  user: ApproverIdentity | null | undefined,
): boolean {
  if (!user) return false;
  const rostered = isRequiredApprover(a, user);
  const superAdminMayDischarge =
    hasSuperAdmin(user) && (a.required_approvers ?? []).length > 0;
  // P1-TEAM-b: 1-of-any tenant member (backend `tenantMemberArmPrecondition`).
  const tenantMemberMayDischarge = tenantMemberArmApplies(a, user);
  if (!rostered && !superAdminMayDischarge && !tenantMemberMayDischarge) return false;
  return !(a.decisions ?? []).some((d) => d.approver_id === user.id);
}
