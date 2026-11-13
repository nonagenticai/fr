// src/services/licenses.ts
import { config } from '../config';
import {
  getLicensesAuthenticator,
  getSecureAppsAuthenticator,
} from '../lib/service-authenticators';
import {
  getCorrelationId,
  getSubjectId,
  getTenantId,
} from '../integrations/_lib/context';
import { IntegrationError } from '../integrations/_lib/errors';
import {
  ADMIN_TOKEN_TYPES,
  DEFAULT_ADMIN_TOKEN_EXPIRES_DAYS,
  MAX_ADMIN_TOKEN_EXPIRES_DAYS,
  type AdminTokenType,
} from '../lib/admin-token-limits';

/**
 * Licenses Service Client
 * 
 * Integrates with the external Licenses API for license management.
 * Uses OAuth2 Client Credentials flow with access-licenses role.
 */

/**
 * The failure every non-2xx response from the licenses service raises.
 *
 * WHY A CLASS AND NOT A BARE `Error`: the licenses service answers some
 * refusals with a STRUCTURED body that names what went wrong and what to do
 * about it — e.g. rotation on a license whose tokens have all expired returns
 *
 *   409 {"detail": {"error": "all_tokens_expired",
 *                   "license_id": "…",
 *                   "remedy": "mint a new token via POST /licenses/{id}/tokens"}}
 *
 * That body is the whole point of the upstream fix that produced it; flattening
 * it into a message string threw the remedy away, and the user saw
 * "regenerate failed: 500". Carrying `upstreamStatus` / `upstreamBody` lets
 * `wrapLicensesError` hand the structure to `integrationErrorResponse`, which
 * already knows how to render it.
 *
 * THE MESSAGE IS DELIBERATELY UNCHANGED, byte for byte. Two call sites decide
 * "this subject simply has no licenses" by matching `/\(404\)/` against
 * `e.message` (`listLicensesForSubject` here and `adminListLicensesForSubject`
 * below), and `wrapLicensesError` recovers the status from the same text when
 * it is handed a plain `Error`. Changing the wording would turn an empty state
 * into an error banner. Subclassing `Error` keeps every `instanceof Error`
 * guard and every regex on `.message` working exactly as before.
 */
/**
 * Is this a TRANSPORT failure — the request never got an answer — as opposed to
 * an answer we did not like?
 *
 * The distinction is the whole point. A 404 from licences is an ANSWER ("this
 * tenant holds no licence") and must be believed immediately. An `ECONNRESET` is
 * not an answer at all, and treating it as one is how a momentary blip became a
 * total outage: `requireFrLicense` fails closed on ANY throw, so one reset
 * connection denied every gated route in fr with `fr_license_required`.
 *
 * Matched on `code` first because that is what Bun/undici set, with a message
 * fallback for the shapes that carry no code.
 */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof LicensesUpstreamError) return false; // a real HTTP status
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ECONNABORTED',
      'EPIPE',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code);
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /socket connection was closed|socket hang up|connection (closed|reset|refused)|network|fetch failed|timed? ?out/i.test(
    message,
  );
}

/**
 * Run `attempt` up to three times, retrying ONLY transport failures.
 *
 * WHY THIS EXISTS, measured 2026-08-22. The `licenses` Deployment was 1/2: the
 * replica on `worker2` (which also hosts 9 dind CI runners, limits 343%
 * overcommitted) was CPU-starved enough to RST its own connections and never
 * pass a 1s startup probe. While it flapped through Endpoints, fr's entitlement
 * checks drew `ECONNRESET` — and because the gate fails closed on any throw,
 * every route in fr answered 403 `fr_license_required` for an authenticated user
 * whose licence was perfectly valid and ACTIVE in the database.
 *
 * A single retry would have crossed to the healthy replica: the Service
 * load-balances per connection, so the next attempt is a fresh pick.
 *
 * Bounded on purpose. Two extra attempts with 50ms/150ms backoff adds at most
 * ~200ms to the failing path and nothing at all to the happy one. Retrying a
 * STATUS would be wrong — that is an answer, and re-asking will not change it.
 */
export async function withTransportRetry<T>(
  attempt: () => Promise<T>,
  context: string,
): Promise<T> {
  const backoffMs = [50, 150];
  let lastError: unknown;
  for (let i = 0; i <= backoffMs.length; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isTransportFailure(err)) throw err;
      lastError = err;
      if (i === backoffMs.length) break;
      console.warn(
        `[licenses] transport failure on ${context} (attempt ${i + 1}/${backoffMs.length + 1}), retrying: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs[i]));
    }
  }
  throw lastError;
}

export class LicensesUpstreamError extends Error {
  readonly upstreamStatus: number;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  readonly upstreamBody: unknown;

  constructor(status: number, bodyText: string) {
    super(`Licenses API error (${status}): ${bodyText}`);
    this.name = 'LicensesUpstreamError';
    this.upstreamStatus = status;
    let parsed: unknown = bodyText;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Not JSON (an ingress HTML error page, an empty body). Keep the text —
      // a caller that renders it still shows something true.
    }
    this.upstreamBody = parsed;
  }
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

export interface RegenerateTokenResponse {
  token: string;
  message: string;
}

/**
 * Subset of the licenses service `TokenIntrospectResponse` returned by
 * `GET /licenses/active` (200). Only the fields the fr status surface needs.
 */
export interface ActiveLicenseDetail {
  active: boolean;
  status: string | null;
  expires_at: string | null;
  plan: { code?: string; name?: string } | null;
}

class LicensesClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.LICENSES_SERVICE_URL || process.env.LICENSES_URL || '';
  }

  /**
   * Make authenticated request to Licenses API
   * Uses ServiceAuthenticator for OAuth2 client credentials flow
   *
   * Mirrors portal-bff's `_upstream_auth_headers` pattern (routes/licenses.py:20-34):
   * service-account Bearer for the role gate (license-reader/admin), plus
   * X-Subject-Id + X-Tenant-Id for end-user scoping. Read from the request
   * context ALS so per-user scoping flows through Promise.all parallel calls.
   */
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const authenticator = getLicensesAuthenticator();
    const url = `${this.baseUrl}${path}`;

    const sub = getSubjectId();
    const tenant = getTenantId();
    const cid = getCorrelationId();
    const identityHeaders: Record<string, string> = {};
    if (sub) identityHeaders['X-Subject-Id'] = sub;
    if (tenant) identityHeaders['X-Tenant-Id'] = tenant;
    if (cid) identityHeaders['X-Correlation-Id'] = cid;

    const response = await authenticator.authenticatedFetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...identityHeaders,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LicensesUpstreamError(response.status, error);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  // NOTE: getUserLicense / validateUserLicense / upgradeLicense / hasFeature
  // were removed. They all targeted `/api/licenses/user/...`, a path the
  // licenses service does not serve (it exposes `/licenses/...`, unversioned
  // and with no `/api` prefix), and nothing in fr called them.

  /**
   * List all licenses owned by a Keycloak subject.
   *
   * Mirrors portal-bff's `list_licenses` (src/routes/licenses.py:64-95): a
   * 404 from the licenses service means "user has no licenses yet" rather
   * than "error" — return an empty array so the UI can render an empty
   * state instead of an error banner.
   */
  async listLicensesForSubject(
    keycloakSub: string,
    opts: { tenantId?: string } = {},
  ): Promise<LicenseRecord[]> {
    // Per-call X-Tenant-Id override. Defaults to ALS-derived tenant when
    // unset (the upstream `request<T>` wrapper injects it). Pass an
    // explicit value when a super-admin needs to read licenses scoped to
    // a tenant other than their own (per-tenant breakdown table).
    const headers: Record<string, string> = {};
    if (opts.tenantId) headers['X-Tenant-Id'] = opts.tenantId;
    try {
      return await this.request<LicenseRecord[]>(
        `/licenses/user/${encodeURIComponent(keycloakSub)}`,
        Object.keys(headers).length > 0 ? { headers } : {},
      );
    } catch (e) {
      if (e instanceof Error && /\(404\)/.test(e.message)) return [];
      throw e;
    }
  }

  /**
   * Check whether a TENANT holds an active license for an app_key.
   *
   * Backs the per-tenant fr package gate (see `lib/require-fr-license.ts`).
   * Calls the licenses service's `GET /licenses/active?tenant_id=&app_key=`
   * — the endpoint purpose-built for "JWT-mode" entitlement resolution (the
   * end user authenticates with a Keycloak JWT, not an opaque token, so we
   * look up by identity+app instead of introspecting a token).
   *
   * AUTH: this endpoint is gated by `require_internal_service`
   * (metering-internal / onboarding-internal / license-admin). fr's default
   * licenses authenticator (portal realm, `access-licenses`) does NOT carry
   * any of those, so we MUST use `getSecureAppsAuthenticator()` — its
   * service account holds `metering-internal` + `license-admin`. `tenant_id`
   * is the query param (not the X-Tenant-Id header), so no identity-header
   * forwarding is needed.
   *
   * Returns: true (active license exists), false (404 — none). A 409
   * (multiple active licenses — a data conflict with no DB unique constraint
   * on the pair) is treated as entitled+logged: the tenant clearly has at
   * least one active license. Any other status throws so the caller can
   * fail closed.
   */
  async hasActiveLicense(tenantId: string, appKey: string): Promise<boolean> {
    const url =
      `${this.baseUrl}/licenses/active` +
      `?tenant_id=${encodeURIComponent(tenantId)}` +
      `&app_key=${encodeURIComponent(appKey)}`;

    // Retries TRANSPORT failures only — see `withTransportRetry`. This call
    // backs the package licence gate, which fails closed, so an unanswered
    // request here forbids every gated route in fr.
    const response = await withTransportRetry(
      () =>
        getSecureAppsAuthenticator().authenticatedFetch(url, {
          headers: { 'Content-Type': 'application/json' },
        }),
      `hasActiveLicense(${appKey})`,
    );

    if (response.status === 200) return true;
    if (response.status === 404) return false;
    if (response.status === 409) {
      console.warn(
        `[licenses] multiple active '${appKey}' licenses for tenant ${tenantId} ` +
          `(409 data conflict) — treating as entitled`,
      );
      return true;
    }
    const body = await response.text().catch(() => '');
    throw new LicensesUpstreamError(response.status, body);
  }

  /**
   * Resolve the ACTIVE license record for (tenant, app) with its detail —
   * the same `GET /licenses/active` the boolean gate uses, but returning the
   * introspection body (`expires_at`, `status`, `plan`) so the status surface
   * can derive `expiring_soon` and show a real expiry date.
   *
   * Returns:
   *   - the detail object when an active license exists (200),
   *   - `{ conflict: true }` on 409 (multiple active — entitled, expiry unknown),
   *   - `null` on 404 (no ACTIVE license — caller refines expired/revoked/none
   *     via `listLicensesForSubject`).
   * Throws on any other status so the caller can decide (the status endpoint
   * fails soft to `state:'unknown'`).
   */
  async getActiveLicenseDetail(
    tenantId: string,
    appKey: string,
  ): Promise<ActiveLicenseDetail | { conflict: true } | null> {
    const url =
      `${this.baseUrl}/licenses/active` +
      `?tenant_id=${encodeURIComponent(tenantId)}` +
      `&app_key=${encodeURIComponent(appKey)}`;

    const response = await withTransportRetry(
      () =>
        getSecureAppsAuthenticator().authenticatedFetch(url, {
          headers: { 'Content-Type': 'application/json' },
        }),
      `getActiveLicenseDetail(${appKey})`,
    );

    if (response.status === 200) {
      return (await response.json()) as ActiveLicenseDetail;
    }
    if (response.status === 404) return null;
    if (response.status === 409) return { conflict: true };
    const body = await response.text().catch(() => '');
    throw new LicensesUpstreamError(response.status, body);
  }

  /**
   * Regenerate a license's API token.
   *
   * Returns the new raw token value ONCE — it is never persisted in
   * plaintext server-side, so this is the only opportunity for the user
   * to copy it.
   */
  async regenerateToken(
    licenseId: string,
    tenantOverride?: string,
  ): Promise<RegenerateTokenResponse> {
    const headers: Record<string, string> = {};
    if (tenantOverride) headers['X-Tenant-Id'] = tenantOverride;
    const path = `/licenses/${encodeURIComponent(licenseId)}/regenerate-token`;
    try {
      return await this.request<RegenerateTokenResponse>(path, {
        method: 'POST',
        headers,
      });
    } catch (e) {
      // Rotation is the one licenses call whose REFUSALS are actionable by the
      // person who clicked the button: 409 `all_tokens_expired` means "mint a
      // token explicitly instead", and 409 `license_not_active` means "renew
      // first" — opposite remedies, so a caller that cannot tell them apart
      // strands the user on one of them. `wrapLicensesError` turns this into an
      // IntegrationError carrying the upstream status AND body, which
      // `integrationErrorResponse` renders. Note the `await` above: without it
      // the promise rejects after this try block has already returned and the
      // catch never runs.
      wrapLicensesError(e, { method: 'POST', path });
    }
  }

  /**
   * Public-shape helper: pull `request<T>` so non-class call sites can
   * reach the same auth + identity-header pipeline without duplicating it.
   * Internal use only (super-admin write helpers below).
   */
  async _request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return this.request<T>(path, options);
  }

  /**
   * ADMIN-scoped request — the licenses admin surface (`license-admin`).
   *
   * Two deliberate differences from `request<T>`:
   *
   * 1. SECURE-APPS authenticator, not portal. This is the financial-services
   *    auth boundary the admin catalog/grant writes are meant to cross. The
   *    secure-apps `fr-backend` service account carries `license-admin`
   *    (+ `service-internal`, `metering-internal`); verified live via kcadm
   *    2026-07-17:
   *      kcadm get users/<sa>/role-mappings/realm -r secure-apps
   *        -> license-admin, service-internal, metering-internal,
   *           default-roles-secure-apps
   *    This is the same authenticator `hasActiveLicense` already uses for the
   *    `require_internal_service`-gated `/licenses/active`.
   *
   *    NB (2026-07-20): the PORTAL `fr-backend` SA is NOT role-starved — it
   *    carries `license-admin` + `license-reader` + `license-manager` in the
   *    portal realm (minted+decoded live). So the portal-authed `regenerateToken`
   *    used by the grant/provision token mint does NOT 403; routing it through
   *    this admin request would be a consistency nicety, not a correctness fix.
   *    (An earlier version of this comment claimed the portal `fr-frontend`
   *    client "carries only access-licenses" — wrong client, wrong roles.)
   *
   * 2. NO ambient `X-Tenant-Id` from the ALS context. `request<T>` injects the
   *    CALLER's tenant, which is right for per-user reads and wrong here: these
   *    are platform-scoped operations, and an ambient tenant would silently
   *    scope a catalog read — or worse, mint a license into the super-admin's
   *    own tenant instead of the target's. Tenant is always passed EXPLICITLY
   *    via `options.headers` at the call sites that need it.
   *
   * Correlation id still rides along for tracing.
   */
  async _adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
    return (await this._adminRequestWithStatus<T>(path, options)).body;
  }

  /** `_adminRequest`, also answering the 2xx status (e.g. 200 vs 201 on an idempotent create). */
  async _adminRequestWithStatus<T>(path: string, options: RequestInit = {}): Promise<{ status: number; body: T }> {
    const url = `${this.baseUrl}${path}`;
    const cid = getCorrelationId();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cid) headers['X-Correlation-Id'] = cid;

    const response = await getSecureAppsAuthenticator().authenticatedFetch(url, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LicensesUpstreamError(response.status, error);
    }
    if (response.status === 204) {
      return { status: 204, body: {} as T };
    }
    return { status: response.status, body: (await response.json()) as T };
  }
}

export const licensesClient = new LicensesClient();

// ============================================================================
// Super-admin write helpers (Spec 2 — Task 3)
// ============================================================================
//
// These reach the licenses service's app/plan/license-create endpoints to
// support the super-admin user-provisioning orchestration. They reuse the
// exported `licensesClient` so authentication + identity-header forwarding
// stay identical to the read paths above.
//
// FIELD-SHAPE NOTES (verified against ~/licenses/main.py):
//
// - `GET /apps` → `AppResponse[]` with shape
//     {id, key, name, description, revoked, created_at}
//   The plan brief named the human-key field `code`, but upstream calls it
//   `key`. We expose `key` faithfully and let callers map.
//
// - `GET /apps/{app_id}/plans` → `PlanResponse[]` with shape
//     {id, app_id, code, name, description, region_id, duration_days,
//      rate_limit_*, quota_monthly, token_budget_monthly, revoked,
//      created_at}
//
// - `POST /licenses/user/{subject_id}` → `LicenseResponse` (NOT a token).
//   The plan's stated return shape `{license_id, token, plan_id, tenant_id}`
//   was wrong — the licenses service mints tokens via a *separate* call
//   (`POST /licenses/{license_id}/tokens` or
//    `POST /licenses/{license_id}/regenerate-token`). The body shape is
//   `LicenseCreate = {app_id, plan_id, region_id?, starts_at?, expires_at?,
//   metadata?}` — there is no `description` field upstream and `tenant_id`
//   is taken from the X-Tenant-Id header (forwarded by the request<T>
//   wrapper above), NOT from the body. We accept `tenantId` as input and
//   route it through an explicit override header so the orchestrator can
//   provision into a tenant other than the caller's default.

export interface AppSummary {
  id: string;
  key: string;
  name: string;
}

export interface PlanSummary {
  id: string;
  code: string;
  app_id: string;
  revoked: boolean;
}

export interface CreateLicenseInput {
  subjectId: string;
  appId: string;
  planId: string;
  /**
   * Tenant the license is provisioned for. Sent as the X-Tenant-Id header
   * — `LicenseCreate` upstream has no `tenant_id` body field.
   */
  tenantId?: string;
  /**
   * Free-form provenance string. Upstream `LicenseCreate` has no
   * `description` field, so this is folded into the `metadata` blob
   * (which DOES exist) under the key `description`.
   */
  description?: string;
}

export interface CreateLicenseResult {
  license_id: string;
  subject_id: string;
  tenant_id: string;
  app_id: string;
  plan_id: string;
}

/**
 * The refusal codes licences' per-app ownership rules (migration 050) answer
 * with, in `{"detail": {"error": <code>, ...}}`, and what each means for fr.
 * Since 050 tenant names are unique PER OWNING APP (the owner is derived from
 * fr's Keycloak client, never sent), `POST /tenants` is no longer idempotent by
 * name, and fr may mint only apps it issues, on tenants it owns or holds a
 * grant on. Each refusal is permanent until licences' data changes, so it is
 * surfaced with its reason — never retried, never answered with a fallback.
 */
export const LICENCES_OWNERSHIP_REFUSALS: Readonly<Record<string, string>> = {
  tenant_name_taken:
    'fr already has a licences tenant with this name (tenant names are unique per owning app)',
  tenant_owned_by_other_app:
    'this tenant id is registered to a different owning app',
  tenant_owner_only: "only the tenant's owning app may do this; a grant does not",
  tenant_not_accessible:
    'the tenant is neither owned by fr nor granted to fr in licences',
  app_not_issuable_by_caller: "fr may not issue this app's licences",
  unknown_api_client:
    "fr's licences client is not registered as an owning app (api_client)",
};

/** The licences refusal code in an upstream body (`detail.error`), if any. */
export function licencesRefusalCode(upstreamBody: unknown): string | undefined {
  if (!upstreamBody || typeof upstreamBody !== 'object') return undefined;
  const detail = (upstreamBody as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const code = (detail as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Wrap the legacy `Licenses API error (NNN): …` Error from `request<T>`
 * into an IntegrationError so callers can switch on `code` /
 * `upstreamStatus` consistently with the rest of the integrations layer.
 */
function wrapLicensesError(
  err: unknown,
  ctx: { method: string; path: string },
): never {
  if (err instanceof IntegrationError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  // Prefer the status the response actually carried. The regex below is the
  // fallback for anything that reached here as a plain `Error` — it reads the
  // status back out of the formatted message, which works but cannot recover
  // the BODY, and the body is what a caller needs to explain the refusal.
  const upstreamBody =
    err instanceof LicensesUpstreamError ? err.upstreamBody : undefined;
  const status =
    err instanceof LicensesUpstreamError
      ? err.upstreamStatus
      : (() => {
          const m = /\((\d{3})\)/.exec(msg);
          return m ? Number(m[1]) : undefined;
        })();
  let code:
    | 'UPSTREAM_NOT_FOUND'
    | 'UPSTREAM_UNAUTHORIZED'
    | 'UPSTREAM_FORBIDDEN'
    | 'UPSTREAM_CONFLICT'
    | 'UPSTREAM_BAD_STATUS' = 'UPSTREAM_BAD_STATUS';
  if (status === 401) code = 'UPSTREAM_UNAUTHORIZED';
  else if (status === 403) code = 'UPSTREAM_FORBIDDEN';
  else if (status === 404) code = 'UPSTREAM_NOT_FOUND';
  else if (status === 409) code = 'UPSTREAM_CONFLICT';
  // A licences OWNERSHIP refusal (migration 050) gets a message that names the
  // reason, so the operator reads "fr may not issue this app's licences" rather
  // than a bare status. The status (403/409) and the body are passed through
  // unchanged; the raw body stays available as `upstream.body`.
  const refusal = licencesRefusalCode(upstreamBody);
  const explained =
    refusal !== undefined && (status === 403 || status === 409)
      ? LICENCES_OWNERSHIP_REFUSALS[refusal]
      : undefined;
  throw new IntegrationError({
    code,
    message: explained
      ? `licences refused ${ctx.method} ${ctx.path} (${status} ${refusal}): ${explained}`
      : msg,
    service: 'licenses',
    method: ctx.method,
    path: ctx.path,
    upstreamStatus: status,
    upstreamBody,
    cause: err,
  });
}

/** GET /apps — projected to the minimal shape the super-admin UI needs. */
export async function listApps(): Promise<AppSummary[]> {
  try {
    const raw = await licensesClient._request<
      Array<{ id: string; key: string; name: string }>
    >(`/apps`);
    return raw.map((a) => ({ id: a.id, key: a.key, name: a.name }));
  } catch (e) {
    wrapLicensesError(e, { method: 'GET', path: '/apps' });
  }
}

/** GET /apps/{appId}/plans — projected to the minimal shape needed. */
export async function listPlans(appId: string): Promise<PlanSummary[]> {
  try {
    const raw = await licensesClient._request<
      Array<{ id: string; code: string; app_id: string; revoked: boolean }>
    >(`/apps/${encodeURIComponent(appId)}/plans`);
    return raw.map((p) => ({
      id: p.id,
      code: p.code,
      app_id: p.app_id,
      revoked: p.revoked,
    }));
  } catch (e) {
    wrapLicensesError(e, { method: 'GET', path: `/apps/${appId}/plans` });
  }
}

/**
 * POST /licenses/user/{subjectId} — create a license for a Keycloak subject.
 *
 * `tenantId` is sent as `X-Tenant-Id` (the upstream reads tenant from the
 * header, not the body). `description` is folded into `metadata.description`
 * because LicenseCreate has no top-level description field. The licenses
 * service does NOT return a token here — call `regenerateToken(licenseId)`
 * afterwards to mint one.
 */
export async function createLicense(
  input: CreateLicenseInput,
): Promise<CreateLicenseResult> {
  const body: Record<string, unknown> = {
    app_id: input.appId,
    plan_id: input.planId,
  };
  if (input.description) {
    body.metadata = { description: input.description };
  }

  const headers: Record<string, string> = {};
  if (input.tenantId) {
    headers['X-Tenant-Id'] = input.tenantId;
  }

  try {
    const resp = await licensesClient._request<{
      id: string;
      subject_id: string;
      tenant_id: string;
      app_id: string;
      plan_id: string;
    }>(`/licenses/user/${encodeURIComponent(input.subjectId)}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    });

    return {
      license_id: resp.id,
      subject_id: resp.subject_id,
      tenant_id: resp.tenant_id,
      app_id: resp.app_id,
      plan_id: resp.plan_id,
    };
  } catch (e) {
    wrapLicensesError(e, {
      method: 'POST',
      path: `/licenses/user/${input.subjectId}`,
    });
  }
}

// ---------------------------------------------------------------------------
// LICENSES ADMIN SURFACE — backs the super-admin console
// (frontend `/admin/licenses`, routes `routes/admin/licenses-admin.ts`).
//
// Every function below goes through `licensesClient._adminRequest`, i.e. the
// SECURE-APPS service account (`license-admin`) with NO ambient tenant header.
// See `_adminRequest` for why both of those matter.
//
// FIELD SHAPES verified against the licenses service source (`main.py` +
// `models.py`) on 2026-07-17 — there is no shared types package, so these are
// hand-mirrored. Gotchas worth keeping in mind when editing:
//
//   * `GET /offerings` returns a WRAPPER `{offerings: [...]}`, while
//     `GET /tenants`, `GET /apps`, `GET /plans`, `GET /regions` return BARE
//     arrays. Not a typo — mirror it faithfully.
//   * `POST /licenses/user/{id}` takes tenant from the `X-Tenant-Id` HEADER;
//     `LicenseCreate` has no tenant_id body field.
//   * Creating a license does NOT mint a token — that is a second call
//     (`regenerate-token` / `POST /licenses/{id}/tokens`).
//   * `GET /tenants/{id}/byo-mode` is deliberately UNAUTHENTICATED upstream
//     (an S2S lookup worker_management relies on); we still route it through
//     the admin path for one consistent seam.
//   * `DELETE /apps/{id}` is a HARD CASCADE (plans -> licenses -> tokens).
//     `DELETE /plans/{id}` is not — it 409s when licenses reference the plan.
//     That asymmetry is upstream's, and the UI must surface it honestly.
// ---------------------------------------------------------------------------

/** `AppResponse` — GET /apps, GET /apps/{id}, POST /apps. */
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

/** `PlanResponse` — GET /plans, GET /apps/{id}/plans, POST /plans, PATCH /plans/{id}. */
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

/** `RegionResponse` — GET /regions, POST /regions. */
export interface RegionRecord {
  id: string;
  code: string;
  name: string;
  active: boolean;
  created_at: string;
}

/** `Tenant.to_dict()` — GET /tenants, GET /tenants/{name_or_id}, POST /tenants. */
export interface TenantRecord {
  id: string;
  name: string;
  keycloak_realm: string | null;
  byo_mode: string;
  created_at: string | null;
  /**
   * When the tenant was archived, or null while it is live.
   *
   * Archiving REVOKES NOTHING upstream — licences, tokens and budgets survive
   * and existing tokens keep authenticating. It is a "do not provision here"
   * flag, nothing more. Optional because a licences deployment older than the
   * archive migration omits the field entirely; treating `undefined` as
   * "archived" would hide every tenant on such a deployment.
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
   * The app that OWNS this tenant in licences (migration 050) — `fr`,
   * `commonpractice`, `platform`, … Tenant names are unique per owner, so two
   * apps can each have an `acme`. Optional: a licences deployment predating 050
   * omits it.
   */
  owner_key?: string;
  /**
   * The owning app's own stable id for the tenant (fr sends its tenant slug), or
   * null. `POST /tenants` is idempotent on (owner, external_ref) — never on name.
   */
  external_ref?: string | null;
}

/** `Offering.to_dict()` — the entries inside `{offerings: [...]}`. */
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

/** `TokenCreateResponse` — POST /licenses/{id}/tokens. Raw token returned ONCE. */
export interface TokenCreateResult {
  token_id: string;
  license_id: string;
  token: string;
  token_type: string;
  created_at: string;
  expires_at: string | null;
}

const adminReq = <T>(path: string, options: RequestInit = {}): Promise<T> =>
  licensesClient._adminRequest<T>(path, options);

/** Wrap an upstream failure with the method+path that produced it. */
async function admin<T>(
  method: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  try {
    return await adminReq<T>(path, { method, ...options });
  } catch (e) {
    wrapLicensesError(e, { method, path });
  }
}

const tenantHeader = (tenantId?: string): Record<string, string> =>
  tenantId ? { 'X-Tenant-Id': tenantId } : {};

// ----- catalog: apps -------------------------------------------------------

export const adminListApps = (): Promise<AppRecord[]> =>
  admin<AppRecord[]>('GET', '/apps');

export const adminGetApp = (appId: string): Promise<AppRecord> =>
  admin<AppRecord>('GET', `/apps/${encodeURIComponent(appId)}`);

export const adminCreateApp = (body: {
  key: string;
  name: string;
  description?: string | null;
}): Promise<AppRecord> =>
  admin<AppRecord>('POST', '/apps', { body: JSON.stringify(body) });

/**
 * HARD CASCADE — removes the app's plans, licenses AND tokens. Upstream applies
 * no "still referenced" guard here (unlike delete_plan). Callers must confirm.
 */
export const adminDeleteApp = (appId: string): Promise<void> =>
  admin<void>('DELETE', `/apps/${encodeURIComponent(appId)}`);

export const adminListAppLicenses = (appId: string): Promise<LicenseRecord[]> =>
  admin<LicenseRecord[]>('GET', `/apps/${encodeURIComponent(appId)}/licenses`);

// ----- catalog: plans ------------------------------------------------------

export const adminListPlans = (): Promise<PlanRecord[]> =>
  admin<PlanRecord[]>('GET', '/plans');

export const adminListAppPlans = (appId: string): Promise<PlanRecord[]> =>
  admin<PlanRecord[]>('GET', `/apps/${encodeURIComponent(appId)}/plans`);

export const adminGetPlan = (planId: string): Promise<PlanRecord> =>
  admin<PlanRecord>('GET', `/plans/${encodeURIComponent(planId)}`);

export const adminCreatePlan = (body: {
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
  admin<PlanRecord>('POST', '/plans', { body: JSON.stringify(body) });

export const adminUpdatePlan = (
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
): Promise<PlanRecord> =>
  admin<PlanRecord>('PATCH', `/plans/${encodeURIComponent(planId)}`, {
    body: JSON.stringify(body),
  });

/** 409 upstream when licenses still reference the plan — surfaced as UPSTREAM_CONFLICT. */
export const adminDeletePlan = (planId: string): Promise<void> =>
  admin<void>('DELETE', `/plans/${encodeURIComponent(planId)}`);

// ----- catalog: regions ----------------------------------------------------

export const adminListRegions = (): Promise<RegionRecord[]> =>
  admin<RegionRecord[]>('GET', '/regions');

export const adminCreateRegion = (body: {
  code: string;
  name: string;
  active?: boolean;
}): Promise<RegionRecord> =>
  admin<RegionRecord>('POST', '/regions', { body: JSON.stringify(body) });

// ----- licenses ------------------------------------------------------------

/** Every license platform-wide (`GET /licenses/admin/all`). */
export const adminListAllLicenses = (): Promise<LicenseRecord[]> =>
  admin<LicenseRecord[]>('GET', '/licenses/admin/all');

/**
 * Licenses held by one Keycloak subject. A 404 upstream means "no licenses
 * yet" for a subject the registry has never seen — an empty state, not an
 * error (same convention as `listLicensesForSubject`).
 */
export async function adminListSubjectLicenses(
  subjectId: string,
  tenantId?: string,
): Promise<LicenseRecord[]> {
  try {
    return await adminReq<LicenseRecord[]>(
      `/licenses/user/${encodeURIComponent(subjectId)}`,
      { method: 'GET', headers: tenantHeader(tenantId) },
    );
  } catch (e) {
    if (e instanceof Error && /\(404\)/.test(e.message)) return [];
    wrapLicensesError(e, {
      method: 'GET',
      path: `/licenses/user/${subjectId}`,
    });
  }
}

/**
 * Mint a license for a subject. `tenantId` rides the X-Tenant-Id header
 * (upstream `LicenseCreate` has no tenant_id field). Returns NO token — call
 * `adminMintToken` (or `regenerateToken`) afterwards.
 */
export const adminCreateLicense = (
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
): Promise<LicenseRecord> =>
  admin<LicenseRecord>('POST', `/licenses/user/${encodeURIComponent(subjectId)}`, {
    body: JSON.stringify(body),
    headers: tenantHeader(tenantId),
  });

/** Delete EVERY license held by a subject. Returns `{deleted: n}`. */
export const adminDeleteSubjectLicenses = (
  subjectId: string,
  tenantId?: string,
): Promise<{ deleted: number }> =>
  admin<{ deleted: number }>(
    'DELETE',
    `/licenses/user/${encodeURIComponent(subjectId)}`,
    { headers: tenantHeader(tenantId) },
  );

// The token type / expiry bounds live in lib/admin-token-limits.ts (side-effect free,
// fr-agui P4c part 3: the mint-token body schema and its capability declaration
// read them without importing this module's config).
export {
  ADMIN_TOKEN_TYPES,
  DEFAULT_ADMIN_TOKEN_EXPIRES_DAYS,
  MAX_ADMIN_TOKEN_EXPIRES_DAYS,
  type AdminTokenType,
} from '../lib/admin-token-limits';

/**
 * Mint an additional token for an existing license. Raw token returned ONCE.
 *
 * ⛔ fr#1372: upstream `POST /licenses/{id}/tokens` reads `token_type` and
 * `expires_days` from the QUERY STRING only and ignores the body entirely. This
 * previously sent them as JSON, so every fr-minted token silently fell back to
 * upstream's defaults — `api` and PERPETUAL. Both now ride the query, and the
 * expiry is always set (default {@link DEFAULT_ADMIN_TOKEN_EXPIRES_DAYS}).
 */
export const adminMintToken = (
  licenseId: string,
  opts: { token_type?: AdminTokenType; expires_days?: number } = {},
): Promise<TokenCreateResult> => {
  const expiresDays = opts.expires_days ?? DEFAULT_ADMIN_TOKEN_EXPIRES_DAYS;
  if (
    !Number.isInteger(expiresDays) ||
    expiresDays < 1 ||
    expiresDays > MAX_ADMIN_TOKEN_EXPIRES_DAYS
  ) {
    throw new RangeError(
      `expires_days must be an integer in 1..${MAX_ADMIN_TOKEN_EXPIRES_DAYS}`,
    );
  }
  const tokenType = opts.token_type ?? 'api';
  if (!(ADMIN_TOKEN_TYPES as readonly string[]).includes(tokenType)) {
    throw new RangeError(`token_type must be one of ${ADMIN_TOKEN_TYPES.join(', ')}`);
  }
  const query = new URLSearchParams({
    expires_days: String(expiresDays),
    token_type: tokenType,
  });
  return (async () => {
    const tenantId = await resolveLicenseTenant(licenseId);
    return admin<TokenCreateResult>(
      'POST',
      `/licenses/${encodeURIComponent(licenseId)}/tokens?${query.toString()}`,
      { headers: tenantHeader(tenantId) },
    );
  })();
};

/**
 * The tenant a license belongs to, read from the license itself.
 *
 * ⛔ fr#1378: upstream `POST /licenses/{id}/tokens` takes its tenant from
 * `Depends(get_tenant_id)` (the `X-Tenant-Id` header) and then requires
 * `str(license.tenant_id) == tenant_id`, answering 404 on a mismatch. fr sent no
 * header at all, so upstream answered 401 "Missing tenant" and the mint route
 * never worked. The tenant is taken from `GET /internal/licenses/{id}` (gated by
 * `require_internal_service`, which admits fr's secure-apps `license-admin` SA)
 * and NEVER from the caller: a tenant the caller could name would let the
 * caller pick which tenant's ownership check is run.
 */
async function resolveLicenseTenant(licenseId: string): Promise<string> {
  const path = `/internal/licenses/${encodeURIComponent(licenseId)}`;
  const lic = await admin<{ tenant_id?: unknown }>('GET', path);
  if (typeof lic?.tenant_id !== 'string' || lic.tenant_id === '') {
    // Upstream's column is NOT NULL, so this is defensive. Never mint without
    // the license's tenant: report the 200 body we actually received.
    wrapLicensesError(new LicensesUpstreamError(200, JSON.stringify(lic ?? null)), {
      method: 'GET',
      path,
    });
  }
  return lic.tenant_id;
}

/**
 * Revoke a license (by id) or a single raw token. Upstream `TokenRevokeRequest`
 * accepts EITHER `{license_id}` — revoking all of its tokens — or `{token}`.
 *
 * ⚠️ `tenantId` is REQUIRED in practice, and the failure mode is silent.
 *
 * Upstream gates on tenant ownership (`license.tenant_id != tenant_id`) and, on
 * mismatch, deliberately does NOT reveal that the license exists — it answers
 * **HTTP 200** with `{revoked: false, message: "License not found"}` and leaves
 * the license fully usable. Verified live 2026-07-17:
 *
 *   revoke WITHOUT X-Tenant-Id -> 200 {"revoked":false,...}  introspect: active=TRUE
 *   revoke WITH    X-Tenant-Id -> 200 {"revoked":true,...}   introspect: active=false
 *
 * So a status-only check reports a successful revoke over a license that still
 * works. `ok` must be DERIVED from the body, which is why this throws rather
 * than returning `revoked: false` for a caller to ignore.
 */
export async function adminRevoke(
  body: { license_id?: string; token?: string },
  tenantId?: string,
): Promise<{ revoked: boolean; message: string }> {
  const res = await admin<{ revoked: boolean; message: string }>(
    'POST',
    '/license/revoke',
    { body: JSON.stringify(body), headers: tenantHeader(tenantId) },
  );

  if (!res.revoked) {
    // A 200 that revoked nothing. Never let this reach the operator as success.
    //
    // ⚠️ `upstreamStatus: 200` is CORRECT and is not a mistake to "fix". The field
    // records what was RECEIVED; the code records the SEMANTIC fault. Verified in
    // the upstream source (licenses `main.py` `revoke_token_or_license`): every
    // `revoked:false` path returns HTTP 200 by design, and deliberately collapses
    // "no such token" and "not your tenant" into ONE message so this endpoint
    // cannot be used to probe another tenant for existence. fr must not invent a
    // 404 it never received — inventing an upstream status is the actual
    // anti-pattern here (see `read-models/_lib.ts`, "an upstream status for an
    // upstream that was never called"). Precedent for this pairing:
    // `keycloak-admin.ts` pairs `UPSTREAM_BAD_BODY` with `upstreamStatus: 201`.
    //
    // ⚠️ MESSAGE CORRECTED 2026-09-04, on two counts.
    //   - It hardcoded "The license". This function takes EITHER `token` or
    //     `license_id`, and via `handleRevoke` only the TOKEN arm now reaches it
    //     (a license revoke routes through `revokeLicenseById` so the billing
    //     quota is deregistered). Naming the resource unconditionally sent the
    //     operator to the wrong one, so it is derived from the request instead.
    //   - It advised "pass the license's own tenant_id". `handleRevoke` already
    //     HARD-REQUIRES `X-Target-Tenant-Id` and throws a `BadRequestError`
    //     naming it, so that could never be the cause of THIS throw. Remediation
    //     the code already enforces does not belong in the failure it cannot
    //     explain — it sends the reader to check something that is guaranteed.
    const subject = body.token ? 'token' : 'license';
    throw new IntegrationError({
      code: 'UPSTREAM_NOT_FOUND',
      message:
        `licenses-service refused the revoke: "${res.message}". The ${subject} is ` +
        `STILL ACTIVE. Upstream deliberately answers identically for "no such ` +
        `${subject}" and "${subject} belongs to another tenant", so this cannot ` +
        `distinguish the two.`,
      service: 'licenses',
      method: 'POST',
      path: '/license/revoke',
      upstreamStatus: 200,
    });
  }
  return res;
}

// ----- tenants + BYO mode --------------------------------------------------

/**
 * Every tenant. Archived ones are HIDDEN by default — that is the whole point
 * of the flag, so pick-lists built on this call stop offering a tenant nobody
 * should provision into. Pass `includeArchived` for the management screen,
 * which is the one place they must still be reachable (to restore one).
 *
 * `includeServiceActors` is the same idea for a second population. Upstream now
 * omits `kind='service'` rows by default — service-mesh auth principals, 33 of
 * the 59 live tenants, which migration 027 of the licences service defines as
 * "NOT a tenant in the commercial sense". Pick-lists are better without them.
 * The management screen is again the exception: it is the completeness view, so
 * it must ask for them or it silently under-reports the registry by more than
 * half.
 */
export const adminListTenants = (
  includeArchived = false,
  includeServiceActors = false,
): Promise<TenantRecord[]> => {
  const params = new URLSearchParams();
  if (includeArchived) params.set('include_archived', 'true');
  if (includeServiceActors) params.set('include_service_actors', 'true');
  const qs = params.toString();
  return admin<TenantRecord[]>('GET', `/tenants${qs ? `?${qs}` : ''}`);
};

export const adminGetTenant = (nameOrId: string): Promise<TenantRecord> =>
  admin<TenantRecord>('GET', `/tenants/${encodeURIComponent(nameOrId)}`);

/**
 * One licence's budget override — licences `PATCH /licenses/{license_id}/budget`.
 *
 * The licence is the unit that carries a budget override; the tenant's aggregate
 * is a SUM over per-licence budget rows (`license_sync`) plus any manual/top-up
 * rows, so an operator who needs to change one row's allowance has to name the
 * licence, not the tenant. `token_budget_override: null` CLEARS the override and
 * returns the licence to its plan's `token_budget_monthly`; it is not "leave it
 * alone".
 *
 * The upstream response is relayed unchanged: fr adds no semantics of its own
 * and the console re-reads the budget status afterwards rather than treating
 * this body as the new state.
 */
export interface LicenseBudgetOverrideBody {
  token_budget_override: number | null;
  /** Why the override changed; omitted when the operator gave none. */
  reason?: string | null;
}

export interface LicenseBudgetOverrideResult {
  license_id?: string;
  token_budget_override?: number | null;
  [key: string]: unknown;
}

export const adminSetLicenseBudget = (
  licenseId: string,
  body: LicenseBudgetOverrideBody,
): Promise<LicenseBudgetOverrideResult> =>
  admin<LicenseBudgetOverrideResult>(
    'PATCH',
    `/licenses/${encodeURIComponent(licenseId)}/budget`,
    { body: JSON.stringify(body) },
  );

/**
 * One per-(tenant, product) posture row, with the offering that produced it.
 *
 * ⚠️ `offering_code: null` does NOT mean "no offering". It means the provenance
 * is unknown — the posture was set directly rather than by provisioning an
 * offering, or it predates licences migration 025, which added the column and
 * could not backfill it because the code had never been recorded anywhere.
 * Render it as unknown, never as a blank cell: blank asserts "nothing
 * provisioned" about rows that may well have been.
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
 * What a tenant has been provisioned, per product.
 *
 * licences owns only HALF of what provisioning writes — the posture rows here,
 * and (S2S) the tenant's markup rule and access charge in billing. This is not
 * the tenant's billing picture.
 *
 * An empty array means NO per-product overrides, so every product resolves to
 * the tenant-wide `byo_mode` — read that from the tenant itself. A missing
 * tenant throws upstream rather than returning `[]`.
 */
export const adminListTenantOfferings = (
  nameOrId: string,
): Promise<TenantOfferingRecord[]> =>
  admin<TenantOfferingRecord[]>(
    'GET',
    `/tenants/${encodeURIComponent(nameOrId)}/offerings`,
  );

/**
 * `InternalSeatCountResponse` — `GET /internal/tenants/{id}/seat-count`.
 *
 * Hand-mirrored like `LicenseRecord`; verified field-for-field on 2026-09-23
 * against `git show origin/main:main.py` (the model at :7920-7958, the route at
 * :7967) — NOT against the working tree, which was 140 lines behind and cost an
 * earlier revision of this file three wrong claims. `origin/main` is also what
 * is RUNNING: the deployed pod's `/app/main.py` is byte-identical to it
 * (md5 `4e2f62f13c3fd38b4fdb696c52ac7ec2`, 8330 lines). ⛔ Do not re-verify this
 * from a local checkout or from `docs/openapi.json` — that file is GENERATED
 * from the same tree, so reading both is one instrument twice, not two.
 *
 * The first ten fields are REQUIRED on every branch — the archived branch
 * returns them all as zeros rather than a shorter object, deliberately, so no
 * caller has to test for a missing key.
 */
export interface SeatCountRecord {
  tenant_id: string;
  /** Licences that are stored-active AND started AND unexpired at `as_of`. */
  seats: number;
  /** DISTINCT subjects behind those licences — a PRINCIPAL, not a person. */
  subjects: number;
  human_subjects: number;
  service_subjects: number;
  unresolved_subjects: number;
  /**
   * `active_licences` | `tenant_archived` | `active_during_period`. Three
   * values, not two: the period-scoped count reports its own basis, so a 0 is
   * always attributable.
   */
  basis: string;
  tenant_kind: string;
  tenant_archived: boolean;
  /** ISO-8601; the instant the count was evaluated at. */
  as_of: string;
  /**
   * ⭐ THE PRODUCT THE COUNT IS SCOPED TO, echoed back. `null` means EVERY app.
   *
   * This is the field that makes an unscoped figure safe to display: the count
   * states its own basis, so a renderer never has to remember whether it passed
   * `app`. Render `null` as "all apps" — never as a per-product seat count.
   */
  app_key?: string | null;
  /**
   * Set together when the count was taken over a period
   * (`basis: 'active_during_period'`). fr does not request one yet — see
   * `adminTenantSeatCount` — so both read `null` today. Mirrored anyway so the
   * next reader recognises them as deliberately unrequested rather than missing.
   */
  period_start?: string | null;
  period_end?: string | null;
}

/**
 * A tenant's billable seat count. This is BILLING'S PER-SEAT DENOMINATOR
 * (`billing-service services/seats.py` reads the same endpoint), so fr is
 * reading the number the customer is invoiced on, not a display statistic.
 *
 * ⭐ THREE THINGS A CALLER OTHERWISE GETS WRONG.
 *
 * 1. `?app=` SCOPES THE COUNT TO ONE PRODUCT, AND WITHOUT IT THE NUMBER
 *    AGGREGATES EVERY APP THE TENANT HOLDS. Upstream's own words (the `app`
 *    Query description, `origin/main:main.py:7982-7990`): "Scope the count to
 *    ONE product by app key (e.g. 'commonpractice'). Without it a tenant's
 *    licences for every other app inflate a per-product seat count."
 *    ⛔ SO AN UNSCOPED FIGURE MUST BE LABELLED AS ALL-APPS and never rendered
 *    beside one product's name. The response echoes `app_key` (`null` = every
 *    app) precisely so a renderer can tell which it is holding without
 *    remembering what it asked.
 *    ⚠️ "Seats are minted per subject, apps are sold per tenant" is the reason
 *    this parameter is NEEDED, not evidence that it is absent. An earlier
 *    revision generalised from that sentence to "therefore no per-app count
 *    exists" and shipped a 400 refusing a capability the service has — a
 *    surface asserting something it could not see. Do not re-derive it.
 *
 * 2. AN UNKNOWN APP KEY IS **422 `app_not_found`**, DELIBERATELY NOT 404, AND AN
 *    UNKNOWN TENANT IS THE **404**. The two must not be merged, and upstream
 *    says why at both sites (`main.py:8062-8072`): billing's seats client reads
 *    a 404 as a DURABLE, CACHEABLE 0 and any other failure as "ask again", so a
 *    404 for a typo'd app key would silently zero a real tenant's invoice line.
 *    ⛔ This function therefore swallows NEITHER — unlike
 *    `adminListSubjectLicenses`, which converts its own 404 to `[]`. An operator
 *    screen rendering "0 seats" for a tenant or an app key that does not exist
 *    has answered a question nobody asked. Every non-2xx propagates as an
 *    `IntegrationError` via `admin`/`wrapLicensesError`.
 *
 * 3. `human_subjects` IS THE BILLABLE BASIS (the operator's ruling, 2026-09-11)
 *    — NOT `seats`, and NOT `subjects`, which counts machine accounts as
 *    colleagues (measured upstream: `ahtapol` and `cdmsfirst` each hold a
 *    `service`-realm robot subject, so 2 of 5 customer tenants would be billed
 *    $25/mo for a service account). `service_subjects` and
 *    `unresolved_subjects` DISCLOSE what `human_subjects` excluded, and the
 *    three partition `subjects` exactly:
 *      human_subjects + service_subjects + unresolved_subjects === subjects
 *    ⛔ Never fold `unresolved_subjects` into either of the other two. It counts
 *    subject ids with no `subject` row; it should always read 0, and a nonzero
 *    value is a SCHEMA REGRESSION worth seeing, not a seat. Summing it into
 *    `human_subjects` bills a ghost; summing it into `service_subjects` hides a
 *    broken FK. It exists precisely so an unknown is promoted to neither.
 *
 * `basis` is how a real 0 is told apart from an off tenant: `tenant_archived`
 * means the tenant is switched off (it accrues no seat charge), `active_licences`
 * with `seats: 0` means it genuinely holds none. Render the distinction.
 *
 * `asOf` counts at a past instant instead of now — required for a CLOSED billing
 * period, which must never be recounted at whenever the query is re-run. ⚠️ It
 * filters the CURRENT rows by their own `starts_at`/`expires_at`; `license` has
 * no history table, so it cannot resurrect a licence that has since been
 * deleted. billing freezes the number it received into the invoice snapshot, and
 * THAT frozen number is the historical record — not a re-read of this endpoint.
 *
 * ⚠️ `period_start` / `period_end` ALSO EXIST UPSTREAM and are deliberately NOT
 * exposed here. Passed together they count distinct seats held at ANY instant in
 * `[period_start, period_end)` — a mid-period joiner and leaver each count — and
 * they make `as_of` be ignored. Nothing in this console needs a period-scoped
 * count, and an unused pass-through parameter is the very thing this change is
 * deleting elsewhere. They are named here so the next reader recognises them as
 * UNREQUESTED rather than MISSING, and adds them with a caller.
 *
 * Reachable with fr's admin seam: `_adminRequest` authenticates as the
 * secure-apps SA holding `license-admin`, which is one of upstream's
 * INTERNAL_SERVICE_ROLES (`require_internal_service`).
 */
export const adminTenantSeatCount = (
  nameOrId: string,
  opts: { asOf?: string; app?: string } = {},
): Promise<SeatCountRecord> => {
  // `URLSearchParams`, not hand-concatenation. Two optional params in one query
  // string is where `?a=` + `?b=` (or a dropped `&`) gets written, and upstream
  // would read the malformed second key as ABSENT — i.e. silently answer the
  // all-apps question. It also encodes each value for us.
  const params = new URLSearchParams();
  if (opts.asOf) params.set('as_of', opts.asOf);
  if (opts.app) params.set('app', opts.app);
  const qs = params.toString();
  return admin<SeatCountRecord>(
    'GET',
    `/internal/tenants/${encodeURIComponent(nameOrId)}/seat-count${qs ? `?${qs}` : ''}`,
  );
};

/**
 * Create a licences tenant OWNED BY fr (the owner comes from fr's client, never
 * the body).
 *
 * ⛔ NOT idempotent by name (licences migration 050). Upstream used to hand
 * back the EXISTING tenant for a taken name — which gave fr another app's
 * tenant UUID when both had a customer called `acme`. Now:
 *  - a name fr already holds → 409 `tenant_name_taken` (an IntegrationError
 *    `UPSTREAM_CONFLICT`; the route answers it as a 409 to the console);
 *  - a name only ANOTHER app holds → a NEW tenant (201);
 *  - `external_ref` sent and already registered by fr → 200 + that tenant
 *    (the only idempotent path).
 */
export const adminCreateTenant = (body: {
  name: string;
  keycloak_realm?: string | null;
  external_ref?: string | null;
}): Promise<TenantRecord> =>
  admin<TenantRecord>('POST', '/tenants', { body: JSON.stringify(body) });

/**
 * Rename a tenant.
 *
 * The name is an IDENTIFIER upstream: `/tenants/{name_or_id}` resolves by name
 * or by uuid, and licence-authz compares tenant names literally. Anything the
 * operator has bookmarked or scripted against the OLD name breaks the moment
 * this succeeds — callers must confirm, and must address the tenant by `id`
 * afterwards rather than by the name they just replaced.
 */
export const adminRenameTenant = (
  nameOrId: string,
  name: string,
): Promise<TenantRecord> =>
  admin<TenantRecord>('PATCH', `/tenants/${encodeURIComponent(nameOrId)}`, {
    body: JSON.stringify({ name }),
  });

/**
 * Archive or restore a tenant.
 *
 * Archiving revokes NOTHING: licences stay valid, tokens keep authenticating
 * and budgets keep their balance. It only removes the tenant from pick-lists
 * and marks it "do not provision into this". `archived: false` restores it.
 */
export const adminSetTenantArchived = (
  nameOrId: string,
  archived: boolean,
): Promise<TenantRecord> =>
  admin<TenantRecord>('PATCH', `/tenants/${encodeURIComponent(nameOrId)}/archive`, {
    body: JSON.stringify({ archived }),
  });

/**
 * Tenant-wide BYO posture. `app` narrows the READ to a per-product override.
 *
 * ⚠️ This is the EFFECTIVE posture: upstream performs the fallback to the
 * tenant-wide `Tenant.byo_mode` when a product has no override row. It is the
 * read a caller almost always wants, and it is already proxied — see
 * `handleGetByoMode`, which forwards `?app=`.
 *
 * ⛔ Upstream ALSO ships `GET /tenants/{n}/apps/{app_key}/byo-mode`, and fr
 * deliberately does NOT proxy it (decided in 0c7ecf57; re-derived and confirmed
 * 2026-09-04). That route reports only whether an OVERRIDE ROW exists, so its
 * 404 means "no override", NOT "BYO allowed". Upstream's own docstring spells
 * out the hazard: treating that 404 as `local_allowed` "is exactly the
 * confusion that would let a byo_required tenant reach the platform LLM".
 *
 * Two sessions have now proposed adding it from a handoff note reading
 * "per-app BYO read missing", which is why the reasoning lives here in the
 * source rather than only in a commit message. If you need the override ROW
 * (not the effective posture), `adminListOfferings` already returns it.
 */
export const adminGetByoMode = (
  nameOrId: string,
  appKey?: string,
): Promise<{ byo_mode: string; [k: string]: unknown }> =>
  admin<{ byo_mode: string; [k: string]: unknown }>(
    'GET',
    `/tenants/${encodeURIComponent(nameOrId)}/byo-mode` +
      (appKey ? `?app=${encodeURIComponent(appKey)}` : ''),
  );

export const adminSetTenantByoMode = (
  nameOrId: string,
  byoMode: string,
): Promise<unknown> =>
  admin<unknown>('PATCH', `/tenants/${encodeURIComponent(nameOrId)}/byo-mode`, {
    body: JSON.stringify({ byo_mode: byoMode }),
  });

/** Per-(tenant, app) BYO override. Absent row => the tenant-wide value applies. */
export const adminSetTenantAppByoMode = (
  nameOrId: string,
  appKey: string,
  byoMode: string,
): Promise<unknown> =>
  admin<unknown>(
    'PUT',
    `/tenants/${encodeURIComponent(nameOrId)}/apps/${encodeURIComponent(appKey)}/byo-mode`,
    { body: JSON.stringify({ byo_mode: byoMode }) },
  );

/** Drop the per-product override so the tenant-wide posture applies again. */
export const adminClearTenantAppByoMode = (
  nameOrId: string,
  appKey: string,
): Promise<void> =>
  admin<void>(
    'DELETE',
    `/tenants/${encodeURIComponent(nameOrId)}/apps/${encodeURIComponent(appKey)}/byo-mode`,
  );

// ----- offerings -----------------------------------------------------------

/** NOTE the wrapper: upstream returns `{offerings: [...]}`, not a bare array. */
export async function adminListOfferings(
  appKey?: string,
): Promise<OfferingRecord[]> {
  const path = '/offerings' + (appKey ? `?app=${encodeURIComponent(appKey)}` : '');
  const body = await admin<{ offerings: OfferingRecord[] }>('GET', path);
  return body.offerings ?? [];
}

export const adminGetOffering = (
  appKey: string,
  code: string,
): Promise<OfferingRecord> =>
  admin<OfferingRecord>(
    'GET',
    `/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
  );

export const adminCreateOffering = (
  body: Record<string, unknown>,
): Promise<OfferingRecord> =>
  admin<OfferingRecord>('POST', '/offerings', { body: JSON.stringify(body) });

export const adminDeleteOffering = (
  appKey: string,
  code: string,
): Promise<void> =>
  admin<void>(
    'DELETE',
    `/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
  );

/**
 * Materialize an offering onto a tenant: BYO posture row + billing markup rule
 * + (when priced or when it bundles an allowance) the billing access charge.
 */
export const adminProvisionTenantOffering = (
  nameOrId: string,
  appKey: string,
  code: string,
): Promise<unknown> =>
  admin<unknown>(
    'POST',
    `/tenants/${encodeURIComponent(nameOrId)}/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
  );

export const adminUnprovisionTenantOffering = (
  nameOrId: string,
  appKey: string,
  code: string,
): Promise<unknown> =>
  admin<unknown>(
    'DELETE',
    `/tenants/${encodeURIComponent(nameOrId)}/offerings/${encodeURIComponent(appKey)}/${encodeURIComponent(code)}`,
  );
