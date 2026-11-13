// assetScopeCapability.ts
//
// Three-state capability model for the Library Promote / Override / Block
// controls (`routes/library/[type]/+page.svelte`).
//
// ⛔ WHY THIS IS NOT A SECOND COPY OF THE AUTHZ RULE.
//
// The backend is and stays the security boundary. This module does not decide
// who may promote; it JOINS the answers the backend has already given the
// client, and returns `'unknown'` for every input the client was never told.
// The one value it transcribes is the SET OF ROLE STRINGS the backend accepts
// as workspace-admin — and it transcribes them from the same table and the
// same precedence function the backend gate reads:
//
//   backend/src/services/user-roles.ts:284-296  isWorkspaceAdminVia()
//       → true iff the Keycloak claim `user.roles` contains
//         'workspace-admin' | 'admin', OR `user_roles` holds that row.
//   backend/src/lib/accessible-tenants.ts:146-148  rolePrecedence()
//       → 'workspace-admin' and 'admin' are the SAME tier; that function is
//         what stamps `role` on each row of `GET /api/me/workspaces`, which
//         is what the `workspaces` store holds.
//   backend/src/lib/accessible-tenants.ts:121-125 says it outright:
//       "no synthetic value confers anything: every backend gate reads
//        `user_roles`" — so 'own_workspace' and 'super_admin_scope' are
//        correctly NOT admin here.
//
// ⛔ `isSuperAdmin` alone is DELIBERATELY not a permit arm.
// `routes/asset-scope/promote.ts` gates on `isWorkspaceAdminVia`, which admits
// a super-admin only when SWITCHED into the active workspace (George
// 2026-10-27, `isRealmTenantAdminOf`'s switch arm). `/api/me/workspaces` stamps
// exactly those rows `workspace-admin`, so the row role already carries that
// answer; a super-admin whose active row is not admin is genuinely 403ed by
// these four handlers, and offering them the button would be a lie.
//
// THE THREE STATES ARE NOT TWO.
//   permitted — the backend told us the caller holds a role that is, on its
//               own, sufficient for the handler to proceed.
//   denied    — the backend told us every arm of that handler's predicate is
//               false. Only claimable when the client holds ALL the inputs.
//   unknown   — the client was never sent an input the handler reads. The
//               control may be offered, but must not promise success.
//
// A missing field MUST land in `unknown`. Defaulting it to `permitted` is the
// defect this module replaces (`canPromoteWorkspace = $derived(true)`);
// defaulting it to `denied` is the mirror-image defect — it hides a control
// from a user who is in fact allowed, and looks identical to "you lack the
// role", which is why `departments`' unreadable state next door is tracked
// separately too.

export type Capability = 'permitted' | 'denied' | 'unknown';

/**
 * The two role strings `isWorkspaceAdminVia` accepts, in both the places it
 * looks. `'admin'` is the legacy alias — read-only, never written for new
 * grants (user-roles.ts:294-295), but still honoured, so a client that drops
 * it would under-offer to real admins.
 */
const ADMIN_ROLE_VALUES: readonly string[] = ['workspace-admin', 'admin'];

export interface WorkspaceAdminInputs {
  /** `workspaces.loaded` — false while hydrating AND after a failed load. */
  loaded: boolean;
  /** `workspaces.error` — set on a non-2xx or thrown `/api/me/workspaces`. */
  error: string | undefined;
  /**
   * `workspaces.active?.role` — the role the backend stamped on the ACTIVE
   * workspace row. `undefined` means no active row was resolved, which is not
   * the same fact as "you are a member".
   */
  activeRole: string | undefined;
  /**
   * `auth.user?.roles` — Keycloak realm claims. `undefined` before sign-in
   * resolves. Included because `isWorkspaceAdminVia` checks the claim FIRST
   * and returns true without a DB round trip; omitting this arm would deny a
   * claim-only admin the backend would have let through.
   */
  claimRoles: readonly string[] | undefined;
}

/**
 * Is the caller workspace-admin of the ACTIVE workspace?
 *
 * This is the single fact all four handlers short-circuit on
 * (`promote.ts:155`, `promote.ts:103`, `block.ts:100`, `block.ts:109`, and
 * `override.ts:224` / `:234`), so every capability below starts here.
 */
export function workspaceAdminCapability(i: WorkspaceAdminInputs): Capability {
  // Claim arm first — mirrors the order in isWorkspaceAdminVia, and a present
  // claim is decisive on its own, so it answers even while the list is cold.
  // Guarded with an explicit `!== undefined` rather than `?.`, for the reason
  // the next block spells out: with `?.` an UNREAD claim and a READ-and-negative
  // claim are the same falsy expression, and this function must tell them apart.
  if (
    i.claimRoles !== undefined &&
    i.claimRoles.some((r) => ADMIN_ROLE_VALUES.includes(r))
  ) {
    return 'permitted';
  }
  // ⚠️ 2026-09-23 — found by a validation pass over this module's own header,
  // not by a failing test. This arm USED TO READ `i.claimRoles?.some(...)` with
  // no follow-up, so `claimRoles === undefined` was merely FALSY and fell
  // through. With the DB arm's inputs present (`loaded`, no `error`, a non-admin
  // `activeRole`) the function then returned `denied` having never read one of
  // the two arms the backend ORs together — `isWorkspaceAdminVia`
  // (backend/src/services/user-roles.ts:284-296) checks the Keycloak claim
  // FIRST and returns true with no DB round trip, so a claim-only admin whose
  // claims had not resolved yet was told `denied`. That is exactly the
  // mirror-image defect this file's header (lines 42-47) forbids: a known-false
  // answer derived from an unread input, indistinguishable at the DOM from
  // "you lack the role".
  //
  // ⛔ `[]` IS NOT `undefined` HERE, and collapsing the two is the same bug
  // moved one step along. `auth.user?.roles` is `undefined` only while the user
  // object itself is absent. An empty array is a signed-in user whose realm
  // claims were read and contain no admin role — a genuine measurement, which
  // may and must contribute to a `denied`. Returning `unknown` for `[]` would
  // offer the control permanently to every user with a legitimately empty
  // claims list, i.e. reinstate `$derived(true)` under a new name.
  if (i.claimRoles === undefined) {
    return 'unknown';
  }
  // The DB arm's input has not arrived (or the read failed). `false` here
  // would be a claim we cannot support.
  if (!i.loaded || i.error !== undefined || i.activeRole === undefined) {
    return 'unknown';
  }
  // Both arms present and negative: the only place a real `denied` is earned.
  return ADMIN_ROLE_VALUES.includes(i.activeRole) ? 'permitted' : 'denied';
}

/**
 * The department arm of the three dept-scoped handlers: dept-admin or
 * dept-manager of the target dept (`promote.ts:90-93`
 * via `getMemberRole`, reused by `block.ts:101` / `override.ts:225`).
 *
 * ⚠️ Never returns `denied`. `auth.fetchDeptRoles()` catches a failed
 * `GET /api/me/dept-roles` and assigns `{}` (auth.svelte.ts:398-407), and the
 * endpoint returns `{}` legitimately for a user with zero memberships — so an
 * absent key is genuinely ambiguous at the client. Reporting that ambiguity
 * as `denied` would hide the control from dept-managers whose role read
 * merely failed.
 */
export function deptManagerArm(deptRole: string | undefined): Capability {
  return deptRole === 'dept-manager' || deptRole === 'dept-admin'
    ? 'permitted'
    : 'unknown';
}

/**
 * Join two arms of one OR-ed backend predicate.
 *
 * `permitted` wins (either arm alone is sufficient); `denied` only when BOTH
 * arms are known-false; anything else is `unknown`. This is the whole of the
 * "logic" in this module — it composes answers, it does not author them.
 */
export function anyOf(...arms: readonly Capability[]): Capability {
  if (arms.includes('permitted')) return 'permitted';
  return arms.every((a) => a === 'denied') ? 'denied' : 'unknown';
}
