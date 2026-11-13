// src/lib/api/super-admin.ts
//
// Typed client for the fr backend's super-admin user-provisioning surface.
// Spec 2 — Task 6.
//
// Wire contracts (mirror backend/src/routes/admin/super-admin.ts — keep in sync):
//
//   GET /api/me/super-admin
//     Auth: Bearer JWT (Keycloak access token, via auth-fetch)
//     200 OK → { is_super_admin: boolean }
//     non-2xx → throws Error
//
//   POST /api/admin/super-admin/provision-user
//     Auth: Bearer JWT, MUST be a super-admin (allowlist check on backend)
//     Body: ProvisionUserInput (zod-validated server-side)
//     201 Created → ProvisionUserResult
//     400/422 → invalid body
//     401/403 → not signed in / not super-admin
//
// Auth: every call goes through `authFetch`, which attaches the browser's
// Keycloak access token as a Bearer header. These helpers MUST run client-side
// (after the auth store has been hydrated) — never from a SvelteKit SSR
// `load()` running on the Node side.

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';
import type { InferenceInput, InferenceOutcome } from './inference-admin';

/**
 * The provision-user body. Two modes, exactly one tenant selector each:
 *
 *   * `NewTenantProvisionInput` — `tenant_slug`: the provisioning engine resolves
 *     or mints an fr-owned tenant by slug and mints licences, quota and budget.
 *   * `ExistingTenantProvisionInput` — `tenant_id`: add a human MEMBER to a tenant
 *     that already exists. Mints NO licence, budget or seat (the tenant holds
 *     them); the backend refuses every licensing field in this mode (422).
 */
export type ProvisionUserInput = NewTenantProvisionInput | ExistingTenantProvisionInput;

export interface ExistingTenantProvisionInput {
  email: string;
  name: string;
  /** The existing tenant's id (from the licences tenant registry). */
  tenant_id: string;
  tenant_slug?: never;
  /** Defaults to `member` server-side in this mode. */
  workspace_role: 'admin' | 'member';
  send_password_reset_email: boolean;
}

/** `POST .../provision-user` 201 in existing-tenant mode (backend `ProvisionMemberResult`). */
export interface ProvisionMemberResult {
  mode: 'existing_tenant';
  user_id: string;
  tenant_id: string;
  tenant_name: string;
  /** The account existed AND already belonged to this tenant (any other tenant is refused 409). */
  already_existed: boolean;
  /** Shown ONCE; `null` for an existing account, whose password is never rotated. */
  temporary_password: string | null;
  magic_link_sent: boolean;
  replayed: false;
  workspace_role: 'admin' | 'member';
  realm_role: 'added' | 'already';
  keycloak_sync?: string;
  warnings: string[];
}

export interface NewTenantProvisionInput {
  email: string;
  name: string;
  /** E.164 — e.g. `+14155551234`. Optional; stored on the Keycloak profile. */
  phone_e164?: string;
  /** Lowercase alphanumeric + hyphen, 2-40 chars. */
  tenant_slug: string;
  tenant_id?: never;
  workspace_role: 'admin' | 'member';
  /**
   * App keys to mint a license for, from the licenses catalog
   * (`listApps()` in `./licenses-admin`). Was pinned to `'fr-frontend'` while
   * the backend enum allowed nothing else; the backend now validates against
   * the live catalog and 404s an unknown key.
   */
  apps: string[];
  /**
   * OPTIONAL map of app key → plan id, for the apps in `apps`.
   *
   * OMIT the field (not `{}`) to keep the existing behaviour: the backend then
   * mints each licence on that app's first live plan, exactly as it did before
   * this field existed. `{}` is a present-but-empty choice map, which is a
   * different statement — see `appPlansPayload` in the users page-helpers.
   *
   * A key here that is NOT in `apps` is a request the backend was never asked
   * to licence; the form refuses to submit that rather than dropping it.
   */
  app_plans?: Record<string, string>;
  /**
   * OPTIONAL extra people to provision in the same tenant, in the same call.
   *
   * ⛔ There is deliberately no seat COUNT anywhere in this contract. A seat is
   * a licence row held by a named person, and billing's live seat count is
   * derived by counting those rows — a number beside them would be a second
   * source of truth free to disagree with what was actually minted. It is also
   * the only shape that can carry per-seat outcomes back (see `seats`).
   */
  additional_seats?: { email: string; name: string }[];
  monthly_budget_tokens: number;
  send_password_reset_email: boolean;
  /**
   * OPTIONAL — the owner's per-tenant inference decision (PLAN
   * tenant-inference-provisioning §2.6). Sent ONLY when the Inference section is
   * enabled (FR_INFERENCE_PROVISIONING) and switched on; omitted otherwise, so
   * the request is exactly today's. When present the backend skips the manual
   * token budget (`monthly_budget_tokens` is ignored) and runs provisioning's
   * inference apply once after the seats.
   */
  inference?: InferenceInput;
}

/**
 * The outcome of ONE additional seat.
 *
 * `replayed` is a SUCCESS status for a call that created nothing: that seat's
 * account already existed and its one-time secrets were issued on the original
 * run, so there is no password and no token to show. Rendering an empty
 * credential box beside it is the same lie the primary panel avoids — see
 * `seatCredentialState` in the users page-helpers, which delegates to the same
 * `credentialState` rule rather than re-deciding it.
 *
 * Provisioning is NOT transactional, so a `failed` seat sitting beside
 * `provisioned` ones is a real, expected state: the successful seats exist and
 * were not rolled back.
 */
export interface ProvisionSeatResult {
  email: string;
  status: 'provisioned' | 'replayed' | 'failed';
  /** The backend's own reason, present on `failed`. */
  error?: string;
  /** Per-seat one-time secrets, on the same `null`-is-real contract as above. */
  temporary_password?: string | null;
  magic_link_sent?: boolean;
  tokens?: Record<string, string>;
  license_ids?: Record<string, string>;
  user_id?: string;
  /** True when the Keycloak account already existed — no password was rotated. */
  already_existed?: boolean;
  warnings?: string[];
  partial_failures?: string[];
}

// The `additional_seats` length cap lives with the other form-validation
// constants, in the users route's `page-helpers.ts` (`MAX_ADDITIONAL_SEATS`) —
// that module is type-imports-only, so the node-environment unit tests can load
// it without pulling this client's `authFetch`/keycloak graph in. The ENFORCING
// copy is the zod `.max()` in backend/src/routes/admin/super-admin.ts.

export interface ProvisionUserResult {
  user_id: string;
  tenant_id: string;
  already_existed: boolean;
  /**
   * Plain-text temporary password — surfaced ONCE, or `null`.
   *
   * `null` is a real, expected state since fr was repointed onto the
   * provisioning engine: an ALREADY-EXISTING account's password is deliberately
   * never rotated (rotating it on every operator retry resets a live credential
   * out from under the person), and an idempotent replay returns no one-time
   * secrets at all. Render the reason — never an empty credential box.
   */
  temporary_password: string | null;
  /** Keycloak's non-destructive UPDATE_PASSWORD magic link was sent. */
  magic_link_sent?: boolean;
  /** True when this replayed an earlier run: identity only, no new secrets. */
  replayed?: boolean;
  /** Map of app key (`fr-frontend`) → freshly-minted license token. Empty on a replay. */
  tokens: Record<string, string>;
  /** Map of app key → license id (for future audit / revoke). Optional. */
  license_ids?: Record<string, string>;
  /** `null` when the request carried `inference` (no manual token budget). */
  budget_id: string | null;
  /** Present only when the request carried `inference`. */
  inference?: InferenceOutcome;
  /**
   * The tenant's PM catalogue seeding (RM import-defaults), run once per
   * provision. `failed` is reported, never rolled back; the remedy is the
   * tenant import on the catalogue_not_initialised state.
   */
  catalogue?: { status: 'imported'; result: unknown } | { status: 'failed'; error: string };
  /** provisioning's status: success | succeeded_with_warnings | partial. */
  provisioning_status?: string;
  /** COSMETIC degradations (e.g. the magic-link email failed). */
  warnings?: string[];
  /** MATERIAL degradations (e.g. the billing quota was NOT registered). */
  partial_failures?: string[];
  /**
   * One row per `additional_seats` entry, in request order.
   *
   * The current backend ALWAYS sends this (possibly `[]`), deliberately, so that
   * "no seats" and "the field is missing" stay distinguishable. Typed optional
   * here anyway, for the same reason `license_ids` is: a frontend can be live
   * against a backend that predates the field, and `undefined` must read as
   * "this deployment does not report seats", not crash.
   *
   * ⚠️ A resolved promise says the REQUEST succeeded, not that every seat did.
   * Each row's `status` is the only evidence per seat — never infer success
   * from the array's length, which is the count ASKED FOR.
   */
  seats?: ProvisionSeatResult[];
}

export interface DeprovisionUserInput {
  email: string;
  tenant_slug: string;
  reason?: string;
}

export interface DeprovisionUserResult {
  keycloak_user_deleted: boolean;
  licenses_deleted: number;
  tenant_id: string | null;
  /** Always true — a tenant is a shared registry entity with no DELETE API. */
  tenant_retained: boolean;
  /** True only when a billing quota could NOT be deregistered. */
  billing_quota_retained: boolean;
  /** True when this run had already been reversed; nothing happened now. */
  already_deprovisioned: boolean;
  /** fr-local state this call deliberately did not touch. */
  fr_local_retained: string[];
}

export interface SuperAdminStatus {
  is_super_admin: boolean;
}

export async function getSuperAdminStatus(): Promise<SuperAdminStatus> {
  const r = await authFetch('/api/me/super-admin');
  if (!r.ok) {
    throw new Error(`getSuperAdminStatus: ${r.status}`);
  }
  return (await r.json()) as SuperAdminStatus;
}

export async function provisionUser(
  input: NewTenantProvisionInput,
): Promise<ProvisionUserResult> {
  return postProvision<ProvisionUserResult>(input);
}

/**
 * Add a human member to an EXISTING tenant by id (same endpoint, `tenant_id`
 * mode). Mints no licence, budget or seat. A 409 `tenant_divergence` means the
 * account already belongs to ANOTHER tenant — fr never re-tenants it; the thrown
 * message carries the backend's `detail`.
 */
export async function provisionMemberIntoTenant(
  input: ExistingTenantProvisionInput,
): Promise<ProvisionMemberResult> {
  return postProvision<ProvisionMemberResult>(input);
}

async function postProvision<T>(input: ProvisionUserInput): Promise<T> {
  const r = await authFetch('/api/admin/super-admin/provision-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    // Shape-aware. The backend returns `{error:{code,message,service,upstream}}`
    // for integration failures — an OBJECT — so the old
    // `[error, detail].join(': ')` here rendered the operator a bare
    // `[object Object]` while the real reason sat inside `upstream.body.detail`.
    const detail = await errorDetailOf(r);
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`provisionUser: ${r.status}${suffix}`);
  }
  return (await r.json()) as T;
}

/**
 * Offboard: reverse the provisioning run for (email, tenant_slug).
 *
 *   POST /api/admin/super-admin/deprovision-user
 *     200 → DeprovisionUserResult
 *     404 → no provisioning run exists for this pair; NOTHING was deleted
 *     401/403 → not signed in / not super-admin
 *
 * The 404 is a meaningful answer, not a transport failure: accounts onboarded
 * before fr was repointed onto the provisioning engine have no run to reverse.
 * The thrown message carries the backend's `detail`, which explains that.
 */
export async function deprovisionUser(
  input: DeprovisionUserInput,
): Promise<DeprovisionUserResult> {
  const r = await authFetch('/api/admin/super-admin/deprovision-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    // Shape-aware. The backend returns `{error:{code,message,service,upstream}}`
    // for integration failures — an OBJECT — so the old
    // `[error, detail].join(': ')` here rendered the operator a bare
    // `[object Object]` while the real reason sat inside `upstream.body.detail`.
    const detail = await errorDetailOf(r);
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`deprovisionUser: ${r.status}${suffix}`);
  }
  return (await r.json()) as DeprovisionUserResult;
}

// ---------------------------------------------------------------------------
// GET /api/admin/users — who has access to fr, and where.
//
// `user_roles` is the authority, not the Keycloak directory: it is the table
// the backend gates on, so a person with an account and no row has no access,
// and a row whose account is gone is a dangling grant worth seeing.
// ---------------------------------------------------------------------------

export interface AdminUserWorkspace {
  tenant_id: string;
  tenant_name: string | null;
  role: string;
  granted_at: string;
  granted_by: string | null;
}

export interface AdminUser {
  user_id: string;
  email: string | null;
  name: string | null;
  /** False when the directory could not resolve the id — a DANGLING grant. */
  resolved: boolean;
  workspaces: AdminUserWorkspace[];
}

export interface AdminUserList {
  users: AdminUser[];
  grant_count: number;
  /** Set when the directory lookup failed; names are missing, access is not. */
  directory_error: string | null;
}

export async function listAdminUsers(): Promise<AdminUserList> {
  const r = await authFetch('/api/admin/users');
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`listAdminUsers: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as AdminUserList;
}

// ---------------------------------------------------------------------------
// Role grants — grant and revoke one person's role in one tenant.
//
//   POST   /api/admin/users/:userId/roles   {tenant_id, role}
//     201 → a new row was written
//     200 → the row was already there; NOTHING changed
//
//   DELETE /api/admin/users/:userId/roles?tenant_id=&role=
//     204 → removed
//     404 → there was no such grant
//
// Both non-error statuses on each verb carry information the operator needs, so
// neither helper collapses them into `void`: a 200 rendered as "Granted" claims
// an action that did not happen, and a 404 rendered as an exception reads as an
// outage when it is an answer.
// ---------------------------------------------------------------------------

/** The only two roles the backend accepts. Anything else is a 422. */
export type WorkspaceRoleName = 'workspace-admin' | 'workspace-member';

export interface UserRoleRef {
  tenant_id: string;
  role: WorkspaceRoleName;
}

/**
 * What revoke takes. Wider than {@link UserRoleRef} on purpose: `user_roles.role`
 * is free TEXT, so rows exist carrying values this union can no longer express
 * (a seeder or out-of-band INSERT wrote them before it narrowed). Typing revoke
 * as `WorkspaceRoleName` made those rows permanent — the UI listed each with a
 * Revoke button it then refused, and the only remedy was SQL against prod.
 *
 * Grant stays narrow. You must be able to undo a state you can no longer create.
 */
export interface UserRoleRevokeRef {
  tenant_id: string;
  role: string;
}

export interface GrantUserRoleResult {
  /** True ONLY on 201. False on 200 — they already had it. */
  created: boolean;
  tenant_id: string;
  role: WorkspaceRoleName;
  /**
   * The tenant's display name as the backend resolved it, or null when it
   * could not be resolved.
   */
  tenant_name: string | null;
  /**
   * Set when the grant SUCCEEDED but the licences catalogue could not be read
   * to resolve `tenant_name`. Deliberately not an error: the row is written and
   * the person has access. Surfacing it stops the UI silently showing a
   * nameless workspace and letting someone conclude the grant half-failed.
   */
  tenant_lookup_error: string | null;
}

export interface RevokeUserRoleResult {
  /** True on 204. False on 404 — nothing was removed. */
  removed: boolean;
  /** The backend's reason for a 404. `''` when it gave none. */
  detail: string;
}

export async function grantUserRole(
  userId: string,
  input: UserRoleRef,
): Promise<GrantUserRoleResult> {
  const r = await authFetch(`/api/admin/users/${encodeURIComponent(userId)}/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`grantUserRole: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  // Capture the status BEFORE reading the body: 201-vs-200 is the whole signal
  // separating "granted" from "already had it", and it is carried by the status
  // line, not the payload — so it survives a body that fails to parse.
  const created = r.status === 201;
  let body: Partial<{ tenant_name: string | null; tenant_lookup_error: string | null }> = {};
  try {
    body = (await r.json()) ?? {};
  } catch {
    // An empty or non-JSON 2xx is still a successful grant. Throwing here would
    // report a write that DID happen as a failure. The row exists; only the
    // display fields are unavailable.
    body = {};
  }
  return {
    created,
    tenant_id: input.tenant_id,
    role: input.role,
    tenant_name: body.tenant_name ?? null,
    tenant_lookup_error: body.tenant_lookup_error ?? null,
  };
}

export async function revokeUserRole(
  userId: string,
  input: UserRoleRevokeRef,
): Promise<RevokeUserRoleResult> {
  const qs = new URLSearchParams({ tenant_id: input.tenant_id, role: input.role });
  const r = await authFetch(
    `/api/admin/users/${encodeURIComponent(userId)}/roles?${qs.toString()}`,
    { method: 'DELETE' },
  );
  if (r.status === 204) return { removed: true, detail: '' };
  if (r.status === 404) {
    // Carry the backend's own sentence rather than asserting "already revoked".
    // This route 404s for an unknown user id too, and telling an operator their
    // grant was already gone when they in fact addressed the wrong person would
    // leave a live grant standing behind a success message.
    return { removed: false, detail: await errorDetailOf(r) };
  }
  const detail = await errorDetailOf(r);
  throw new Error(`revokeUserRole: ${r.status}${detail ? ` — ${detail}` : ''}`);
}
