// src/services/pricing-admin.ts
//
// Super-admin pricing management — proxies billing-service's pricing config
// API (provider_pricing + markup_rules) so a platform super-admin can read and
// upsert rates from the fr UI instead of POSTing from inside a pod.
//
// These billing endpoints are gated by `require_pricing_admin` (license-admin
// OR billing-internal), `require_pricing_writer` (license-admin OR
// pricing-writer, on the money-config WRITES) and `require_admin`
// (license-admin). We mint the service Bearer via
// `getSecureAppsAuthenticator()` (secure-apps realm), whose SA holds
// `license-admin` — the one role that satisfies all three — so the human only
// needs the `super_admin` realm role in fr, which the fr route layer enforces
// (routes/settings/pricing-admin.ts). NB `metering-internal` was retired
// fleet-wide 2026-07-16 and authorises nothing here.
//
// Endpoint shape (mirrored from billing_service/src/routers/config.py):
//   GET  /api/config/provider-pricing        → {data: ProviderPricingRow[]}
//   POST /api/config/provider-pricing         → 201 {data: ProviderPricingRow}  (upsert)
//   GET  /api/config/markup-rules            → {data: MarkupRuleRow[]}
//   POST /api/config/markup-rules             → 201 {data: MarkupRuleRow}        (upsert)
// Each POST closes the prior open row for its match-tuple and opens a new
// effective-dated row (audit-logged on the billing side).

import { config } from '../config';
import { IntegrationError } from '../integrations/_lib/errors';
import { getSecureAppsAuthenticator } from '../lib/service-authenticators';

function billingBaseUrl(): string {
  return (
    process.env.BILLING_BASE_URL ??
    process.env.BILLING_SERVICE_URL ??
    config.services.billing.baseUrl
  );
}

// Rows are passed through verbatim — fr does not reshape billing's pricing
// schema. Typed loosely so a new billing field surfaces in the UI without an
// fr redeploy.
export type PricingRow = Record<string, unknown>;

/** Unwrap billing's `{data, ...}` envelope without requiring a `meta` key. */
function unwrap(json: unknown): unknown {
  if (json && typeof json === 'object' && !Array.isArray(json) && 'data' in json) {
    return (json as { data: unknown }).data;
  }
  return json;
}

async function billingFetch(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const url = `${billingBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await getSecureAppsAuthenticator().authenticatedFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const isTimeout =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new IntegrationError({
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `pricing-admin ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'pricing-admin',
      method,
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
    const code =
      res.status === 404
        ? 'UPSTREAM_NOT_FOUND'
        : res.status === 401
          ? 'UPSTREAM_UNAUTHORIZED'
          : res.status === 403
            ? 'UPSTREAM_FORBIDDEN'
            : 'UPSTREAM_BAD_STATUS';
    throw new IntegrationError({
      code,
      message: `pricing-admin ${method} ${path} returned ${res.status}`,
      service: 'pricing-admin',
      method,
      path,
      upstreamStatus: res.status,
      upstreamBody: parsed,
    });
  }

  if (res.status === 204) return undefined;
  // ⚠️ Was `.catch(() => undefined)`. On a SUCCESSFUL response whose body does
  // not parse, that became `undefined`, and every list wrapper below does
  // `Array.isArray(data) ? data : []` — so a broken upstream contract rendered
  // in the admin UI as "no pricing rules / no access charges configured". A
  // parse failure on a 2xx is an upstream contract violation, not an empty
  // config, and nothing anywhere recorded that it happened.
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `pricing-admin ${method} ${path} returned ${res.status} with an unreadable body`,
      service: 'pricing-admin',
      method,
      path,
      upstreamStatus: res.status,
      cause: e,
    });
  }
  return unwrap(json);
}

export async function listProviderPricing(): Promise<PricingRow[]> {
  const data = await billingFetch('GET', '/api/config/provider-pricing');
  return Array.isArray(data) ? (data as PricingRow[]) : [];
}

export async function upsertProviderPricing(body: PricingRow): Promise<PricingRow> {
  return (await billingFetch('POST', '/api/config/provider-pricing', body)) as PricingRow;
}

export async function listMarkupRules(): Promise<PricingRow[]> {
  const data = await billingFetch('GET', '/api/config/markup-rules');
  return Array.isArray(data) ? (data as PricingRow[]) : [];
}

export async function upsertMarkupRule(body: PricingRow): Promise<PricingRow> {
  return (await billingFetch('POST', '/api/config/markup-rules', body)) as PricingRow;
}

// --- Platform default markup -----------------------------------------------
// The markup billing applies when NO markup_rule matches — DB override
// (tenant_config '__default__') > env default, resolved on the billing side.
// `require_admin` (license-admin)-gated, which the secure-apps SA carries.
//   GET /api/config/markup → {data: {default_markup_pct: number}}
// The UI needs it to state what is actually being charged when the rule list
// is empty, which is production's state today.

/**
 * USD→EUR FX rows (billing `GET/PUT /api/config/fx-rates`, role
 * pricing-writer). Every EUR money consumption is `fx × USD price` (PLAN
 * tenant-inference-provisioning §3.1), so a tenant cannot be EUR-provisioned
 * until a rate exists: billing's quote answers `fx_rate_missing` and
 * provisioning's apply refuses before the IR PUT.
 */
export async function listFxRates(): Promise<PricingRow[]> {
  const data = await billingFetch('GET', '/api/config/fx-rates');
  return Array.isArray(data) ? (data as PricingRow[]) : [];
}

/**
 * ATTRIBUTION: billing stamps `fx_rate.set_by` (and its audit row) with the
 * HUMAN, not this SA. The owner's own verified portal JWT is relayed in
 * `X-Forwarded-User-Authorization: Bearer <jwt>` — the same on-behalf-of
 * contract as provisioning's inference apply and billing's currency change;
 * billing trusts it only because the caller (this SA) passed its pricing-writer
 * gate, and re-verifies it against the portal realm. Never logged or stored.
 */
export async function putFxRate(body: PricingRow, ownerPortalToken: string): Promise<PricingRow> {
  return (await billingFetch('PUT', '/api/config/fx-rates', body, {
    'X-Forwarded-User-Authorization': `Bearer ${ownerPortalToken}`,
  })) as PricingRow;
}

export async function getMarkupConfig(): Promise<PricingRow> {
  return (await billingFetch('GET', '/api/config/markup')) as PricingRow;
}

// --- Access charges (the ACCESS-billing axis) ------------------------------
// A per-(tenant, product) fixed access fee (monthly/one_time), distinct from
// the USAGE markup. billing gates these with `require_pricing_admin`, which the
// secure-apps SA carries.
//   GET  /api/config/access-charges → {data: AccessChargeRow[]}
//   POST /api/config/access-charges → 201 {data: AccessChargeRow}  (upsert)

export async function listAccessCharges(): Promise<PricingRow[]> {
  const data = await billingFetch('GET', '/api/config/access-charges');
  return Array.isArray(data) ? (data as PricingRow[]) : [];
}

export async function upsertAccessCharge(body: PricingRow): Promise<PricingRow> {
  return (await billingFetch('POST', '/api/config/access-charges', body)) as PricingRow;
}

/** One product's live allowance position for the current billed month. */
export interface TenantAllowanceUsageEntry {
  /** `null` = the tenant-wide (NULL service_key) bucket. */
  service_key: string | null;
  used_usd: string;
  allowance_usd: string;
  remaining_usd: string;
}

/**
 * Live used / allowance / remaining per product for a tenant's current month —
 * a pure compute-on-read fold over `cost_daily` on the billing side that
 * reconciles with the invoice's allowance netting.
 *   GET /api/config/tenant-allowance-usage?tenant_id=… → {data: {entries: [...]}}
 * `require_pricing_admin`-gated, which the secure-apps SA carries. The caller
 * passes the ALS-resolved tenant id (never a browser-supplied value).
 */
export async function getTenantAllowanceUsage(
  tenantId: string,
): Promise<TenantAllowanceUsageEntry[]> {
  const data = await billingFetch(
    'GET',
    `/api/config/tenant-allowance-usage?tenant_id=${encodeURIComponent(tenantId)}`,
  );
  const entries =
    data && typeof data === 'object' && 'entries' in data
      ? (data as { entries: unknown }).entries
      : undefined;
  return Array.isArray(entries) ? (entries as TenantAllowanceUsageEntry[]) : [];
}

// --- Per-tenant billing config (markup_pct + billing_mode) -----------------
// Billing endpoints require `require_admin` (license-admin), which the
// secure-apps SA carries. Used by the super-admin "Tenant billing mode" UI to
// put a BYO tenant into `byo_platform_fee` / `pass_through` billing.
//   GET /api/config/tenants/{tenant_id} → {data: {tenant_id, markup_pct, billing_mode, notes}}
//   PUT /api/config/tenants/{tenant_id} → same shape (upsert)

export async function getTenantConfig(tenantId: string): Promise<PricingRow> {
  return (await billingFetch(
    'GET',
    `/api/config/tenants/${encodeURIComponent(tenantId)}`,
  )) as PricingRow;
}

export async function putTenantConfig(tenantId: string, body: PricingRow): Promise<PricingRow> {
  return (await billingFetch(
    'PUT',
    `/api/config/tenants/${encodeURIComponent(tenantId)}`,
    body,
  )) as PricingRow;
}
