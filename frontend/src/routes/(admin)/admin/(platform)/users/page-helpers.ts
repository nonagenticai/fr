// src/routes/(admin)/admin/(platform)/users/page-helpers.ts
//
// Pure view-state derivation for the super-admin provision result panel, split
// out of `+page.svelte` so the honesty rules are unit-testable rather than
// buried in template branches.
//
// Why this exists: since fr was repointed onto the provisioning engine
// (FULL-UNIFY Phase 2b), `temporary_password` is legitimately `null` on two
// paths — an already-existing account (whose password is deliberately NOT
// rotated) and an idempotent replay (which yields no one-time secrets at all).
// The page must explain WHICH of those happened and what the recovery path is.
// Rendering an empty credential box instead reads as "here is the password" and
// is a lie; so does inventing a placeholder token for a license whose one-time
// token we never saw.
//
// The `''` guard below is deliberate defence-in-depth: even if some upstream
// regressed to sending an empty string, this must still resolve to "no
// password", never to a credential.
//
// The second half of this file serves AccessList.svelte's grant/revoke actions,
// for the same reason: a `window.confirm` string assembled inside a template is
// never tested, and this one has to be TRUE.

import type {
  AdminUser,
  AdminUserWorkspace,
  GrantUserRoleResult,
  WorkspaceRoleName,
} from '$lib/api/super-admin';
import type { AppRecord, PlanRecord, TenantRecord } from '$lib/api/licenses-admin';
import type { ComboOption } from '$lib/components/ui';
// Reused, not re-implemented. `planOptions` already composes `selectablePlans`
// (revoked plans are not offerable) and `planLabel` (null ≠ 0 — `null` renders
// as "perpetual"/omitted, never as a zero limit). A second copy of either
// judgement here would be a second thing to drift.
import { planOptions } from '../licenses/page-helpers';
// This file used to own `shortUserId` (`userId.slice(0, 8)`), one of 26 private
// copies of that derivation. Retired in fr#1205: the LEADING 8 is not an
// identity for UUIDv7-shaped ids (fr#1203 measured 52 live apps collapsing onto
// 27 distinct prefixes, 13 of them all rendering `06954722…`), so the shared
// helper takes the TAIL. `unresolvedLabel` below therefore now reads
// "Deleted account · …7e9f1b33" where it read "Deleted account · 3f6a1c22".
import { shortId } from '$lib/utils/shortId';

export interface ProvisionResultView {
  temporary_password: string | null;
  already_existed: boolean;
  replayed?: boolean;
  magic_link_sent?: boolean;
  tokens?: Record<string, string>;
  license_ids?: Record<string, string>;
}

export type CredentialState =
  | { kind: 'password'; password: string }
  | { kind: 'none'; reason: string; recovery: string };

/**
 * What to render in the "Temporary password" box. `kind: 'none'` carries the
 * real reason and the real recovery path — never an empty credential.
 */
export function credentialState(result: ProvisionResultView): CredentialState {
  const pw = result.temporary_password;
  // Truthiness, not `!= null`: an empty string is not a password.
  if (pw) return { kind: 'password', password: pw };

  const reason = result.replayed
    ? 'No password to show. This run was replayed — the temporary password was issued on the original provision and is not re-fetchable.'
    : 'No password was set. This account already existed, so its password was deliberately not rotated — resetting it would lock the person out of a credential they are already using.';

  const recovery = result.magic_link_sent
    ? 'A Keycloak set-your-password link has been emailed to them; that is the recovery path.'
    : 'Send them a password-reset from Keycloak if they need access.';

  return { kind: 'none', reason, recovery };
}

/**
 * The explanation to show when there are no license tokens to display, or
 * `null` when there are tokens (so the caller renders them instead).
 *
 * A license WITHOUT a token is the normal replay outcome: the license exists and
 * its id is known, but the raw token was shown once and cannot be re-read.
 */
export function noTokensMessage(result: ProvisionResultView): string | null {
  const tokenCount = Object.keys(result.tokens ?? {}).length;
  if (tokenCount > 0) return null;

  const licenseCount = Object.keys(result.license_ids ?? {}).length;
  if (licenseCount === 0) {
    return 'No licenses were minted for this user. Grant one from Licensing if that was not intended.';
  }
  const plural = licenseCount === 1 ? 'license' : 'licenses';
  return `No tokens to show. The ${plural} below already existed, so no new token was minted — the original tokens were shown once and cannot be re-read. Re-issue from Licensing if they were lost (that invalidates the previous one).`;
}

// ---------------------------------------------------------------------------
// Access list — grant / revoke derivations.
// ---------------------------------------------------------------------------

/** The exact roles `POST/DELETE /api/admin/users/:id/roles` accepts. */
export const WORKSPACE_ROLES: readonly WorkspaceRoleName[] = [
  'workspace-admin',
  'workspace-member',
];

/** `<Select options>` for the role picker, so the two lists cannot diverge. */
export const roleOptions: { value: WorkspaceRoleName; label: string }[] =
  WORKSPACE_ROLES.map((r) => ({ value: r, label: r }));

/**
 * Narrow a stored `role` string to what the API accepts, or `null`.
 *
 * `AdminUserWorkspace.role` is a plain string: it is whatever sits in
 * `user_roles`, which predates this endpoint's two-value enum. Casting a
 * legacy value straight into the request would spend a round trip to earn a
 * 422 the operator cannot act on; `null` lets the caller refuse locally and
 * name the offending value.
 */
export function asWorkspaceRole(role: string): WorkspaceRoleName | null {
  return (WORKSPACE_ROLES as readonly string[]).includes(role)
    ? (role as WorkspaceRoleName)
    : null;
}

// ---------------------------------------------------------------------------
// Naming a grant whose subject the directory cannot resolve.
//
// 10 of the 14 live grants point at a Keycloak id that 404s. The old label
// fallback ended at `user_id`, so those rows printed a bare UUID exactly where
// a person's name goes — which reads as a mystery to be investigated rather
// than as the stale row it is, and puts a 36-character id in front of an
// operator who asked "who has access?".
// ---------------------------------------------------------------------------

/**
 * The AUTH_BYPASS synthetic user id (`backend/src/middleware/auth.ts`).
 *
 * One live grant carries it: a demo seeder wrote a row for the dev placeholder
 * and it reached production. It is NOT a deleted person — calling it one sends
 * an operator hunting through Keycloak for an account that never existed.
 */
export const SEED_USER_ID = '00000000-0000-0000-0000-000000000000';

/** True for the AUTH_BYPASS placeholder id — dev data, not a former person. */
export function isSeedArtifact(userId: string): boolean {
  return userId === SEED_USER_ID;
}

/**
 * The name an UNRESOLVED grant renders under. Never a full id.
 *
 * Says what the row IS rather than what it is not, and carries the short id so
 * the operator can still act on it.
 */
export function unresolvedLabel(userId: string): string {
  return isSeedArtifact(userId)
    ? 'Seed artifact (dev placeholder)'
    : `Deleted account · ${shortId(userId)}`;
}

/** The badge beside an unresolved row — names the kind, not the absence. */
export function unresolvedBadge(userId: string): string {
  return isSeedArtifact(userId) ? 'seed data' : 'account deleted';
}

/**
 * How the access list names a person: the same order the rows render in.
 *
 * `resolved === false` is checked explicitly, not for truthiness: a caller that
 * does not carry the flag is not making a claim that the directory failed, so
 * it keeps the plain fallback.
 */
export function personLabel(
  user: Pick<AdminUser, 'user_id' | 'email' | 'name'> &
    Partial<Pick<AdminUser, 'resolved'>>,
): string {
  if (user.resolved === false) {
    // A stored email/name is still the better handle if one somehow survives;
    // only the id fallback is replaced, because only it leaks a raw UUID.
    return user.email ?? user.name ?? unresolvedLabel(user.user_id);
  }
  return user.email ?? user.name ?? user.user_id;
}

/** A tenant with no resolved name still has to be identifiable — show the id. */
export function workspaceLabel(
  workspace: Pick<AdminUserWorkspace, 'tenant_id' | 'tenant_name'>,
): string {
  return workspace.tenant_name ?? workspace.tenant_id;
}

/** Client-side filter over email / name / user id / any granted tenant name. */
export function filterAdminUsers(users: AdminUser[], query: string): AdminUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return users;
  return users.filter(
    (u) =>
      (u.email ?? '').toLowerCase().includes(q) ||
      (u.name ?? '').toLowerCase().includes(q) ||
      u.user_id.toLowerCase().includes(q) ||
      u.workspaces.some((w) => (w.tenant_name ?? '').toLowerCase().includes(q)),
  );
}

/** Grants whose user the directory could not resolve. */
export function danglingCount(users: AdminUser[]): number {
  return users.filter((u) => !u.resolved).length;
}

/** Of those, the ones that are the AUTH_BYPASS placeholder rather than a person. */
export function seedArtifactCount(users: AdminUser[]): number {
  return users.filter((u) => isSeedArtifact(u.user_id)).length;
}


/**
 * Does this person already hold this exact (tenant, role) pair?
 *
 * Lets the Grant button say "they already have it" before spending a request
 * that would come back 200 and change nothing.
 */
export function holdsGrant(
  user: Pick<AdminUser, 'workspaces'>,
  tenantId: string,
  role: string,
): boolean {
  return user.workspaces.some((w) => w.tenant_id === tenantId && w.role === role);
}

/**
 * The confirm copy for revoking one grant, built from that person's real grant
 * set.
 *
 * The consequence clause is the part worth testing. Two ways to get it wrong:
 *  - "they lose access to that workspace" is FALSE when they hold a second role
 *    row in the SAME tenant — removing one leaves the other standing.
 *  - "this is their only grant" is FALSE whenever they hold one elsewhere, and
 *    an operator who believes it revokes expecting a no-op and cuts live access.
 */
export function describeRoleRevoke(
  user: Pick<AdminUser, 'user_id' | 'email' | 'name' | 'resolved' | 'workspaces'>,
  workspace: Pick<AdminUserWorkspace, 'tenant_id' | 'tenant_name' | 'role'>,
): string {
  const who = personLabel(user);
  const where = workspaceLabel(workspace);

  // Compare on the pair, not on tenant alone: (tenant, role) is what the
  // DELETE addresses, so that is the row this sentence is about.
  const others = user.workspaces.filter(
    (w) => !(w.tenant_id === workspace.tenant_id && w.role === workspace.role),
  );
  const sameTenant = others.filter((w) => w.tenant_id === workspace.tenant_id);

  let consequence: string;
  if (sameTenant.length > 0) {
    consequence = `They keep ${sameTenant.map((w) => w.role).join(' and ')} in that workspace, so they do not lose access to it.`;
  } else if (others.length === 0) {
    if (user.resolved) {
      consequence = 'It is their only grant, so they will have no access to fr at all.';
    } else if (isSeedArtifact(user.user_id)) {
      // "an account the directory does not know" is FALSE here: there is no
      // account and never was. An operator told otherwise hesitates over a row
      // that costs nothing to remove.
      consequence = `It is the only grant for the AUTH_BYPASS placeholder id (${user.user_id}) — no person loses access; this clears seed data.`;
    } else {
      consequence =
        'It is the only grant for an account the directory does not know — this clears a dangling grant.';
    }
  } else {
    consequence = `They lose access to that workspace and keep ${others.length} other grant${others.length === 1 ? '' : 's'}.`;
  }

  return `Revoke ${workspace.role} from ${who} in “${where}”? ${consequence} This takes effect immediately.`;
}

/**
 * What to tell the operator after a grant.
 *
 * A 200 is a success status for a call that wrote nothing. Reporting it as
 * "Granted" would have the operator believe they just changed something.
 */
export function describeGrantOutcome(
  result: Pick<GrantUserRoleResult, 'created' | 'role' | 'tenant_lookup_error'>,
  who: string,
  where: string,
): string {
  const outcome = result.created
    ? `Granted ${result.role} to ${who} in “${where}”.`
    : `${who} already had ${result.role} in “${where}” — nothing changed.`;
  // The grant SUCCEEDED; only the tenant's display name is missing. Say both,
  // in that order. Silence here leaves a nameless workspace in the list and
  // invites the reading that the grant half-failed; leading with the failure
  // would invite the opposite, that access was not granted.
  return result.tenant_lookup_error
    ? `${outcome} The tenant name could not be read from the licences catalogue (${result.tenant_lookup_error}), so it may show as blank until you reload.`
    : outcome;
}

/**
 * What to tell the operator after a revoke. A 404 means nothing was removed;
 * the backend's own sentence explains whether the grant was already gone or
 * the user id was unknown.
 */
export function describeRevokeOutcome(
  result: { removed: boolean; detail: string },
  who: string,
  where: string,
  role: string,
): string {
  if (result.removed) return `Revoked ${role} from ${who} in “${where}”.`;
  const because = result.detail ? ` (${result.detail})` : '';
  return `Nothing was revoked — the backend found no ${role} grant for ${who} in “${where}”${because}. Reload to see the current state.`;
}

// ===========================================================================
// Per-app plan selection — the app → plan cascade.
//
// The provisioning form picks apps by KEY (`selectedApps: string[]`, which is
// what `ProvisionUserInput.apps` carries and what the backend validates against
// the live catalogue). Plans, however, are addressed by app ID: both
// `GET /apps/:appId/plans` and `POST /plans` take the uuid. So every helper
// below has to cross that boundary explicitly — `appByKey` is the only place it
// happens, rather than each call site doing its own `.find()`.
//
// Leaving a plan UNSET is legal and is the default: the backend then keeps
// today's behaviour (mint on that app's first live plan). That is why the empty
// picker label says so instead of "Select a plan…", which would read as a
// required field.
// ===========================================================================

/**
 * Resolve a catalogue app by the key the provisioning form selects on.
 *
 * `null` rather than a throw: `selectedApps` can legitimately hold a key the
 * current catalogue read does not contain (the catalogue fetch failed and the
 * form fell back to `DEFAULT_APP_KEY`, or an app was revoked between loads).
 * A picker that cannot resolve its app must degrade to "no plan chosen", not
 * crash the form.
 */
export function appByKey(apps: AppRecord[], key: string): AppRecord | null {
  return apps.find((a) => a.key === key) ?? null;
}

/**
 * The load state of ONE app's plan list.
 *
 * Modelled on `offeringsReadback` in the licences sibling, and for the same
 * reason: **a failed read is not an empty list.** `[]` legitimately means "this
 * app has no live plan" — which is a real and serious answer, because
 * provisioning is not transactional and will abort partway through on such an
 * app (measured 2026-08-26: a run died 10.8s in and left five minted licences
 * orphaned). An errored read means we do not know. Rendering the two the same
 * way tells the operator "no plans" on no evidence.
 *
 * `empty` is deliberately NOT a fourth variant: whether a loaded list is empty
 * is decided by `selectablePlans` inside `planOptions`, and re-deciding it here
 * would be a second filter to drift from it.
 */
export type AppPlansLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; plans: PlanRecord[] };

/**
 * Options for one app's plan picker. Empty for every state but `ready`.
 *
 * An errored read yields `[]` rather than whatever was loaded last: a picker
 * offering a stale list after a failed refresh lets the operator select a plan
 * that may no longer exist, and the failure is reported separately.
 */
export function planPickerOptions(load: AppPlansLoad): ComboOption[] {
  return load.kind === 'ready' ? planOptions(load.plans) : [];
}

/**
 * The closed-box label for one app's plan picker.
 *
 * The `ready` wording is the load-bearing part. "Select a plan…" would be a
 * lie: the field is OPTIONAL, and unset means the backend applies its existing
 * default. And the zero-plan case must not repeat that reassurance — there is
 * no first live plan to fall back to, so provisioning that app WILL fail, and
 * saying "the default applies" would send the operator to submit a run that
 * cannot succeed.
 */
export function planPickerEmptyLabel(load: AppPlansLoad): string {
  switch (load.kind) {
    case 'idle':
      return 'Plans not loaded yet';
    case 'loading':
      return 'Loading plans…';
    case 'error':
      return `Could not load plans (${load.message}) — leave unset to keep the default`;
    case 'ready':
      return planOptions(load.plans).length === 0
        ? 'No live plan for this app — provisioning it will FAIL. Create one below.'
        : 'Default plan (backend picks the first live plan)';
  }
}

/** app key → chosen plan id. Absent key, or `''`, both mean "use the default". */
export type PlanChoices = Record<string, string>;

/**
 * Drop plan choices for apps that are no longer ticked.
 *
 * Called on every app toggle so the form state cannot accumulate a choice for
 * an app the operator has since removed.
 */
export function prunePlanChoices(
  selectedApps: readonly string[],
  choices: PlanChoices,
): PlanChoices {
  const keep = new Set(selectedApps);
  return Object.fromEntries(
    Object.entries(choices).filter(([key, planId]) => keep.has(key) && planId),
  );
}

/**
 * App keys carrying a plan choice that no longer has a ticked app — the invalid
 * state, surfaced rather than cleaned up silently.
 *
 * `prunePlanChoices` makes this unreachable through the UI, which is exactly
 * why it is still checked: the prune is the fix, this is the detector, and a
 * detector that can only ever read zero is how a regression in the prune ships
 * unnoticed. The alternative — letting `appPlansPayload` quietly drop the
 * entry — would send a request that provisions a DIFFERENT plan from the one
 * the operator last saw selected, with no error anywhere.
 */
export function planChoicesForUnselectedApps(
  selectedApps: readonly string[],
  choices: PlanChoices,
): string[] {
  const selected = new Set(selectedApps);
  return Object.entries(choices)
    .filter(([key, planId]) => planId && !selected.has(key))
    .map(([key]) => key)
    .sort();
}

/**
 * The `app_plans` field of the request body, or `undefined` to OMIT it.
 *
 * `undefined`, never `{}`: an empty object is a present field, and "I am
 * sending you an explicit, empty plan map" is a different statement from "I am
 * not choosing plans, keep your existing behaviour". The backend treats the
 * field as optional precisely so the second statement stays expressible.
 */
export function appPlansPayload(
  selectedApps: readonly string[],
  choices: PlanChoices,
): PlanChoices | undefined {
  const payload = prunePlanChoices(selectedApps, choices);
  return Object.keys(payload).length > 0 ? payload : undefined;
}

// ===========================================================================
// "Create custom plan" — POST /api/admin/licenses/plans.
//
// Shape verified against `CreatePlanBody` in
// backend/src/routes/admin/licenses-admin.ts: `app_id` (uuid) + `code` + `name`
// are required, every limit is `int().nonnegative().nullable().optional()` and
// `duration_days` is `int().positive().nullable().optional()`. The schema is
// `.strict()`, so an extra key is a 422 — which is why this builds the body
// explicitly instead of spreading a form object.
// ===========================================================================

/** Raw form fields. Strings, because `''` has to stay distinguishable from 0. */
export interface CustomPlanDraft {
  code: string;
  name: string;
  quota_monthly: string;
  token_budget_monthly: string;
  rate_limit_rpm: string;
  rate_limit_burst: string;
  duration_days: string;
}

export const emptyCustomPlanDraft = (): CustomPlanDraft => ({
  code: '',
  name: '',
  quota_monthly: '',
  token_budget_monthly: '',
  rate_limit_rpm: '',
  rate_limit_burst: '',
  duration_days: '',
});

export interface CustomPlanBody {
  app_id: string;
  code: string;
  name: string;
  quota_monthly: number | null;
  token_budget_monthly: number | null;
  rate_limit_rpm: number | null;
  rate_limit_burst: number | null;
  duration_days: number | null;
}

export type CustomPlanRequest =
  | { ok: true; body: CustomPlanBody }
  | { ok: false; problem: string };

/**
 * `''` → `null` (unlimited / perpetual upstream), never 0.
 *
 * This is the whole reason the draft holds strings. `Number('') === 0`, and a
 * plan created with `quota_monthly: 0` is not an unlimited plan — it is a plan
 * that denies every request. The same confusion is already called out in
 * `planLabel` on the licences side, which refuses to render `null` as "0".
 */
function numOrNull(s: string): number | null {
  const t = s.trim();
  return t === '' ? null : Number(t);
}

/**
 * Validate a draft and build the exact `POST /plans` body, or name the problem.
 *
 * Checked locally only where the answer is knowable locally and the round trip
 * would otherwise return a zod issue the operator cannot act on. Uniqueness of
 * `code` within the app is NOT checked here — only the licences service knows
 * that, and guessing it would either block a legal code or promise one that is
 * taken.
 */
export function customPlanRequest(
  appId: string | null,
  draft: CustomPlanDraft,
): CustomPlanRequest {
  if (!appId) {
    return { ok: false, problem: 'Pick the app this plan belongs to first.' };
  }
  const code = draft.code.trim();
  const name = draft.name.trim();
  if (!code) return { ok: false, problem: 'A plan needs a code.' };
  if (code.length > 64) return { ok: false, problem: 'Plan code is limited to 64 characters.' };
  if (!name) return { ok: false, problem: 'A plan needs a name.' };

  const limits = {
    quota_monthly: numOrNull(draft.quota_monthly),
    token_budget_monthly: numOrNull(draft.token_budget_monthly),
    rate_limit_rpm: numOrNull(draft.rate_limit_rpm),
    rate_limit_burst: numOrNull(draft.rate_limit_burst),
    duration_days: numOrNull(draft.duration_days),
  };

  for (const [field, value] of Object.entries(limits)) {
    if (value === null) continue;
    if (!Number.isInteger(value)) {
      return { ok: false, problem: `${field} must be a whole number.` };
    }
    // `duration_days` is `.positive()` upstream; the rest are `.nonnegative()`.
    if (field === 'duration_days' && value < 1) {
      return {
        ok: false,
        problem:
          'duration_days must be at least 1 — leave it blank for a perpetual plan.',
      };
    }
    if (field !== 'duration_days' && value < 0) {
      return {
        ok: false,
        problem: `${field} cannot be negative — leave it blank for unlimited.`,
      };
    }
  }

  return { ok: true, body: { app_id: appId, code, name, ...limits } };
}

// ===========================================================================
// Additional seats.
//
// ⛔ THERE IS DELIBERATELY NO SEAT-COUNT NUMBER INPUT, and one must never be
// added. A seat IS a licence row held by a named person: the thing that exists
// downstream is `(subject_id, tenant_id, app_id, plan_id)`, and billing's live
// seat count is derived by counting those rows. A "number of seats: 5" field
// would be a SECOND source of truth for that count, stored nowhere, reconciled
// by nothing, and free to disagree with the rows actually minted — an operator
// who typed 5 and got 3 rows (two failures) would still read "5 seats" from the
// form while billing charges for 3. Asking for the people instead makes the
// count a consequence of the data rather than a claim beside it, and it is also
// the only shape that can report PER-SEAT outcomes, which is what
// `seats: [{email, status, error?}]` comes back as.
// ===========================================================================

/**
 * Upper bound on `additional_seats` in ONE request.
 *
 * ⚠️ Keep in sync with `MAX_ADDITIONAL_SEATS` in
 * backend/src/routes/admin/super-admin.ts, which is the ENFORCING copy (a zod
 * `.max()` — over it is a 422). Same arrangement, and same reason, as
 * `TEST_APP_KEY_RE` in the licences page-helpers: a local mirror so the form can
 * refuse before spending a request, never the authority.
 *
 * Declared here rather than imported from the API client on purpose: this module
 * is type-imports-only so `vitest --environment node` can load it without
 * pulling `authFetch` and keycloak-js into the graph.
 */
export const MAX_ADDITIONAL_SEATS = 25;

/** One operator-entered seat. Both fields are required — see `validateSeatRows`. */
export interface SeatDraft {
  email: string;
  name: string;
}

export const emptySeatDraft = (): SeatDraft => ({ email: '', name: '' });

export type SeatRowProblem =
  | 'blank'
  | 'invalid_email'
  | 'missing_name'
  | 'missing_email'
  | 'duplicate_email'
  | 'same_as_primary';

/**
 * A conservative local email check. The backend's `z.string().email()` is the
 * AUTHORITY — this exists only so an obvious typo costs a keystroke instead of
 * a failed provisioning run, and it is deliberately permissive: rejecting a
 * valid-but-unusual address locally would make it unprovisionable from the UI,
 * which is worse than a 422.
 */
export const SEAT_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function looksLikeEmail(value: string): boolean {
  return SEAT_EMAIL_RE.test(value.trim());
}

/**
 * One problem per row, positionally aligned with `seats`, or `null` when clean.
 *
 * Why a blank row is an ERROR and not silently skipped: "Add another person"
 * creates the row, so a blank one is a person the operator started adding.
 * Dropping it quietly provisions fewer seats than they believe they asked for,
 * and the result panel would look complete. They can remove the row instead.
 *
 * `primaryEmail` is compared case-insensitively against the main form's email:
 * the primary account is already being provisioned by this same call, so
 * repeating it as a seat is not "two seats", it is one seat the backend would
 * either replay or collide on — and either way the operator's intent (a second
 * person) is not what happens.
 */
export function validateSeatRows(
  seats: readonly SeatDraft[],
  primaryEmail: string,
): (SeatRowProblem | null)[] {
  const primary = primaryEmail.trim().toLowerCase();
  const seen = new Map<string, number>();
  seats.forEach((s, i) => {
    const key = s.email.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, i);
  });

  return seats.map((seat, index) => {
    const email = seat.email.trim();
    const name = seat.name.trim();
    if (!email && !name) return 'blank';
    if (!email) return 'missing_email';
    if (!looksLikeEmail(email)) return 'invalid_email';
    const key = email.toLowerCase();
    if (primary && key === primary) return 'same_as_primary';
    // Only the LATER row is flagged: the first occurrence is the one that will
    // be provisioned, so blaming both rows would tell the operator to fix a row
    // that is correct.
    if (seen.get(key) !== index) return 'duplicate_email';
    if (!name) return 'missing_name';
    return null;
  });
}

/** The message shown under an offending seat row. */
export function seatProblemMessage(problem: SeatRowProblem): string {
  switch (problem) {
    case 'blank':
      return 'Empty row — fill it in or remove it, so the seats provisioned match what you see here.';
    case 'missing_email':
      return 'An email is required: it is the identity the licence binds to.';
    case 'invalid_email':
      return 'That does not look like an email address.';
    case 'missing_name':
      return 'A name is required — the Keycloak account is created with it.';
    case 'duplicate_email':
      return 'Already listed above. One seat per person; a repeat would replay, not add.';
    case 'same_as_primary':
      return 'This is the person in the form above, who is already being provisioned by this call.';
  }
}

/** True while any row is unusable — the submit button stays disabled. */
export function seatsBlockSubmit(problems: readonly (SeatRowProblem | null)[]): boolean {
  return problems.some((p) => p !== null);
}

/**
 * The over-the-cap message, or `null` while the list fits.
 *
 * The ENFORCING copy of the limit is `MAX_ADDITIONAL_SEATS` in
 * backend/src/routes/admin/super-admin.ts (a zod `.max()` — over it is a 422).
 * This refuses locally first so the operator learns it before, not after, typing
 * 26 people's names into a form that was always going to be rejected.
 */
export function seatCountProblem(
  seats: readonly SeatDraft[],
  max: number = MAX_ADDITIONAL_SEATS,
): string | null {
  return seats.length > max
    ? `${seats.length} additional people — the backend accepts at most ${max} per request. Remove ${seats.length - max}, or provision the rest in a second run.`
    : null;
}

/**
 * The `additional_seats` field of the request body, or `undefined` to OMIT it.
 *
 * `undefined` rather than `[]` for the same reason as `appPlansPayload`: an
 * empty array is an explicit "provision no extra seats", and a request that
 * omits the field is the pre-existing single-seat call this page has always
 * made. Keeping them distinct is what lets the backend leave today's behaviour
 * untouched for the default path.
 *
 * Trims, and does NOT validate — call `validateSeatRows` first and refuse to
 * submit. Returning a payload built from rows that failed validation would make
 * the validation decorative.
 */
export function additionalSeatsPayload(
  seats: readonly SeatDraft[],
): SeatDraft[] | undefined {
  const rows = seats
    .map((s) => ({ email: s.email.trim(), name: s.name.trim() }))
    .filter((s) => s.email !== '' || s.name !== '');
  return rows.length > 0 ? rows : undefined;
}

// ===========================================================================
// Per-seat results — honest rendering of `seats: [{email, status, error?}]`.
//
// The credential rules are NOT re-decided here. `credentialState` and
// `noTokensMessage` above already encode them for the primary account, and the
// trap is identical per seat: a `replayed` seat carries no one-time secret, so
// an empty credential box beside it reads as "here is the password" and is a
// lie. These helpers MAP a seat onto `ProvisionResultView` and delegate, so a
// later change to the rule reaches both paths.
// ===========================================================================

export type SeatStatus = 'provisioned' | 'replayed' | 'failed';

export interface SeatResultView {
  email: string;
  status: SeatStatus;
  /** Present on `failed`. The backend's own sentence, never paraphrased. */
  error?: string;
  /** Same contract as the primary: `null` on an existing account or a replay. */
  temporary_password?: string | null;
  magic_link_sent?: boolean;
  /**
   * Reported per seat by the backend. Read, not derived: a `provisioned` seat
   * can ALSO have existed already (the run completed, but the password was not
   * rotated), so inferring it from `status === 'replayed'` would be wrong for
   * exactly that case.
   */
  already_existed?: boolean;
  tokens?: Record<string, string>;
  license_ids?: Record<string, string>;
}

/** Pill tone per seat status — `failed` must never read as healthy. */
export function seatStatusTone(
  status: SeatStatus,
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'provisioned':
      return 'success';
    case 'replayed':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * The one-line outcome for a seat. Each status says what it actually did.
 *
 * `replayed` is the one worth getting right: it is a SUCCESS status for a call
 * that created nothing, so "Provisioned" would have the operator believe a new
 * account and a new token exist. It is also why no credential renders for it.
 */
export function seatStatusHeadline(seat: SeatResultView): string {
  switch (seat.status) {
    case 'provisioned':
      return `${seat.email} — provisioned`;
    case 'replayed':
      return `${seat.email} — already provisioned, replayed; nothing new was created`;
    case 'failed':
      return seat.error
        ? `${seat.email} — FAILED: ${seat.error}`
        : `${seat.email} — FAILED, and the backend gave no reason. Re-run to see whether it succeeds.`;
  }
}

/**
 * What to render in this seat's credential slot, or `null` to render NOTHING.
 *
 * `null` for a `failed` seat is the point: `credentialState` would otherwise
 * answer "no password was set, this account already existed, send them a
 * password reset" — a sentence that asserts an account EXISTS, about a seat
 * that was never created. Nothing at all is the honest output there; the
 * failure reason is the whole message.
 *
 * Everything else delegates, so the `''`-is-not-a-password guard and the
 * replay/already-existed split are the same code the primary panel uses.
 */
export function seatCredentialState(seat: SeatResultView): CredentialState | null {
  if (seat.status === 'failed') return null;
  return credentialState({
    temporary_password: seat.temporary_password ?? null,
    // The backend's own field when it sent one. Falling back to the replay
    // inference only covers a deployment that predates it.
    already_existed: seat.already_existed ?? seat.status === 'replayed',
    replayed: seat.status === 'replayed',
    magic_link_sent: seat.magic_link_sent,
    tokens: seat.tokens,
    license_ids: seat.license_ids,
  });
}

/**
 * The "no tokens" explanation for a seat, or `null` when there are tokens to
 * render instead — and `null` for a failed seat, which has no licence to
 * explain the absence of a token for.
 */
export function seatTokensMessage(seat: SeatResultView): string | null {
  if (seat.status === 'failed') return null;
  return noTokensMessage({
    temporary_password: seat.temporary_password ?? null,
    already_existed: seat.already_existed ?? seat.status === 'replayed',
    replayed: seat.status === 'replayed',
    tokens: seat.tokens,
    license_ids: seat.license_ids,
  });
}

export interface SeatTally {
  total: number;
  provisioned: number;
  replayed: number;
  failed: number;
}

export function tallySeats(seats: readonly SeatResultView[]): SeatTally {
  return {
    total: seats.length,
    provisioned: seats.filter((s) => s.status === 'provisioned').length,
    replayed: seats.filter((s) => s.status === 'replayed').length,
    failed: seats.filter((s) => s.status === 'failed').length,
  };
}

/**
 * The summary line above the seat list.
 *
 * Counts every status separately and NEVER reports a total as a success count.
 * "5 seats provisioned" over a run where two failed is the exact lie a
 * seat-count input would have encouraged (see the block comment above
 * `SeatDraft`): the number the operator asked for, presented as the number that
 * exists. A failure is named first, because it is the only part that needs
 * acting on.
 */
export function describeSeatOutcome(seats: readonly SeatResultView[]): string {
  const t = tallySeats(seats);
  if (t.total === 0) return 'No additional seats were requested.';

  const parts: string[] = [];
  if (t.provisioned > 0) parts.push(`${t.provisioned} provisioned`);
  if (t.replayed > 0) parts.push(`${t.replayed} already existed (replayed, nothing created)`);
  if (t.failed > 0) parts.push(`${t.failed} FAILED`);
  const seatWord = t.total === 1 ? 'seat' : 'seats';

  return t.failed > 0
    ? `${t.failed} of ${t.total} ${seatWord} FAILED — ${parts.join(', ')}. Provisioning is not transactional: the seats that succeeded are real and were NOT rolled back. Fix the reason and re-run; the successful ones will replay.`
    : `${t.total} ${seatWord}: ${parts.join(', ')}.`;
}

// ===========================================================================
// Existing-tenant mode — add a member to a tenant that already exists
// ===========================================================================
//
// The picker is fed by the licences tenant registry as fr sees it. ⚠️ That
// LISTING is owner-scoped: licences returns fr only the tenants fr OWNS, so a
// tenant fr merely holds a grant on (e.g. the platform-owned conveyor service
// tenant) is absent from it even with `include_service_actors`, while a lookup
// BY ID does resolve it. So the picker also accepts a pasted tenant id, resolved
// through `getTenant`, and `mergeTenants` folds that answer into the options.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Live tenants only (an archived tenant is refused 409 by the backend), deduped by id, listed first-seen. */
export function mergeTenants(...lists: TenantRecord[][]): TenantRecord[] {
  const byId = new Map<string, TenantRecord>();
  for (const list of lists) {
    for (const t of list) {
      if (t.archived_at) continue;
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}

/** Picker rows: the name, with kind · owner · id underneath so two same-named tenants stay apart. */
export function existingTenantOptions(tenants: TenantRecord[]): ComboOption[] {
  return mergeTenants(tenants).map((t) => ({
    value: t.id,
    label: t.name,
    sublabel: [t.kind ?? 'unclassified', t.owner_key ? `owner ${t.owner_key}` : null, t.id]
      .filter((x): x is string => x !== null)
      .join(' · '),
  }));
}

// --- fr's per-person apps ---------------------------------------------------
//
// fr provisions only its own platform context (the fr bundle). Per person that
// is exactly `fr` (the key fr's own licence gate requires) + `fr-frontend`.
// Kanban and n8n are shared fr platform accounts, so there is nothing to
// provision per person for them. Mirrors backend `FR_PERSON_APPS`
// (backend/src/lib/fr-issuable-apps.ts), which refuses any other key with 422
// `apps_not_in_fr_bundle`.

/** The only licences fr provisions per person. */
export const FR_PERSON_APPS: readonly string[] = ['fr', 'fr-frontend'];

/** The gate key: always selected, cannot be unticked. */
export const FR_GATE_APP_KEY = 'fr';

/** The default selection for a new provision. */
export function defaultPersonApps(): string[] {
  return [...FR_PERSON_APPS];
}

/** Narrow the grantable catalogue to fr's per-person apps. */
export function frPersonApps<T extends { key: string }>(apps: readonly T[]): T[] {
  return apps.filter((a) => FR_PERSON_APPS.includes(a.key));
}

/** Whether the picker may untick `key` (the gate key never). */
export function canUntickApp(key: string): boolean {
  return key !== FR_GATE_APP_KEY;
}
