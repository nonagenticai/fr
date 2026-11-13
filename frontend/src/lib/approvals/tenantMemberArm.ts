// src/lib/approvals/tenantMemberArm.ts
//
// fr-agui P1-TEAM-b — the decide-rule term the UI must mirror from the backend,
// as a PURE function with NO `$lib` imports so the backend's parity test
// (`backend/tests/unit/lib/tenant-member-arm-parity.test.ts`) can load this file
// directly and pin it equal to `backend/src/domain/engagement/decision-guards.ts`.
//
// ⭐ George 2026-10-15: "all actions are able to be done by all members of the tenant,
// all notifications/approvals/questions are sent to all members". Deciding is
// 1-of-ANY tenant member: a member who is not on the roster may discharge ONE open
// obligation (the backend's `tenantMemberArmPrecondition` + a fail-closed membership
// read). ⛔ These change TOGETHER with the backend — see the header of `canAct.ts`.

export interface ArmApproval {
  required_approvers?: ReadonlyArray<{ user_id?: string | null; role?: string | null }> | null;
  /** On the wire (`approvals.tenant_id`, unprojected select), not declared on `Approval`. */
  tenant_id?: string | null;
}

export interface ArmUser {
  id: string;
  roles?: string[];
  /** The ACTIVE workspace (`auth.user.tenant_id`) — the backend's `ctxTenantId`. */
  tenant_id?: string | null;
}

function rosteredByIdOrRole(a: ArmApproval, user: ArmUser): boolean {
  const roles = user.roles ?? [];
  return (a.required_approvers ?? []).some(
    (r) => r.user_id === user.id || (!!r.role && roles.includes(r.role)),
  );
}

/**
 * The frontend half of `tenantMemberArmPrecondition`: not rostered, non-empty roster, and the row's tenant IS the caller's active workspace.
 *
 * ⚠️ The ACTIVE WORKSPACE stands in for the backend's membership read. That is exact for
 * every caller the web can produce: `X-Active-Tenant` is accepted only for a super-admin
 * switching into a PLATFORM tenant (where the super-admin arm already admits them) or the
 * caller's own home tenant — and a caller's home tenant is a tenant they are a member of
 * (Keycloak `tenant_id`). If the backend's fail-closed read cannot confirm it (Keycloak
 * outage), the PUT refuses with a "could not be verified — try again" 422 — the button
 * was not a lie, the check was unavailable.
 */
export function tenantMemberArmApplies(a: ArmApproval, user: ArmUser | null | undefined): boolean {
  if (!user) return false;
  // P1-TEAM-c (George 2026-10-15): an ACTION approval is open to every member too — the
  // backend runs the approved action AS THE APPROVER, never as the requester.
  const roster = a.required_approvers ?? [];
  if (roster.length === 0) return false;
  if (rosteredByIdOrRole(a, user)) return false;
  return (
    typeof a.tenant_id === 'string' &&
    a.tenant_id.length > 0 &&
    typeof user.tenant_id === 'string' &&
    a.tenant_id === user.tenant_id
  );
}
