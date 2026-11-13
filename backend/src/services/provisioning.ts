// src/services/provisioning.ts
//
// Client for the provisioning-service — the single tenant/license/quota
// lifecycle engine. The super-admin licensing console routes its license
// grant/revoke through here (instead of minting/revoking directly against the
// licenses service) so every mint ALSO registers, and every revoke ALSO
// deregisters, the billing request-quota that license-authz enforces at HTTP
// 402. fr's old direct-to-licenses path never touched that quota — a license it
// granted had nothing enforced, and one it revoked left an orphaned quota row.
//
// AUTH: portal-realm SA (`getServiceAuthenticator()`). provisioning verifies the
// inbound token against the portal realm and requires the `provision-caller`
// realm role — the fr-backend portal SA must hold it (Keycloak realm grant).
//
// IDEMPOTENCY: provisioning de-dups on a caller-supplied `idempotency_key`, and
// the key semantics differ PER OPERATION — this is not a stylistic choice:
//
//   * grant / revoke  → FRESH key per call BY DEFAULT. Each console action is a
//     distinct intent; a natural key would replay a prior grant and never re-mint
//     after an intervening revoke. The one exception is the app-delete cascade,
//     which passes an explicit DETERMINISTIC key — see `licenseRevokeIdempotencyKey()`.
//
//   * provision / deprovision → DETERMINISTIC key, derived from
//     (email, tenant_slug) by `provisionIdempotencyKey()`. Two hard reasons:
//       1. A retry MUST replay, not re-run. `regenerate_token` upstream is NOT
//          idempotent — a fresh key on a retry re-mints the token and silently
//          invalidates the one the operator already handed to the customer.
//       2. `POST /api/deprovision` addresses the run to reverse BY ITS ORIGINAL
//          PROVISION KEY (see provisioning `DeprovisionRequest`). If the
//          provision key were random we could never name the run again, so the
//          offboard surface would be structurally impossible.
//     Consequence, by design: re-provisioning the same person into the same
//     tenant_slug REPLAYS (`replayed=true`, no one-time secrets) instead of
//     minting more. Adding an app to an existing user is `grantLicense`, not a
//     second provision — and the caller must surface the replay honestly rather
//     than render an empty credential box.

import { createHash } from 'node:crypto';
import { getServiceAuthenticator } from '../lib/service-authenticators';
import { config } from '../config';
import { IntegrationError } from '../integrations/_lib/errors';

/** Fresh idempotency key per action. */
function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// --- deterministic provision/deprovision key --------------------------------

/**
 * The stable idempotency key for "this person, onboarded into this tenant".
 *
 * Deterministic on purpose (see the IDEMPOTENCY note above): a provision retry
 * must REPLAY rather than re-mint, and deprovision addresses the run by this
 * exact key. Normalised (trim + lowercase) so an operator retyping
 * `Alice@Example.com` resolves to the same run, and hashed so no address ends up
 * in provisioning's logs/metrics labels. Charset + length satisfy provisioning's
 * `^[A-Za-z0-9._:-]+$`, 8..255 pattern.
 *
 * `v1` is a scheme version: bumping it deliberately orphans every prior run
 * (they become unreachable for deprovision), so do not bump it casually.
 */
function provisionIdempotencyKey(email: string, tenantSlug: string): string {
  // NUL field separator, written as an ESCAPE and never as a raw byte (a raw NUL
  // makes this file binary to git). It keeps the two fields unambiguous, so no
  // (email, slug) pair can collide with another by shifting the boundary.
  const subject = `${email.trim().toLowerCase()}\u0000${tenantSlug.trim().toLowerCase()}`;
  const digest = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 32);
  return `fr-provision-v1-${digest}`;
}

/**
 * The stable idempotency key for "revoke THIS license", used by bulk cascades
 * (app delete) where a fresh key would be actively wrong.
 *
 * Determinism buys two things a random key cannot, both verified against
 * provisioning's revoke path (`src/grant.py`):
 *
 *   1. A retry of a PARTIALLY failed run RESUMES it. A revoke whose billing
 *      deregistration failed finishes with run status `partial`, which counts as
 *      in-progress upstream — so re-sending the same key re-attempts the
 *      deregistration instead of opening a second run beside the orphan. That is
 *      exactly the case a bulk cascade must be able to retry.
 *   2. A retry of a SUCCEEDED run replays and faithfully re-reports the original
 *      run's `billing_quota_retained`, rather than answering "clean" because there
 *      was nothing left to do.
 *
 * The operation is baked into both the prefix and the hashed subject, so this key
 * cannot collide with a grant/provision key — provisioning 409s a key reused
 * across operations. Charset + length satisfy `^[A-Za-z0-9._:-]+$`, 8..255.
 *
 * `v1` is a scheme version: bumping it makes every prior revoke run unreachable
 * (a retry would open a fresh run instead of resuming it), so do not bump casually.
 *
 * The `\0` in the subject is a DELIBERATE domain separator (it cannot occur in a
 * license id, so `op`/`id` can never be re-split ambiguously). Removing it silently
 * changes every key this function has ever produced — i.e. exactly the "bumping v1"
 * breakage above, but without the version bump. Do not "clean up" the escape.
 */
export function licenseRevokeIdempotencyKey(licenseId: string): string {
  const subject = `revoke-license\0${licenseId.trim().toLowerCase()}`;
  const digest = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 32);
  return `fr-revoke-license-v1-${digest}`;
}

// --- wire types (subset we consume; provisioning returns more) --------------

interface ProvLicenseGrant {
  app_key: string;
  license_id: string;
  /** null on an idempotent REPLAY — the token was yielded only on the original call. */
  token: string | null;
}

export interface ProvProvisionResult {
  idempotency_key: string;
  status: string; // success | succeeded_with_warnings | partial
  tenant_id: string;
  keycloak_user_id: string;
  already_existed: boolean;
  /**
   * null whenever provisioning did not mint one: an ALREADY-EXISTING Keycloak
   * user's password is deliberately never rotated, and a replay yields no
   * secrets at all. Never coerce this to `''` — an empty credential box reads
   * as "here is your password" and it is not one.
   */
  temporary_password: string | null;
  licenses: ProvLicenseGrant[];
  magic_link_sent: boolean;
  replayed: boolean;
  warnings: string[];
  partial_failures: string[];
}

export interface ProvDeprovisionResult {
  idempotency_key: string;
  status: string; // "deprovisioned"
  keycloak_user_deleted: boolean;
  /**
   * True when the run's identity was caller-owned (fr's realm): provisioning did NOT delete it
   * and fr must remove it from its own realm. Absent on a provisioning older than that field.
   */
  keycloak_user_caller_owned?: boolean;
  /** The run's identity (present on a provisioning with caller-owned identities). */
  keycloak_user_id?: string | null;
  licenses_deleted: number;
  tenant_id: string | null;
  /** Always true: the licenses registry exposes no tenant-DELETE (shared entity). */
  tenant_retained: boolean;
  /** True only when a quota config could NOT be removed — surfaced, not hidden. */
  billing_quota_retained: boolean;
  already_deprovisioned: boolean;
}

export interface ProvGrantResult {
  idempotency_key: string;
  status: string; // success | succeeded_with_warnings | partial
  tenant_id: string;
  subject_id: string;
  license: { app_key: string; license_id: string; token: string | null };
  replayed: boolean;
  warnings: string[];
  partial_failures: string[];
}

interface ProvRevokeResult {
  idempotency_key: string;
  status: string; // "revoked"
  tenant_id: string;
  subject_id: string | null;
  licenses_revoked: number;
  quotas_deregistered: number;
  billing_quota_retained: boolean;
  already_revoked: boolean;
}

interface ProvQuotaResyncResult {
  status: string; // "resynced" | "partial"
  app_id: string;
  plan_id: string;
  quota_monthly: number | null;
  licenses_found: number;
  quotas_registered: number;
  quotas_deregistered: number;
  /** Licenses the resync could NOT apply — surfaced, never hidden. */
  failures: string[];
}

// --- shared request plumbing ------------------------------------------------

async function post<T>(
  path: string,
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${config.services.provisioning.baseUrl}${path}`;
  let res: Response;
  try {
    res = await getServiceAuthenticator().authenticatedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    const isTimeout =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new IntegrationError({
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `provisioning ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'provisioning',
      method: 'POST',
      path,
      cause: e,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : text;
    } catch {
      // not JSON; keep raw text
    }
    let code:
      | 'UPSTREAM_NOT_FOUND'
      | 'UPSTREAM_UNAUTHORIZED'
      | 'UPSTREAM_FORBIDDEN'
      | 'UPSTREAM_CONFLICT'
      | 'UPSTREAM_BAD_STATUS' = 'UPSTREAM_BAD_STATUS';
    if (res.status === 401) code = 'UPSTREAM_UNAUTHORIZED';
    else if (res.status === 403) code = 'UPSTREAM_FORBIDDEN';
    else if (res.status === 404) code = 'UPSTREAM_NOT_FOUND';
    else if (res.status === 409) code = 'UPSTREAM_CONFLICT';
    throw new IntegrationError({
      code,
      message: `provisioning ${path} ${res.status}: ${
        typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      }`,
      service: 'provisioning',
      method: 'POST',
      path,
      upstreamStatus: res.status,
      // Carry the PARSED body, not just its stringification inside `message`.
      // `integrationErrorResponse` emits it as `upstream.body`, which is where
      // the frontend reads provisioning's own sentence from — e.g.
      // {"detail": "no active plan for licenses app 'meta_prompt_core_actions'"}.
      // Omitting it left `upstream.body` undefined and the operator with
      // nothing but fr's generic "provisioning /api/provision 404: …" wrapper.
      upstreamBody: parsed,
    });
  }

  return (await res.json()) as T;
}

// --- public API -------------------------------------------------------------

/**
 * Onboard a person: canonical tenant + Keycloak account + a license (and its
 * REGISTERED billing quota) per app key, in one idempotent call.
 *
 * ⚠️ `workspace_role` is deliberately NOT sent. provisioning's `workspace_role`
 * is a **Keycloak REALM role** (`orchestration.assign_realm_role`), bounded by
 * `PERMITTED_WORKSPACE_ROLES` whose prod value is `["member"]` — so omitting it
 * takes provisioning's own `member` default. fr's `workspace_role`
 * (`'admin' | 'member'`) is a completely different axis: the fr-LOCAL DB role
 * `workspace-admin` / `workspace-member` in fr's own `user_roles` table. They
 * share a name and nothing else. Forwarding fr's value would 403 on `'admin'`
 * today and, if the allow-list were ever widened, would silently mint a real
 * realm role from a console dropdown. fr keeps granting its local role itself.
 */
export function provisionUser(input: {
  email: string;
  name: string;
  tenantSlug: string;
  appKeys: string[];
  sendPasswordResetEmail: boolean;
  /**
   * OPTIONAL per-app plan choice: `app_key` → plan uuid. Omit an app (or the
   * whole map) to keep provisioning's default of "that app's first non-revoked
   * plan".
   *
   * Measured against provisioning `src/orchestration.py` (the `3a. PRE-FLIGHT`
   * block, commit 4b61c4a / PR #37):
   *
   *   * the choice is resolved in the engine's OWN pre-flight, BEFORE anything is
   *     minted, so a plan that does not exist for that app or is revoked is a 400
   *     with nothing created — never a partial run to clean up.
   *   * there is NO silent fallback to first-non-revoked. That is deliberate
   *     upstream: a picker whose answer is quietly discarded is worse than no
   *     picker, because it manufactures false confidence about what a customer
   *     was given.
   *   * an entry for an app that is NOT in `app_keys` is silently IGNORED
   *     upstream (`(req.app_plans or {}).get(key)` is only consulted per
   *     requested key). fr therefore refuses that request itself — see
   *     `app_plans_for_unrequested_apps` in routes/admin/super-admin.ts.
   *
   * ⚠️ Sent ONLY when present AND non-empty, so every existing caller produces a
   * byte-identical request body. Do not "simplify" this to an unconditional
   * assignment: `app_plans: {}` would be a new wire field on every legacy call.
   *
   * ⚠️ It is deliberately NOT part of the idempotency key (see IDEMPOTENCY at the
   * top of this file). Two consequences, both intended:
   *   1. Retrying a failed provision with a CORRECTED plan replays nothing new —
   *      it is the same (email, tenant_slug) run. Good: a retry must not re-mint
   *      tokens.
   *   2. Therefore a plan choice cannot be CHANGED by re-provisioning. A replay
   *      returns the original run's licences, minted on the original plan. To move
   *      an existing licence to another plan, revoke it and grant again — do not
   *      expect a second provision to re-plan it.
   *
   * ⚠️ A provisioning deployment older than 4b61c4a has no `app_plans` field and
   * pydantic's default `extra='ignore'` (there is no `model_config` in its
   * `schemas.py`) makes it DISCARD this silently — and `LicenseGrant` carries no
   * `plan_id`, so the response cannot reveal that it was dropped. The plan choice
   * therefore needs that version live; it cannot be verified from here.
   */
  appPlans?: Record<string, string>;
  /**
   * OPTIONAL tenant inference posture (PLAN tenant-inference-provisioning §2.6),
   * sent ONLY when the owner's form carried an `inference` block. Absent = the
   * wire body is byte-identical to before these fields existed.
   *
   * `byoMode` is the owner's explicit choice (never derived from tiers);
   * `budgetCurrency` (EUR | USD | CAD) makes provisioning mark the tenant
   * money-budgeted BEFORE any licence mint, so the seat licences skip the
   * token-budget leg. ⚠️ provisioning a5503f4 accepts only "EUR" (422 otherwise).
   */
  byoMode?: 'local_allowed' | 'byo_required' | 'platform_only';
  budgetCurrency?: 'EUR' | 'USD' | 'CAD';
  /**
   * CALLER-OWNED IDENTITY (realm per app, 2026-10-23). The id of the user fr already minted
   * in ITS realm (`config.keycloak.userRealm`, prod `fr`). provisioning then performs no
   * Keycloak step and sends no email; the id is the licence subject. Without it provisioning
   * creates the address in ITS realm (portal) — a second, foreign user that fr's JWTs never
   * present (the 2026-10-23 approve `identity_mismatch`). Requires
   * `sendPasswordResetEmail: false` (provisioning 422s otherwise: it cannot mail a user in
   * fr's realm). Every fr caller passes it: see services/user-realm-provision.ts.
   */
  keycloakUserId?: string;
}): Promise<ProvProvisionResult> {
  const body: Record<string, unknown> = {
    idempotency_key: provisionIdempotencyKey(input.email, input.tenantSlug),
    email: input.email,
    name: input.name,
    tenant_slug: input.tenantSlug,
    app_keys: input.appKeys,
    send_password_reset_email: input.sendPasswordResetEmail,
    // NO workspace_role — see the doc comment above. Do not "fix" this by
    // forwarding fr's admin/member value.
  };
  if (input.appPlans && Object.keys(input.appPlans).length > 0) {
    body.app_plans = input.appPlans;
  }
  if (input.byoMode) body.byo_mode = input.byoMode;
  if (input.budgetCurrency) body.budget_currency = input.budgetCurrency;
  if (input.keycloakUserId) body.keycloak_user_id = input.keycloakUserId;
  return post<ProvProvisionResult>('/api/provision', body);
}

/**
 * Apply a tenant's inference configuration ONCE per tenant
 * (provisioning `POST /api/tenants/{t}/inference/apply`, PLAN §2.5/§3.4).
 *
 * AUTH is two-layered and provisioning requires both: fr's portal SA (role
 * `provision-caller`, via `authenticatedFetch`) AND the owner's own portal JWT
 * in `X-Forwarded-User-Authorization: Bearer <jwt>` — IR authorises the HUMAN
 * on its admin API and provisioning relays the header unread. The JWT is passed
 * through and never logged, stored or put in an error message.
 *
 * 200 covers both `success` and `partial` (the body names the failed step);
 * everything else throws an IntegrationError carrying provisioning's own body
 * (409 setup2_disabled / setup3_not_yet_available / apply_in_progress / ...).
 * The timeout is long on purpose: the apply ends with a 1-token smoke per tier
 * plus a ledger read-back that polls up to ~10 s.
 */
export function applyTenantInference(input: {
  tenantId: string;
  ownerPortalToken: string;
  body: Record<string, unknown>;
}): Promise<unknown> {
  return post<unknown>(
    `/api/tenants/${encodeURIComponent(input.tenantId)}/inference/apply`,
    input.body,
    {
      headers: { 'X-Forwarded-User-Authorization': `Bearer ${input.ownerPortalToken}` },
      timeoutMs: 120_000,
    },
  );
}

/**
 * Reverse a prior provision (offboard), addressed by the SAME deterministic key
 * the provision used. Deletes the Keycloak user + the licenses that run created
 * and deregisters their billing quota; the shared registry tenant is retained.
 *
 * Throws `IntegrationError(UPSTREAM_NOT_FOUND)` when provisioning has no run for
 * this (email, tenant_slug) — e.g. an account onboarded before fr was repointed
 * onto the engine. That is a real "nothing to reverse", not a success.
 */
export function deprovisionUser(input: {
  email: string;
  tenantSlug: string;
  reason?: string | null;
}): Promise<ProvDeprovisionResult> {
  const body: Record<string, unknown> = {
    idempotency_key: provisionIdempotencyKey(input.email, input.tenantSlug),
  };
  if (input.reason != null) body.reason = input.reason;
  return post<ProvDeprovisionResult>('/api/deprovision', body);
}

/**
 * Grant ONE license to an existing subject in an existing tenant, registering
 * the plan's monthly billing quota. The app is addressed by uuid (`appId`) — the
 * console works in app_ids. `region_id`/`starts_at`/`expires_at`/`metadata` pass
 * through to the license mint for parity with a direct create.
 */
export function grantLicense(input: {
  tenantId: string;
  subjectId: string;
  /** EXACTLY ONE of `appId` / `appKey` (the engine 422s both or neither). */
  appId?: string;
  /** The app by catalogue key — the signup licence repair addresses `fr` this way. */
  appKey?: string;
  planId?: string | null;
  regionId?: string | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ProvGrantResult> {
  const body: Record<string, unknown> = {
    idempotency_key: newIdempotencyKey('grant'),
    tenant_id: input.tenantId,
    subject_id: input.subjectId,
  };
  if (input.appId != null) body.app_id = input.appId;
  if (input.appKey != null) body.app_key = input.appKey;
  if (input.planId != null) body.plan_id = input.planId;
  if (input.regionId != null) body.region_id = input.regionId;
  if (input.startsAt != null) body.starts_at = input.startsAt;
  if (input.expiresAt != null) body.expires_at = input.expiresAt;
  if (input.metadata != null) body.metadata = input.metadata;
  return post<ProvGrantResult>('/api/licenses/grant', body);
}

/**
 * Revoke ONE specific license by id (+ deregister its billing quota). Used by
 * the console's revoke-by-license-id action.
 */
export function revokeLicenseById(input: {
  tenantId: string;
  licenseId: string;
  reason?: string | null;
  /**
   * Override the idempotency key. Defaults to a fresh per-call key (a single
   * console revoke is a one-shot intent). Bulk cascades (app delete) pass a
   * DETERMINISTIC key via `licenseRevokeIdempotencyKey` so a retried cascade
   * resumes a partially-failed revoke instead of opening a second run.
   */
  idempotencyKey?: string;
}): Promise<ProvRevokeResult> {
  const body: Record<string, unknown> = {
    idempotency_key: input.idempotencyKey ?? newIdempotencyKey('revoke'),
    tenant_id: input.tenantId,
    license_id: input.licenseId,
  };
  if (input.reason != null) body.reason = input.reason;
  return post<ProvRevokeResult>('/api/licenses/revoke', body);
}

/**
 * Revoke EVERY license a subject holds in a tenant (+ deregister each quota).
 * Backs the console's delete-subject-licenses action.
 */
export function revokeSubjectLicenses(input: {
  tenantId: string;
  subjectId: string;
  reason?: string | null;
}): Promise<ProvRevokeResult> {
  const body: Record<string, unknown> = {
    idempotency_key: newIdempotencyKey('revoke'),
    tenant_id: input.tenantId,
    subject_id: input.subjectId,
  };
  if (input.reason != null) body.reason = input.reason;
  return post<ProvRevokeResult>('/api/licenses/revoke', body);
}

/**
 * Propagate a plan's monthly quota to every LIVE license on that plan.
 *
 * Billing snapshots `quota_monthly` per license at grant time, so editing a plan
 * never reaches the already-registered configs — this re-applies the current value
 * (or deregisters when the plan becomes unlimited). No idempotency key: the upstream
 * op is an upsert/deregister and must always apply the CURRENT value, not replay.
 */
export function resyncPlanQuota(input: {
  appId: string;
  planId: string;
  /**
   * Omit to let provisioning read it from the plan; `null` → deregister
   * (unlimited); `0` → block-all (a REAL, enforced zero-request limit, NOT
   * unlimited); positive → that monthly cap. A literal `0` MUST be forwarded on
   * the wire — the `!= null` guard below (never `> 0`/truthiness) is load-bearing:
   * treating `0` as falsy would silently swallow a block-all into "unlimited".
   */
  quotaMonthly?: number | null;
}): Promise<ProvQuotaResyncResult> {
  const body: Record<string, unknown> = {
    app_id: input.appId,
    plan_id: input.planId,
  };
  if (input.quotaMonthly != null) body.quota_monthly = input.quotaMonthly;
  return post<ProvQuotaResyncResult>('/api/licenses/resync-quota', body);
}
