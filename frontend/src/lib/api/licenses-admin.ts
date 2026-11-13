// src/lib/api/licenses-admin.ts
//
// Typed client for the super-admin licensing console.
//
// Wire contracts mirror backend/src/routes/admin/licenses-admin.ts — keep in
// sync (there is no shared types package; both sides are hand-mirrored).
// Everything is gated super-admin server-side; a non-super-admin gets 403.
//
//   apps      GET|POST   /api/admin/licenses/apps            (GET filters test
//                                                             residue unless
//                                                             ?include_test=true)
//             GET|DELETE /api/admin/licenses/apps/:appId
//             GET        /api/admin/licenses/apps/:appId/plans
//             GET        /api/admin/licenses/apps/:appId/licenses
//   plans     GET|POST   /api/admin/licenses/plans
//             PATCH|DELETE /api/admin/licenses/plans/:planId
//   regions   GET|POST   /api/admin/licenses/regions
//   grants    GET        /api/admin/licenses/grants
//             POST       /api/admin/licenses/grants/revoke
//             GET|POST|DELETE /api/admin/licenses/grants/user/:subjectId
//             POST       /api/admin/licenses/grants/:licenseId/tokens
//             POST       /api/admin/licenses/grants/:licenseId/regenerate-token
//   tenants   GET|POST   /api/admin/licenses/tenants
//             GET        /api/admin/licenses/tenants/:nameOrId
//             GET        /api/admin/licenses/tenants/:nameOrId/offerings
//             GET        /api/admin/licenses/tenants/:nameOrId/seat-count
//             GET|PATCH  /api/admin/licenses/tenants/:nameOrId/byo-mode
//             PUT|DELETE /api/admin/licenses/tenants/:nameOrId/apps/:appKey/byo-mode
//   offerings GET|POST   /api/admin/licenses/offerings   (GET → {offerings:[…]})
//             GET|DELETE /api/admin/licenses/offerings/:appKey/:code
//             POST|DELETE /api/admin/licenses/tenants/:nameOrId/offerings/:appKey/:code
//   budget    GET        /api/admin/licenses/budget/:tenantId
//             GET        /api/admin/licenses/budget-packages
//             POST       /api/admin/licenses/budget/topup/:tenantId
//             POST       /api/admin/licenses/budget/reset/:tenantId
//             PATCH      /api/admin/licenses/budget/line/:licenseId
//                        (a tenant's figure is a SUM over budget rows; reset
//                         zeroes every consumed counter, the line PATCH edits
//                         one licence's override — null CLEARS it)
//
// Auth: every call goes through `authFetch`, which attaches the browser's
// Keycloak access token. These helpers MUST run client-side, after the auth
// store has hydrated — never from a SvelteKit SSR `load()` on the Node side.
//
// Tenant targeting: a super-admin acts ACROSS tenants, so the target rides in
// `X-Target-Tenant-Id`, NOT `X-Tenant-Id`. authFetch never sets `X-Tenant-Id`
// (the caller's own workspace rides in `X-Active-Tenant`, honoured only for a
// super-admin); fr's request context does not take a tenant from a JWT caller's
// `X-Tenant-Id` (fr#1437 removed the aa-orchestrator override), and the
// licenses edge overloads that name separately — fr-backend maps
// `X-Target-Tenant-Id` onto the upstream `X-Tenant-Id` itself
// (services/licenses.ts).

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';
import type { BudgetStatusResponse } from './usage';
import { parseTopUpPackageList, type TopUpPackageList } from './budget';

export type ByoMode = 'local_allowed' | 'byo_required' | 'platform_only';

export const BYO_MODES: ByoMode[] = [
  'local_allowed',
  'byo_required',
  'platform_only',
];

/** A Keycloak user, resolved so the operator never sees a bare `sub` UUID. */
export interface PersonRecord {
  id: string; // Keycloak sub — the value a license binds to
  email: string | null;
  name: string;
  username?: string | null;
  tenant_id?: string | null; // their Keycloak tenant_id attribute
}

export interface AppRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  revoked: boolean;
  /**
   * Who holds a licence for this app: `human` (end-user product), `platform`
   * (service-to-service) or `automation` (n8n action module). Shipped by the
   * licences service in #168, which is also where the classification lives now.
   *
   * OPTIONAL on purpose: a licences deployment older than #168 omits the field
   * entirely. That case must be DETECTED, not silently treated as "no app is
   * human" — which would render an empty picker indistinguishable from a
   * correctly-empty one. See `provisionableApps`.
   */
  audience?: 'human' | 'platform' | 'automation';
  created_at: string;
}

export interface PlanRecord {
  id: string;
  app_id: string;
  code: string;
  name: string;
  description: string | null;
  region_id: string | null;
  duration_days: number | null;
  rate_limit_rpm: number | null;
  rate_limit_burst: number | null;
  quota_monthly: number | null;
  token_budget_monthly: number | null;
  revoked: boolean;
  created_at: string;
}

/**
 * What the billing propagation that follows a `quota_monthly` edit actually did.
 *
 * Editing a plan's quota does NOT by itself change what billing enforces: the quota
 * config is keyed per license and snapshotted at grant time, so the backend re-applies
 * it to every live license on the plan. That pass is best-effort — the PATCH has already
 * committed, so a failure there must not fail the edit, but it must not be hidden either:
 * billing enforcement can still carry the OLD limit for some licenses, and only an
 * operator can decide to retry.
 *
 * The backend has surfaced this since #737/#738; this client did not expose it, so the
 * console could not tell a clean propagation from a degraded one.
 */
export interface PlanQuotaResync {
  /** `resynced` when every license was re-applied; anything else is degraded. */
  status: string;
  /** DERIVED from `status` by the backend — never assumed clean from a lack of errors. */
  ok: boolean;
  licenses_found: number | null;
  quotas_registered: number | null;
  quotas_deregistered: number | null;
  /** Licenses the resync could NOT apply (or the transport error). Never hidden. */
  failures: string[];
}

/**
 * A plan PATCH response. Preserves the established `PlanRecord` contract and ADDS the
 * resync outcome; both fields are absent when the patch did not touch `quota_monthly`,
 * which is why they are optional rather than nullable.
 */
export interface PlanUpdateResult extends PlanRecord {
  quota_resync?: PlanQuotaResync | null;
  quota_resync_ok?: boolean;
}

export interface RegionRecord {
  id: string;
  code: string;
  name: string;
  active: boolean;
  created_at: string;
}

export interface TenantRecord {
  id: string;
  name: string;
  keycloak_realm: string | null;
  byo_mode: string;
  /**
   * The tenant's money-budget currency (EUR | USD | CAD) once the licences
   * lane ships it (PLAN tenant-inference-provisioning §2.2). Optional: absent
   * on a licences deployment that predates it — read as "unknown", never EUR.
   */
  budget_currency?: string | null;
  created_at: string | null;
  /**
   * When the tenant was archived, or null while it is live.
   *
   * Archiving REVOKES NOTHING — licences, tokens and budgets survive and
   * existing tokens keep working. It hides the tenant from pick-lists and says
   * "do not provision into this".
   *
   * Optional, not just nullable: a licences deployment older than the archive
   * migration omits the field, and `!t.archived_at` must still read "live"
   * there rather than blanking the list.
   */
  archived_at?: string | null;
  /**
   * Tenant classification — `customer | internal | service | test |
   * unclassified`. Emitted by `Tenant.to_dict()` since licences migration 027.
   *
   * Optional for the same reason as `archived_at`: a licences deployment
   * predating 027 omits it. An absent `kind` must degrade to "unclassified"
   * and still RENDER the row — never to a filter that removes it. fr#936 was
   * exactly that mistake in the other direction.
   */
  kind?: string | null;
  /**
   * Chargeback join key, or null when the apportionment is undecided.
   * Closed vocabulary, enforced upstream by `ck_tenants_cost_centre`
   * (licences migration 034). Read-only here.
   */
  cost_centre?: string | null;
  /**
   * The owning app's key (licences migration 050): tenant names are unique per
   * owner, so the same name may exist under another app. Optional: a licences
   * deployment predating 050 omits it.
   */
  owner_key?: string;
  /**
   * The owning app's own stable id for this tenant, or null. `POST /tenants`
   * is idempotent on (owner, external_ref) — never on name.
   */
  external_ref?: string | null;
}

export interface AppInfo {
  id: string;
  key: string;
  name: string;
}

export interface PlanInfo {
  id: string;
  code: string;
  name: string;
  rate_limit_rpm: number | null;
  rate_limit_burst: number | null;
  quota_monthly: number | null;
  token_budget_monthly: number | null;
}

export interface LicenseRecord {
  id: string;
  subject_id: string;
  tenant_id: string;
  app_id: string;
  plan_id: string;
  region_id: string | null;
  status: string;
  starts_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  metadata: Record<string, unknown> | null;
  app: AppInfo | null;
  plan: PlanInfo | null;
}

export interface OfferingRecord {
  id: string;
  app_id: string;
  app_key: string | null;
  code: string;
  name: string;
  byo_mode: string;
  markup_pct: number | null;
  surcharge_input_per_1m_usd: number | null;
  surcharge_output_per_1m_usd: number | null;
  surcharge_cache_creation_per_1m_usd: number | null;
  surcharge_cache_read_per_1m_usd: number | null;
  surcharge_per_request_usd: number | null;
  access_price_usd: number | null;
  access_cadence: string | null;
  included_allowance_usd: number | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Result of granting a license.
 *
 * `token` is the raw license token, shown ONCE and never retrievable again.
 * `token_error` is non-null when the license WAS created but minting its token
 * failed — a real, partially-complete state the UI must surface rather than
 * report as success.
 */
export interface GrantResult {
  license: LicenseRecord;
  token: string | null;
  token_error: string | null;
}

export interface TokenCreateResult {
  token_id: string;
  license_id: string;
  token: string;
  token_type: string;
  created_at: string;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

const tenantHeaders = (tenantId?: string): Record<string, string> =>
  tenantId ? { 'X-Target-Tenant-Id': tenantId } : {};

/** Pull the most useful message out of an error body, whatever its shape. */
/**
 * A failed admin call. `message` keeps the historical `fn: status — detail`
 * shape every caller and test reads; `status`, `code` (fr's `{code}` on a
 * coded refusal, e.g. `tenant_name_taken`) and `detail` (the server's own
 * sentence) let a page react to a specific refusal without parsing the text.
 */
export class LicensesAdminCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'LicensesAdminCallError';
  }
}

async function bodyOf(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

function codeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { code?: unknown; error?: unknown };
  if (typeof b.code === 'string' && b.code) return b.code;
  const nested = b.error && typeof b.error === 'object' ? (b.error as { code?: unknown }).code : null;
  return typeof nested === 'string' && nested ? nested : null;
}

function detailOf(body: unknown): string {
  try {
    if (!body || typeof body !== 'object') return '';
    const b = body as {
      error?: unknown;
      detail?: unknown;
    };
    // Integration errors nest as `{error: {code, message}}`; plain handler
    // errors are `{error: "..."}`. Flatten both to something readable.
    const err =
      b.error && typeof b.error === 'object'
        ? ((b.error as { message?: string; code?: string }).message ??
          (b.error as { code?: string }).code)
        : b.error;
    return [err, b.detail].filter(Boolean).join(': ');
  } catch {
    return '';
  }
}

async function call<T>(
  fn: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await authFetch(path, init);
  if (!r.ok) {
    const body = await bodyOf(r);
    const detail = detailOf(body);
    throw new LicensesAdminCallError(
      `${fn}: ${r.status}${detail ? ` — ${detail}` : ''}`,
      r.status,
      codeOf(body),
      detail,
    );
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// people — resolve Keycloak users so no UUID is ever typed or shown
// ---------------------------------------------------------------------------

/**
 * Search Keycloak users by email/name for the grant person-picker. Returns []
 * for queries shorter than 2 chars (the backend won't scan the directory on a
 * single keystroke). Each result carries the person's `tenant_id` so the grant
 * form can default the tenant to theirs.
 */
export async function searchUsers(query: string): Promise<PersonRecord[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const body = await call<{ users: PersonRecord[] }>(
    'searchUsers',
    `/api/admin/licenses/users?q=${encodeURIComponent(q)}`,
  );
  return body.users ?? [];
}

// ⛔ `resolveUsers` (batch sub → person for the licenses table's `Person`
// column) was removed here along with the column itself (commit 25296721)
// and the backend route it called (`POST /api/admin/licenses/users/resolve`,
// removed from routes/admin/licenses-admin.ts + server.ts). It was this
// client's only caller.

// ---------------------------------------------------------------------------
// apps
// ---------------------------------------------------------------------------

/**
 * The app catalog. Test/demo residue is filtered server-side by default;
 * `includeTest` opts into the raw list (only useful for cleanup work).
 */
export const listApps = (includeTest = false): Promise<AppRecord[]> =>
  call('listApps', `/api/admin/licenses/apps${includeTest ? '?include_test=true' : ''}`);

export const getApp = (appId: string): Promise<AppRecord> =>
  call('getApp', `/api/admin/licenses/apps/${encodeURIComponent(appId)}`);

export const createApp = (body: {
  key: string;
  name: string;
  description?: string | null;
}): Promise<AppRecord> =>
  call('createApp', '/api/admin/licenses/apps', { method: 'POST', ...json(body) });

/** One license whose billing quota outlived it, and why. */
export interface RetainedQuota {
  license_id: string;
  tenant_id: string;
  subject_id: string;
  reason: string;
}

/**
 * What an app delete really did.
 *
 * Deliberately not a 204: the backend revokes each license through provisioning
 * (which is what deregisters its billing quota) before destroying the app, and a
 * deregistration can fail while the delete still goes through. A quota config that
 * outlives its license is re-seeded every 6h forever. NEVER render this as a plain
 * success — check `billing_quota_retained`.
 */
export interface AppDeleteReport {
  app_id: string;
  deleted: boolean;
  licenses_found: number;
  quotas_deregistered: number;
  billing_quota_retained: boolean;
  retained_quota_licenses: RetainedQuota[];
}

/**
 * ⚠️ HARD CASCADE — deletes the app's plans, licenses and tokens. Upstream has
 * no "still referenced" guard here. Always confirm against `listAppLicenses`
 * first; the count is the only warning the operator gets.
 *
 * Returns a report, not void — see `AppDeleteReport`. The backend refuses to
 * delete at all if it cannot first enumerate the licenses, so a rejection here
 * means nothing was destroyed. If `billing_quota_retained` is true, some quota
 * configs were orphaned — surface `retained_quota_licenses` to the operator.
 */
export const deleteApp = (appId: string): Promise<AppDeleteReport> =>
  call('deleteApp', `/api/admin/licenses/apps/${encodeURIComponent(appId)}`, {
    method: 'DELETE',
  });

export const listAppLicenses = (appId: string): Promise<LicenseRecord[]> =>
  call(
    'listAppLicenses',
    `/api/admin/licenses/apps/${encodeURIComponent(appId)}/licenses`,
  );

// ---------------------------------------------------------------------------
// plans + regions
// ---------------------------------------------------------------------------

export const listPlans = (): Promise<PlanRecord[]> =>
  call('listPlans', '/api/admin/licenses/plans');

export const listAppPlans = (appId: string): Promise<PlanRecord[]> =>
  call('listAppPlans', `/api/admin/licenses/apps/${encodeURIComponent(appId)}/plans`);

export const createPlan = (body: {
  app_id: string;
  code: string;
  name: string;
  description?: string | null;
  region_id?: string | null;
  duration_days?: number | null;
  rate_limit_rpm?: number | null;
  rate_limit_burst?: number | null;
  quota_monthly?: number | null;
  token_budget_monthly?: number | null;
}): Promise<PlanRecord> =>
  call('createPlan', '/api/admin/licenses/plans', { method: 'POST', ...json(body) });

export const updatePlan = (
  planId: string,
  body: {
    name?: string | null;
    description?: string | null;
    duration_days?: number | null;
    rate_limit_rpm?: number | null;
    rate_limit_burst?: number | null;
    quota_monthly?: number | null;
    token_budget_monthly?: number | null;
  },
): Promise<PlanUpdateResult> =>
  call('updatePlan', `/api/admin/licenses/plans/${encodeURIComponent(planId)}`, {
    method: 'PATCH',
    ...json(body),
  });

/** 409 while licenses still reference the plan — surfaced in the thrown message. */
export const deletePlan = (planId: string): Promise<void> =>
  call('deletePlan', `/api/admin/licenses/plans/${encodeURIComponent(planId)}`, {
    method: 'DELETE',
  });

export const listRegions = (): Promise<RegionRecord[]> =>
  call('listRegions', '/api/admin/licenses/regions');

export const createRegion = (body: {
  code: string;
  name: string;
  active?: boolean;
}): Promise<RegionRecord> =>
  call('createRegion', '/api/admin/licenses/regions', { method: 'POST', ...json(body) });

// ---------------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------------

export const listAllLicenses = (): Promise<LicenseRecord[]> =>
  call('listAllLicenses', '/api/admin/licenses/grants');

export const listSubjectLicenses = (
  subjectId: string,
  tenantId?: string,
): Promise<LicenseRecord[]> =>
  call(
    'listSubjectLicenses',
    `/api/admin/licenses/grants/user/${encodeURIComponent(subjectId)}`,
    { headers: tenantHeaders(tenantId) },
  );

/** Grant a license and mint its first token. See `GrantResult.token_error`. */
export const grantLicense = (
  subjectId: string,
  body: {
    app_id: string;
    plan_id: string;
    region_id?: string | null;
    starts_at?: string | null;
    expires_at?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  tenantId?: string,
): Promise<GrantResult> =>
  call(
    'grantLicense',
    `/api/admin/licenses/grants/user/${encodeURIComponent(subjectId)}`,
    { method: 'POST', ...json(body, tenantHeaders(tenantId)) },
  );

/**
 * Delete EVERY license a subject holds IN ONE TENANT. Returns how many went.
 *
 * `tenantId` is required (400 without it): upstream scopes the delete by tenant
 * and falls back to the caller's own subject when the header is absent, so a
 * tenant-less call deletes 0 and still answers 200.
 *
 * ⚠️ `{deleted: 0}` is a legitimate answer — report the COUNT, never treat the
 * resolved promise as "licenses were deleted".
 */
export const deleteSubjectLicenses = (
  subjectId: string,
  tenantId: string,
): Promise<{ deleted: number }> =>
  call(
    'deleteSubjectLicenses',
    `/api/admin/licenses/grants/user/${encodeURIComponent(subjectId)}`,
    { method: 'DELETE', headers: tenantHeaders(tenantId) },
  );

export const mintToken = (
  licenseId: string,
  // fr#1372: omitted expires_days = backend default (365), never perpetual.
  body: { token_type?: 'api' | 'node' | 'internal'; expires_days?: number } = {},
): Promise<TokenCreateResult> =>
  call('mintToken', `/api/admin/licenses/grants/${encodeURIComponent(licenseId)}/tokens`, {
    method: 'POST',
    ...json(body),
  });

/** Replaces the license's token. The old one stops working immediately. */
export const regenerateToken = (
  licenseId: string,
  tenantId?: string,
): Promise<{ token: string; message: string }> =>
  call(
    'regenerateToken',
    `/api/admin/licenses/grants/${encodeURIComponent(licenseId)}/regenerate-token`,
    { method: 'POST', headers: tenantHeaders(tenantId) },
  );

/**
 * Revoke a whole license, or one raw token. Exactly one — 422 otherwise.
 *
 * `tenantId` is REQUIRED (400 without it) and must be the LICENSE's tenant, not
 * the caller's. The licenses service masks a tenant mismatch as
 * `200 {revoked:false,"License not found"}` and leaves the license fully usable,
 * so a revoke with the wrong tenant is a silent no-op that looks like success.
 * The backend derives failure from the body and raises, so a resolved promise
 * here really does mean revoked.
 */
export const revoke = (
  body: { license_id?: string; token?: string },
  tenantId: string,
): Promise<{ revoked: boolean; message: string }> =>
  call('revoke', '/api/admin/licenses/grants/revoke', {
    method: 'POST',
    ...json(body, tenantHeaders(tenantId)),
  });

// ---------------------------------------------------------------------------
// tenants + BYO
// ---------------------------------------------------------------------------

/**
 * Every tenant. Archived ones are omitted unless asked for — every existing
 * caller (grant forms, the budgets table, the override picker) wants live
 * tenants only, so the default must not start offering archived ones.
 *
 * Service-mesh auth principals (`kind='service'`) are omitted by the same
 * reasoning and are likewise opt-in. They are 33 of the 59 live tenants, so a
 * grant form that offered them would bury the tenants an operator is actually
 * looking for. Only the management screen, which exists to show the whole
 * registry, passes `includeServiceActors`.
 */
export const listTenants = (
  includeArchived = false,
  includeServiceActors = false,
): Promise<TenantRecord[]> => {
  const params = new URLSearchParams();
  if (includeArchived) params.set('include_archived', 'true');
  if (includeServiceActors) params.set('include_service_actors', 'true');
  const qs = params.toString();
  return call('listTenants', `/api/admin/licenses/tenants${qs ? `?${qs}` : ''}`);
};

export const getTenant = (nameOrId: string): Promise<TenantRecord> =>
  call('getTenant', `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}`);

/**
 * One per-(tenant, product) posture row, with the offering that produced it.
 *
 * ⚠️ `offering_code: null` does NOT mean "no offering" — it means the provenance
 * is UNKNOWN. The posture was set directly rather than by provisioning an
 * offering, or it predates licences migration 025, which added the column and
 * could not backfill it because the offering code had never been recorded
 * anywhere. Render it as unknown; a blank cell asserts "nothing provisioned"
 * about rows that may well have been.
 */
export interface TenantOfferingRecord {
  app_key: string;
  app_name: string;
  byo_mode: string;
  offering_code: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * What this tenant has been provisioned, per product.
 *
 * licences owns only HALF of what provisioning writes — these posture rows, and
 * (S2S) the markup rule + access charge in billing. This is NOT the tenant's
 * billing picture, and should not be labelled as one.
 *
 * `[]` means no per-product overrides: every product then resolves to the
 * tenant-wide `byo_mode`, which lives on the tenant itself.
 */
export const listTenantOfferings = (
  nameOrId: string,
): Promise<TenantOfferingRecord[]> =>
  call(
    'listTenantOfferings',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/offerings`,
  );

/**
 * Billing's per-seat denominator for one tenant.
 *
 * ⚠️ `subjects` is partitioned EXACTLY by `human_subjects + service_subjects +
 * unresolved_subjects`. `unresolved_subjects` are the subject ids that could not
 * be classified — they must be disclosed, never folded into either side, because
 * folding them either over- or under-states what is billed.
 *
 * `human_subjects` is the billable basis. `seats` is the raw licence-row count,
 * which is >= `subjects` (a person may hold several licences in one tenant).
 *
 * ⛔ A rejection from here means the denominator is UNKNOWN. It does NOT mean
 * zero, and a caller that renders `0` on a failed read tells an operator this
 * tenant is unbilled.
 */
export interface TenantSeatCount {
  seats: number;
  subjects: number;
  human_subjects: number;
  service_subjects: number;
  unresolved_subjects: number;
  /**
   * `active_licences` | `tenant_archived` | `active_during_period`. THREE
   * values, not two — the archived case has its own basis, so a `0` is always
   * attributable to a reason rather than read as "no seats".
   */
  basis: string | null;
  /**
   * ⭐ THE PRODUCT THE COUNT IS SCOPED TO, echoed back. `null` (or absent) means
   * EVERY APP the tenant holds.
   *
   * ⛔ This is the field that makes an unscoped figure safe to display, and it
   * exists because the failure mode is silent: without `?app=`, upstream
   * aggregates every app, and the number then renders as a per-product seat
   * count that it is not. Upstream's own words (`main.py:7982-7990`): "Without
   * it a tenant's licences for every other app inflate a per-product seat
   * count." So a renderer MUST state its own scope — `null` as "all apps",
   * never beside one product's name. See `seatCountScope`.
   */
  app_key?: string | null;
  tenant_kind?: string | null;
  /**
   * An archived tenant's count is `0` for a REASON. Rendering it as a bare `0`
   * makes it indistinguishable from a live tenant that has no seats, which are
   * different facts with different remedies.
   */
  tenant_archived?: boolean;
  /** ISO-8601; the instant the count was evaluated at. */
  as_of?: string | null;
  /**
   * ⚠️ Present in the contract but ALWAYS `null` today: fr does not request a
   * period, and the backend deliberately does not expose one
   * (`handleGetTenantSeatCount`). Mirrored so the next reader recognises them as
   * deliberately unrequested rather than missing — and so nothing renders an
   * empty date range as though it were a real reporting window.
   */
  period_start?: string | null;
  period_end?: string | null;
}

/**
 * `GET /api/admin/licenses/tenants/:nameOrId/seat-count`.
 *
 * ⛔ WITHOUT `appKey` THE FIGURE AGGREGATES EVERY APP THE TENANT HOLDS. That is a
 * legitimate thing to ask for, but the caller then owes the reader a label — the
 * response echoes `app_key` (`null` = every app) so the renderer can state its
 * own scope without remembering what it asked. Never render an unscoped count
 * beside one product's name.
 */
export const getTenantSeatCount = (
  nameOrId: string,
  appKey?: string,
): Promise<TenantSeatCount> =>
  call(
    'getTenantSeatCount',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/seat-count` +
      (appKey ? `?app=${encodeURIComponent(appKey)}` : ''),
  );

/**
 * Create a licences tenant owned by fr. NOT idempotent by name: tenant names
 * are unique per owning app (licences migration 050), so a name fr already
 * holds is refused with 409 `tenant_name_taken` (a `LicensesAdminCallError`
 * with that `code`); a name only another app holds creates a NEW tenant.
 */
export const createTenant = (body: {
  name: string;
  keycloak_realm?: string | null;
}): Promise<TenantRecord> =>
  call('createTenant', '/api/admin/licenses/tenants', { method: 'POST', ...json(body) });

/**
 * Rename a tenant. `^[a-z0-9][a-z0-9-]*$`, enforced again server-side.
 *
 * The name is an identifier: `/tenants/{name_or_id}` resolves by name, and the
 * edge compares tenant names literally. Address the tenant by `id` here so a
 * caller that renames twice in a row is not sending the name it just replaced.
 */
export const renameTenant = (
  nameOrId: string,
  name: string,
): Promise<TenantRecord> =>
  call('renameTenant', `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}`, {
    method: 'PATCH',
    ...json({ name }),
  });

/**
 * Archive (`true`) or restore (`false`) a tenant.
 *
 * Revokes nothing. Licences, tokens and budgets are untouched and existing
 * tokens keep authenticating — this only hides the tenant from pick-lists.
 */
export const setTenantArchived = (
  nameOrId: string,
  archived: boolean,
): Promise<TenantRecord> =>
  call(
    'setTenantArchived',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/archive`,
    { method: 'PATCH', ...json({ archived }) },
  );

/** `appKey` resolves the EFFECTIVE posture for one product (override or tenant-wide). */
export const getByoMode = (
  nameOrId: string,
  appKey?: string,
): Promise<{ byo_mode: string } & Record<string, unknown>> =>
  call(
    'getByoMode',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/byo-mode` +
      (appKey ? `?app=${encodeURIComponent(appKey)}` : ''),
  );

export const setTenantByoMode = (
  nameOrId: string,
  byo_mode: ByoMode,
): Promise<unknown> =>
  call(
    'setTenantByoMode',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/byo-mode`,
    { method: 'PATCH', ...json({ byo_mode }) },
  );

/** Per-(tenant, app) override. Absent row ⇒ the tenant-wide posture applies. */
export const setTenantAppByoMode = (
  nameOrId: string,
  appKey: string,
  byo_mode: ByoMode,
): Promise<unknown> =>
  call(
    'setTenantAppByoMode',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/apps/${encodeURIComponent(appKey)}/byo-mode`,
    { method: 'PUT', ...json({ byo_mode }) },
  );

export const clearTenantAppByoMode = (
  nameOrId: string,
  appKey: string,
): Promise<void> =>
  call(
    'clearTenantAppByoMode',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/apps/${encodeURIComponent(appKey)}/byo-mode`,
    { method: 'DELETE' },
  );

// ---------------------------------------------------------------------------
// offerings
// ---------------------------------------------------------------------------

/** Unwraps the upstream `{offerings: [...]}` envelope. */
export async function listOfferings(appKey?: string): Promise<OfferingRecord[]> {
  const body = await call<{ offerings: OfferingRecord[] }>(
    'listOfferings',
    '/api/admin/licenses/offerings' +
      (appKey ? `?app=${encodeURIComponent(appKey)}` : ''),
  );
  return body.offerings ?? [];
}

export const getOffering = (appKey: string, code: string): Promise<OfferingRecord> =>
  call(
    'getOffering',
    `/api/admin/licenses/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
  );

export const createOffering = (
  body: {
    app_key: string;
    code: string;
    name: string;
    byo_mode: ByoMode;
  } & Record<string, unknown>,
): Promise<OfferingRecord> =>
  call('createOffering', '/api/admin/licenses/offerings', {
    method: 'POST',
    ...json(body),
  });

export const deleteOffering = (appKey: string, code: string): Promise<void> =>
  call(
    'deleteOffering',
    `/api/admin/licenses/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
    { method: 'DELETE' },
  );

/** Materialize an offering onto a tenant (posture + billing markup + charge). */
export const provisionTenantOffering = (
  nameOrId: string,
  appKey: string,
  code: string,
): Promise<unknown> =>
  call(
    'provisionTenantOffering',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
    { method: 'POST' },
  );

export const unprovisionTenantOffering = (
  nameOrId: string,
  appKey: string,
  code: string,
): Promise<unknown> =>
  call(
    'unprovisionTenantOffering',
    `/api/admin/licenses/tenants/${encodeURIComponent(nameOrId)}/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
    { method: 'DELETE' },
  );

// ---------------------------------------------------------------------------
// Cross-tenant budget (super-admin).
//
// These three endpoints have existed on the backend since the licensing
// console shipped and had ZERO frontend callers — a whole capability built,
// gated, tested and then unreachable. The tenant-scoped `/api/me/budget/*`
// equivalents were wired up; their cross-tenant siblings were not.
// ---------------------------------------------------------------------------

/** `GET /api/admin/licenses/budget/:tenantId` — one tenant's aggregate budget. */
export async function fetchTenantBudget(tenantId: string): Promise<BudgetStatusResponse> {
  const r = await authFetch(
    `/api/admin/licenses/budget/${encodeURIComponent(tenantId)}`,
  );
  if (!r.ok) throw new Error(`fetchTenantBudget: ${r.status}${await suffixOf(r)}`);
  return (await r.json()) as BudgetStatusResponse;
}

/** `GET /api/admin/licenses/budget-packages` — the top-up options. */
export async function fetchAdminBudgetPackages(): Promise<TopUpPackageList> {
  const r = await authFetch('/api/admin/licenses/budget-packages');
  if (!r.ok) throw new Error(`fetchAdminBudgetPackages: ${r.status}${await suffixOf(r)}`);
  return parseTopUpPackageList(await r.json());
}

/** `POST /api/admin/licenses/budget/topup/:tenantId` — top up ANY tenant. */
export async function topUpTenantBudget(
  tenantId: string,
  packageId: string,
  idempotencyKey: string,
): Promise<void> {
  const r = await authFetch(
    `/api/admin/licenses/budget/topup/${encodeURIComponent(tenantId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package_id: packageId, idempotency_key: idempotencyKey }),
    },
  );
  if (!r.ok) throw new Error(`topUpTenantBudget: ${r.status}${await suffixOf(r)}`);
}

/** Shared error suffix — shape-aware, so an integration envelope is readable. */
async function suffixOf(r: Response): Promise<string> {
  const detail = await errorDetailOf(r);
  return detail ? ` — ${detail}` : '';
}

/**
 * What a budget reset ACTUALLY did.
 *
 * `reset_count` is the number of budget rows zeroed (0 is a legitimate answer),
 * and `previous_consumed_total` is the consumed figure the reset destroyed. The
 * console states both — a resolved promise is not "the budget is clean", it is
 * "billing answered", and the two differ when nothing matched the tenant.
 */
export interface BudgetResetResult {
  tenant_id: string;
  reset_count: number;
  budget_ids: string[];
  previous_consumed_total: number;
}

/**
 * `POST /api/admin/licenses/budget/reset/:tenantId` — zero EVERY consumed
 * counter the tenant holds. The allowances survive; only the meter is reset.
 *
 * `reason` goes into billing's audit trail; pass `null` when the operator gave
 * none rather than inventing one.
 */
export async function resetTenantBudget(
  tenantId: string,
  reason: string | null,
): Promise<BudgetResetResult> {
  const r = await authFetch(
    `/api/admin/licenses/budget/reset/${encodeURIComponent(tenantId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );
  if (!r.ok) throw new Error(`resetTenantBudget: ${r.status}${await suffixOf(r)}`);
  return (await r.json()) as BudgetResetResult;
}

/**
 * One licence's override, as licences echoes it. Every field is optional
 * because the response shape is upstream's, and the console re-reads the
 * tenant's budget afterwards rather than treating this body as the new state.
 */
export interface LicenseBudgetOverrideResult {
  license_id?: string;
  token_budget_override?: number | null;
  [key: string]: unknown;
}

/**
 * `PATCH /api/admin/licenses/budget/line/:licenseId` — set ONE licence's token
 * budget override, or CLEAR it.
 *
 * `null` is an instruction (drop the override; the plan's allowance applies
 * again), not "leave it alone" — send the current value if no change is meant.
 */
export async function setLicenseBudgetOverride(
  licenseId: string,
  tokenBudgetOverride: number | null,
  reason: string | null = null,
): Promise<LicenseBudgetOverrideResult> {
  const r = await authFetch(
    `/api/admin/licenses/budget/line/${encodeURIComponent(licenseId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_budget_override: tokenBudgetOverride, reason }),
    },
  );
  if (!r.ok) throw new Error(`setLicenseBudgetOverride: ${r.status}${await suffixOf(r)}`);
  return (await r.json()) as LicenseBudgetOverrideResult;
}
