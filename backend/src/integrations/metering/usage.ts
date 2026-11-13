// src/integrations/metering/usage.ts
//
// Foundation Plan 4 Lane A — typed wrappers for the per-user
// metering endpoints used by `/settings/usage`. Layered on top of the
// existing `services/metering.ts` `MeteringClient` (which already covers
// /api/usage/me and /api/costs/me with the right header injection via
// HttpClient ALS).
//
// Why this lives in `integrations/metering/` (next to the detector
// client) rather than `services/metering.ts`:
//   * `services/metering.ts` is the lean licenses-page client; growing
//     it with summary/series/breakdown/quota helpers + window math
//     would mix unrelated UX concerns into one file.
//   * The detector client is also under `integrations/metering/` —
//     this keeps every metering wire client in the same directory.
//
// Wire contract (upstream metering_service):
//   GET /api/usage/me?start=<iso>&end=<iso>&granularity=daily|hourly
//     200 → UsageResponse {start, end, granularity,
//                          total_requests, total_denied,
//                          by_service: [{service_key, request_count, denied_count}]}
//   GET /api/costs/me?start=<iso>&end=<iso>
//     200 → CostResponse  {start, end,
//                          total_cost_usd, total_input_tokens, total_output_tokens,
//                          by_provider: [{provider, input_tokens, output_tokens,
//                                          cost_usd, request_count}]}
//   GET /api/usage/me/series?window=Nd&granularity=daily|hourly
//     200 → UsageSeriesResponse {window, granularity, start, end,
//                                buckets: [{ts, requests, tokens, cost_usd}],
//                                cost_unavailable}
//   GET /api/usage/me/breakdown?window=Nd
//     200 → UsageBreakdownResponse {window, start, end,
//                                   services: [{service, requests, tokens, cost_usd}],
//                                   cost_unavailable}
//
// Auth: X-Subject-Id is injected automatically from ALS by HttpClient
// (see integrations/_lib/http-client.ts:buildHeaders). Per
// `upstream-license-token-pattern.md`, we never forward the inbound
// browser Bearer to the upstream — the per-user attribution is via
// X-Subject-Id, and tenant scoping is via X-Tenant-Id (also injected
// from ALS).

import { HttpClient } from '../_lib/http-client';
import { getSecureAppsAuthenticator } from '../../lib/service-authenticators';

// ----- Wire-shape types (mirror metering_service models/domain.py) ---------

export interface UpstreamServiceUsage {
  service_key: string;
  request_count: number;
  denied_count: number;
}

export interface UpstreamUsageResponse {
  tenant_id?: string | null;
  tenant_name?: string | null;
  license_id?: string | null;
  app_id?: string | null;
  start: string;
  end: string;
  granularity: string;
  total_requests: number;
  total_denied: number;
  by_service: UpstreamServiceUsage[];
}

export interface UpstreamProviderCost {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  // total_cost_usd arrives as a string-encoded Decimal from FastAPI's
  // pydantic Decimal serializer. We surface it as-is to the route layer
  // and let the page coerce for display.
  cost_usd: string;
  request_count: number;
}

export interface UpstreamCostResponse {
  tenant_id?: string | null;
  tenant_name?: string | null;
  start: string;
  end: string;
  total_cost_usd: string;
  total_input_tokens: number;
  total_output_tokens: number;
  by_provider: UpstreamProviderCost[];
  /**
   * Second decomposition of the SAME cost_daily rows as `by_provider`
   * (billing_service routers/costs.py `costs_by_tenant`, grouped by
   * `(tenant_id, project_id)` in routers/_aggregation.py
   * `aggregate_by_project`). Optional: an older billing deploy omits it.
   * Un-attributed spend is reported under billing's NULL_PROJECT_ID sentinel
   * row, never dropped. No per-day axis — the breakdown is window totals only.
   */
  by_project?: UpstreamProjectCost[];
}

export interface UpstreamProjectCost {
  project_id: string;
  /** Populated on every row by current billing; optional for older deploys. */
  tenant_id?: string | null;
  input_tokens: number;
  output_tokens: number;
  /** Decimal serialised as a string by FastAPI, like every other cost field. */
  cost_usd: string;
  request_count: number;
}

// ----- Public wrappers -----------------------------------------------------

// Billing reads (/api/usage, /api/costs, /api/budget/status, /api/admin/usage)
// live on billing-service and read ONLY BILLING_* (no METERING_* fallback: the
// improvement-loop-service METERING_BASE_URL pointed at was removed, gitops
// #4968). BILLING_BASE_URL is required in production (config.ts).
const meteringHttp = new HttpClient({
  serviceName: 'billing-service-usage',
  baseUrl:
    process.env.BILLING_BASE_URL ??
    process.env.BILLING_SERVICE_URL ??
    '',
  defaultTimeoutMs: 5000,
  // Never the end user's Keycloak JWT. Ten of this file's eleven calls are the
  // `/me` and `/tenant` billing reads, which billing authorises from the
  // forwarded `X-Subject-Id` / `X-Tenant-Id` and never from a bearer
  // (billing_service src/routers/usage.py:346, src/auth_deps.py:161-210).
  //
  // The eleventh — `/api/admin/usage/system` at :518 — DOES require a bearer
  // (billing_service src/auth.py:158-169: 401 "Missing bearer token", 403
  // without the `license-admin` realm role), and it already supplies its own:
  // it passes `getSecureAppsAuthenticator().getAuthHeader()` explicitly per
  // call, from the secure-apps realm, because billing does not know the portal
  // signing key. `buildHeaders` only fills `authorization` when the caller has
  // not set it, so that explicit header wins and this flag never applied to it.
  //
  // That is why no split is needed here, and why the comment at :500 — "sends
  // no Authorization header" — is finally true rather than merely intended.
  sendAuthorization: false,
});

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.set(k, v);
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

// metering-service T3.2 (2026-05-04) wraps successful JSON bodies as
// `{ data: T, meta: { request_id, processed_at, ... } }`. Older deployments
// (and a handful of internal endpoints that haven't migrated yet) still
// return the bare T. We unwrap at the response boundary so every caller
// keeps working unchanged regardless of which envelope the upstream emits.
//
// Heuristic: a response is "enveloped" iff it's a non-null object literal
// that has BOTH a `data` key whose value is defined AND a `meta` key. The
// `meta` requirement (added 2026-05-05 after audit) prevents false-positive
// unwrap on legitimate bare-T payloads that happen to carry a top-level
// `data` field of their own — e.g. a future endpoint returning
// `{data: [...], cursor: "..."}` would otherwise be unwrapped down to the
// inner array and lose the cursor.
//
//   {data: T, meta: {...}}                              → unwrap to T
//   {data: T} (no meta)                                 → bare T (NOT
//                                                         unwrapped — stays as
//                                                         {data: T} for the
//                                                         caller's typed read)
//   {data: undefined, meta: {...}}                      → fall through (rare;
//                                                         treat as bare)
//   {items: [...], total: N}                            → bare T (T's own
//                                                         shape, no `data` key)
//   array / string / number / null                      → bare T
//
// Exported so services/metering-admin.ts shares this one source of truth.
export function unwrapEnvelope<T>(raw: unknown): T {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'data' in raw &&
    'meta' in raw
  ) {
    const v = (raw as { data: unknown }).data;
    if (v !== undefined) return v as T;
  }
  return raw as T;
}

const unwrapMetering = unwrapEnvelope;

/**
 * Per-call X-Tenant-Id override. When set, replaces the ALS-derived
 * tenant header in HttpClient.buildHeaders so a super-admin can request
 * per-tenant data across the workspaces they have access to without
 * re-running the request under a different ALS frame.
 *
 * Header takes precedence over ALS only when explicitly passed.
 */
function tenantOverrideHeader(
  tenantId: string | undefined,
): { headers: Record<string, string> } | Record<string, never> {
  if (!tenantId) return {};
  return { headers: { 'X-Tenant-Id': tenantId } };
}

/** GET /api/usage/me with explicit window + granularity. */
export async function getMyUsageRange(opts: {
  start: Date;
  end: Date;
  granularity: 'hourly' | 'daily';
  /**
   * Optional per-call tenant override. When set, forwarded as the
   * upstream `X-Tenant-Id` header so the metering rollup is scoped to
   * the named tenant instead of the ALS-derived caller tenant.
   * Super-admin breakdown only — non-admin requests should leave this
   * unset so the tenant comes from the JWT.
   */
  tenantId?: string;
}): Promise<UpstreamUsageResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/usage/me${qs({
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
      granularity: opts.granularity,
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamUsageResponse>(body);
}

// ----- by-correlation (per-operation) cost read ----------------------------
//
// Fleet-wide cost-correlation standard (billing_service/docs/COST_CORRELATION.md).
// fr already stamps `X-Correlation-Id` (the per-request ALS correlation id) on
// every outbound LLM call via HttpClient.buildHeaders → the LLM emitters
// (worker_management BYO chat/completions, inference-router platform) read it
// and write it onto the cost event → billing stores `correlation_id` (indexed)
// and prices the event. This reads those priced dollars back for a set of
// operation ids (e.g. the `correlation_id` column on `n8n_execution_mapping`,
// or worker_management `graph_execution_sessions.correlation_id` — both are the
// same value fr stamped outbound, so they line up with the cost events).
//
// Wire contract (billing_service routers/costs.py):
//   GET /api/costs/by-correlation?ids=<uuid,…>&group_by=<dim,…>
//     ids       (required): comma-separated correlation UUIDs (≤500)
//     group_by  (optional): any of stage,model,provider,correlation_id,day
//   200 → { total_cost_usd, total_input_tokens, total_output_tokens,
//           event_count,
//           groups: [{ key: {<dim>: <val>}, cost_usd,
//                      input_tokens, output_tokens, event_count }] }
//
// Auth is identical to the /api/costs/* reads above — Bearer + plain
// X-Tenant-Id, both injected from ALS by HttpClient (tenantOverrideHeader lets
// a super-admin scope to a specific tenant). Do NOT send the w2v
// `X-Tenant-Id: Bearer <token>` form; billing reads X-Tenant-Id as the value.

export type CostCorrelationGroupBy =
  | 'stage'
  | 'model'
  | 'provider'
  | 'correlation_id'
  | 'day';

export interface UpstreamCostByCorrelationGroup {
  // key carries one entry per requested group_by dimension, e.g.
  // { stage: 'plan', model: 'claude-…' }. Values are strings (or null when
  // the cost event carried no value for that dimension).
  key: Record<string, string | null>;
  // Decimal serialised as a string by FastAPI (same as the other cost reads).
  cost_usd: string;
  input_tokens: number;
  output_tokens: number;
  event_count: number;
}

export interface UpstreamCostByCorrelationResponse {
  total_cost_usd: string;
  total_input_tokens: number;
  total_output_tokens: number;
  event_count: number;
  groups: UpstreamCostByCorrelationGroup[];
}

/**
 * GET /api/costs/by-correlation — priced per-operation cost for a set of
 * correlation ids. Returns an empty (zeroed) response without hitting the
 * upstream when `ids` is empty, so callers can pass through unconditionally.
 *
 * `ids` are sent comma-separated; billing caps at 500 — callers with more
 * should batch. `groupBy` is forwarded as a comma-separated `group_by`; omit
 * it for a single grand-total roll-up across the ids.
 */
export async function getCostByCorrelation(opts: {
  ids: string[];
  groupBy?: CostCorrelationGroupBy[];
  /** See `getMyUsageRange.tenantId` — same per-call tenant-override semantics. */
  tenantId?: string;
}): Promise<UpstreamCostByCorrelationResponse> {
  if (opts.ids.length === 0) {
    return {
      total_cost_usd: '0',
      total_input_tokens: 0,
      total_output_tokens: 0,
      event_count: 0,
      groups: [],
    };
  }
  const body = await meteringHttp.json<unknown>(
    `/api/costs/by-correlation${qs({
      ids: opts.ids.join(','),
      group_by:
        opts.groupBy && opts.groupBy.length > 0
          ? opts.groupBy.join(',')
          : undefined,
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamCostByCorrelationResponse>(body);
}

/** GET /api/costs/me with explicit window. */
export async function getMyCostsRange(opts: {
  start: Date;
  end: Date;
  /** See `getMyUsageRange.tenantId` — same semantics. */
  tenantId?: string;
}): Promise<UpstreamCostResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/costs/me${qs({
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamCostResponse>(body);
}

// ----- Series + breakdown wire types (mirror metering UsageSeries* / UsageBreakdown*) ------

export interface UpstreamSeriesBucket {
  ts: string;
  requests: number;
  tokens: number;
  // Decimal serialised as a string by FastAPI. `cost_usd` is raw
  // provider/incurred cost (no markup); `billed_cost_usd` applies the
  // active tenant's markup_pct upstream. Missing on older deploys —
  // route layer treats absence as "same as cost_usd".
  cost_usd: string;
  billed_cost_usd?: string;
  // Estimated public *provider* cost for BYO usage in this bucket (list price ×
  // tokens). Absent/null when the bucket has no BYO usage or no list rate.
  provider_estimate_usd?: string | null;
}

export interface UpstreamUsageSeriesResponse {
  window: string;
  granularity: 'hourly' | 'daily';
  start: string;
  end: string;
  buckets: UpstreamSeriesBucket[];
  cost_unavailable: boolean;
  // Effective markup percentage upstream applied for billed_cost_usd.
  // Null when no tenant context was present.
  markup_pct?: number | null;
}

export interface UpstreamBreakdownEntry {
  service: string;
  requests: number;
  tokens: number;
  cost_usd: string;
  billed_cost_usd?: string;
  // Estimated public provider cost for BYO usage on this service.
  provider_estimate_usd?: string | null;
}

export interface UpstreamUsageBreakdownResponse {
  window: string;
  start: string;
  end: string;
  services: UpstreamBreakdownEntry[];
  cost_unavailable: boolean;
  markup_pct?: number | null;
}

// ----- System-wide super-admin aggregate (mirrors SystemUsageResponse) -----

export interface UpstreamSystemTenantUsage {
  tenant_id: string;
  tenant_name: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  incurred_cost_usd: string;
  markup_pct: number;
  billed_cost_usd: string;
}

export interface UpstreamSystemProviderUsage {
  provider: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  incurred_cost_usd: string;
}

export interface UpstreamSystemUsageGrandTotal {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  incurred_cost_usd: string;
  billed_cost_usd: string;
}

export interface UpstreamSystemUsageResponse {
  window: string;
  start: string;
  end: string;
  generated_at: string;
  grand_total: UpstreamSystemUsageGrandTotal;
  by_tenant: UpstreamSystemTenantUsage[];
  by_provider: UpstreamSystemProviderUsage[];
}

// ----- Budget status (mirrors BudgetAggregateStatus) -----------------------

export interface UpstreamBudgetEntry {
  budget_id?: string;
  source?: string;
  budget_tokens?: number;
  consumed_tokens?: number;
  remaining_tokens?: number;
  period?: string;
  expires_at?: string | null;
}

export interface UpstreamBudgetAggregateStatus {
  tenant_id: string;
  total_remaining: number;
  budget_count: number;
  next_expiry: string | null;
  budgets: UpstreamBudgetEntry[];
}

/** GET /api/usage/me/series — per-bucket time-series for the caller. */
export async function getMyUsageSeries(opts: {
  window: string;
  granularity: 'hourly' | 'daily';
}): Promise<UpstreamUsageSeriesResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/usage/me/series${qs({
      window: opts.window,
      granularity: opts.granularity,
    })}`,
  );
  return unwrapMetering<UpstreamUsageSeriesResponse>(body);
}

/** GET /api/usage/me/breakdown — per-service usage + cost for the caller. */
export async function getMyUsageBreakdown(opts: {
  window: string;
}): Promise<UpstreamUsageBreakdownResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/usage/me/breakdown${qs({
      window: opts.window,
    })}`,
  );
  return unwrapMetering<UpstreamUsageBreakdownResponse>(body);
}

// ----- Tenant-scoped wrappers ----------------------------------------------
//
// The /me wrappers above filter by X-Subject-Id (the logged-in human), but
// real cost/usage rolls up under the NULL-subject sentinel, so a human's /me
// view is structurally always zero. The Usage page instead scopes to the
// ACTIVE workspace (the tenant switcher) via these tenant wrappers. We forward
// X-Tenant-Id == the path tenant explicitly so metering's enforce_tenant_
// isolation accepts the call even when it differs from the ALS-derived tenant
// (the super-admin by-tenant fan-out queries tenants other than its own).

/** GET /api/usage/tenant/{tenant_id} — tenant-scoped usage (all subjects). */
export async function getTenantUsageRange(opts: {
  tenantId: string;
  start: Date;
  end: Date;
  granularity: 'hourly' | 'daily';
}): Promise<UpstreamUsageResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/usage/tenant/${encodeURIComponent(opts.tenantId)}${qs({
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
      granularity: opts.granularity,
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamUsageResponse>(body);
}

/** GET /api/costs/tenant/{tenant_id} — tenant-scoped cost (all subjects). */
export async function getTenantCostsRange(opts: {
  tenantId: string;
  start: Date;
  end: Date;
}): Promise<UpstreamCostResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/costs/tenant/${encodeURIComponent(opts.tenantId)}${qs({
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamCostResponse>(body);
}

// ----- Per-project cost to date ---------------------------------------------
//
// Billing has no per-project endpoint; `GET /api/costs/tenant/{tenant_id}`
// returns `by_project` alongside `by_provider`, and we pick one project's row.
//
// ⚠️ WINDOW CAP. billing `_validate_window` (routers/costs.py) rejects a window
// wider than `MAX_WINDOW_DAYS` (92, routers/export.py) with a 422, and "cost to
// date" for a project older than that is exactly such a window. So the range is
// split into consecutive, NON-OVERLAPPING day chunks of at most 92 dates each
// and summed. Billing filters `bucket_date >= start.date()` AND
// `bucket_date <= end.date()` (inclusive on both ends), so a chunk
// [d 00:00:00Z, d+91 23:59:59Z] covers exactly dates d..d+91 and spans
// < 92 days; the next chunk starts at d+92.

/** Max distinct bucket dates per upstream call (billing MAX_WINDOW_DAYS). */
export const PROJECT_COST_CHUNK_DAYS = 92;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(d: string): number {
  if (!DATE_RE.test(d)) throw new Error(`getProjectCost: bad date ${d}`);
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`getProjectCost: bad date ${d}`);
  return t;
}

function fmtDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Most chunks one project-cost read may fan out to (40 × 92 days ≈ 10 years).
 * Callers must reject a wider range BEFORE calling (route → 422);
 * getProjectCost also refuses, so no caller can fan out unbounded.
 */
export const PROJECT_COST_MAX_CHUNKS = 40;
/** Upstream calls in flight at once for one project-cost read. */
export const PROJECT_COST_CONCURRENCY = 4;

/** Number of chunks [from, to] needs, without building them (0 when from > to). */
export function projectCostChunkCount(from: string, to: string): number {
  const days = (parseDay(to) - parseDay(from)) / DAY_MS + 1;
  return days <= 0 ? 0 : Math.ceil(days / PROJECT_COST_CHUNK_DAYS);
}

/** Map with at most `limit` promises in flight; results keep input order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Split [from, to] (inclusive, YYYY-MM-DD) into billing-sized chunks. */
export function projectCostChunks(
  from: string,
  to: string,
): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  const last = parseDay(to);
  for (let d = parseDay(from); d <= last; d += PROJECT_COST_CHUNK_DAYS * DAY_MS) {
    const e = Math.min(d + (PROJECT_COST_CHUNK_DAYS - 1) * DAY_MS, last);
    out.push({ start: `${fmtDay(d)}T00:00:00Z`, end: `${fmtDay(e)}T23:59:59Z` });
  }
  return out;
}

export interface ProjectCostTotal {
  project_id: string;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  /** Number of upstream calls made (window chunks). */
  upstream_calls: number;
}

/**
 * Cost to date for ONE project, from the tenant cost read's `by_project`.
 *
 * A project with no cost rows (or an older billing that omits `by_project`)
 * is a ZERO, not an error — a project that has made no attributed LLM call has
 * genuinely spent nothing that billing can attribute to it. Upstream failures
 * (IntegrationError) propagate unchanged for the route to map.
 *
 * Rows are matched on project_id AND tenant_id (when billing supplies it):
 * billing groups by `(tenant_id, project_id)` because a project uuid is only
 * unique within a tenant.
 */
export async function getProjectCost(opts: {
  tenantId: string;
  projectId: string;
  /** Inclusive first day, YYYY-MM-DD (UTC). */
  from: string;
  /** Inclusive last day, YYYY-MM-DD (UTC). */
  to: string;
}): Promise<ProjectCostTotal> {
  const pid = opts.projectId.toLowerCase();
  const tid = opts.tenantId.toLowerCase();
  const n = projectCostChunkCount(opts.from, opts.to);
  if (n > PROJECT_COST_MAX_CHUNKS) {
    throw new Error(`getProjectCost: range needs ${n} chunks (max ${PROJECT_COST_MAX_CHUNKS})`);
  }
  const chunks = projectCostChunks(opts.from, opts.to);
  const bodies = await mapBounded(chunks, PROJECT_COST_CONCURRENCY, async (c) =>
      unwrapMetering<UpstreamCostResponse>(
        await meteringHttp.json<unknown>(
          `/api/costs/tenant/${encodeURIComponent(opts.tenantId)}${qs({
            start: c.start,
            end: c.end,
          })}`,
          tenantOverrideHeader(opts.tenantId),
        ),
      ),
  );
  const total: ProjectCostTotal = {
    project_id: opts.projectId,
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    upstream_calls: chunks.length,
  };
  for (const body of bodies) {
    for (const row of body?.by_project ?? []) {
      if (String(row.project_id).toLowerCase() !== pid) continue;
      if (row.tenant_id && String(row.tenant_id).toLowerCase() !== tid) continue;
      total.total_cost_usd += Number.parseFloat(row.cost_usd) || 0;
      total.input_tokens += row.input_tokens ?? 0;
      total.output_tokens += row.output_tokens ?? 0;
      total.request_count += row.request_count ?? 0;
    }
  }
  // Float accumulation over a handful of Decimal strings; round to billing's
  // sub-cent precision so the response never carries 0.30000000000000004.
  total.total_cost_usd = Math.round(total.total_cost_usd * 1e6) / 1e6;
  return total;
}

// ----- Per-project settled + same-day provisional cost (billing #290) --------
//
// `GET /api/costs/projects/{project_id}` — settled days from the daily rollup, provisional from raw
// events after the rollup watermark (so today's spend is visible), and spend per card from
// `metadata.card_id`. Tenant-scoped by the X-Tenant-Id fr sends server-side (the same header the
// tenant cost reads above carry); another tenant's project reads as zeros. Costs are decimal
// strings (6 dp), the INTERNAL pre-markup cost (`basis` says so) — the cockpit prices them.

export interface UpstreamProjectCostDay {
  day: string;
  cost: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface UpstreamProjectCosts {
  project_id: string;
  tenant_id: string;
  /** ISO 4217 of every cost below (billing #290). */
  currency?: string;
  settled: UpstreamProjectCostDay[];
  provisional: { since: string | null; cost: string; calls: number; tokens_in: number; tokens_out: number };
  by_card: { card_id: string | null; cost: string; calls: number }[];
  by_card_since: string | null;
  totals: {
    cost: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    settled_cost: string;
    provisional_cost: string;
  };
  basis: string;
  as_of: string;
}

export async function getProjectCosts(opts: { tenantId: string; projectId: string }): Promise<UpstreamProjectCosts> {
  return unwrapMetering<UpstreamProjectCosts>(
    await meteringHttp.json<unknown>(
      `/api/costs/projects/${encodeURIComponent(opts.projectId)}`,
      tenantOverrideHeader(opts.tenantId),
    ),
  );
}

// ----- Today's provisional (not yet rolled up) spend -------------------------
//
// `GET /api/costs/provisional?subject_id=<uuid optional>`: billing's same-day
// figure for the tenant (or one subject in it), read from the raw events the
// nightly rollup has not settled yet. Tenant scoping is the same X-Tenant-Id as
// every other /api/costs/* read. `cost` is INCURRED (no markup), a decimal string.

export interface UpstreamProvisionalCosts {
  tenant_id: string;
  subject_id: string | null;
  /** ISO 4217 of `cost`. */
  currency?: string;
  /** Last day the rollup settled (provisional covers the days after it). */
  settled_through: string | null;
  /** First day the provisional figure covers. */
  since: string | null;
  cost: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  basis: string;
  as_of: string;
}

export async function getProvisionalCosts(opts: {
  tenantId: string;
  subjectId?: string;
}): Promise<UpstreamProvisionalCosts> {
  return unwrapMetering<UpstreamProvisionalCosts>(
    await meteringHttp.json<unknown>(
      `/api/costs/provisional${qs({ subject_id: opts.subjectId })}`,
      tenantOverrideHeader(opts.tenantId),
    ),
  );
}

// ----- Tenant cost breakdown (per project / per acting member) --------------
//
// Two independent billing rollups over the same window:
//   * `GET /api/costs/tenant/{id}`         → CostDaily, `by_project`
//   * `GET /api/costs/tenant/{id}/actors`  → CostActorDaily, `by_actor`
// Billing documents that both totals are equal for one window, but they are
// SEPARATE tables written by separate rollups — the caller must compare them,
// never assume it. Both endpoints enforce the same 92-day `_validate_window`,
// so both reuse `projectCostChunks`.

/** billing NULL_PROJECT_ID — spend no project was attributed to. */
export const UNATTRIBUTED_PROJECT_ID = '00000000-0000-0000-0000-000000000004';
/** billing actor sentinel — spend no person initiated. */
export const UNATTRIBUTED_ACTOR_ID = '00000000-0000-0000-0000-000000000005';

export interface UpstreamActorCostLine {
  actor_id: string;
  byo: boolean;
  /** Decimal serialised as a string by FastAPI. */
  cost_usd: string;
  vendor_cost_usd?: string | null;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface UpstreamActorCostResponse {
  tenant_id: string;
  start: string;
  end: string;
  total_cost_usd: string;
  by_actor?: UpstreamActorCostLine[];
}

export interface TenantProjectCostRow {
  project_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface TenantCostBreakdown {
  /** Sum of billing's own `total_cost_usd` over every chunk. */
  total_cost_usd: number;
  /** One row per project_id, INCLUDING the unattributed sentinel. */
  by_project: TenantProjectCostRow[];
  upstream_calls: number;
}

export interface TenantActorCostRow {
  actor_id: string;
  /** byo + platform, merged. */
  cost_usd: number;
  /** The byo=true share of cost_usd (the customer's own provider bill). */
  byo_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface TenantActorCost {
  total_cost_usd: number;
  /** One row per actor_id (byo split merged), INCLUDING the no-person sentinel. */
  by_actor: TenantActorCostRow[];
  upstream_calls: number;
}

// Sums run in INTEGER micro-dollars (billing's Decimals carry ≤ 6 places), so
// "sum of rows == total" is exact integer arithmetic, not a float tolerance
// that grows with the row count.
const micros = (s: string | null | undefined): number =>
  Math.round((Number.parseFloat(String(s ?? '0')) || 0) * 1e6);
const usd = (m: number): number => m / 1e6;

function tenantChunks(fn: string, from: string, to: string): { start: string; end: string }[] {
  const n = projectCostChunkCount(from, to);
  if (n > PROJECT_COST_MAX_CHUNKS) {
    throw new Error(`${fn}: range needs ${n} chunks (max ${PROJECT_COST_MAX_CHUNKS})`);
  }
  return projectCostChunks(from, to);
}

/**
 * Tenant spend per project over [from, to] (inclusive YYYY-MM-DD, UTC).
 *
 * Every project row is kept — including billing's unattributed sentinel and
 * ids fr does not know — because a dropped row is spend that silently vanishes
 * from the page. Rows carrying ANOTHER tenant's id are skipped (billing groups
 * by (tenant_id, project_id); a project uuid is only unique within a tenant).
 */
export async function getTenantCostBreakdown(opts: {
  tenantId: string;
  from: string;
  to: string;
}): Promise<TenantCostBreakdown> {
  const tid = opts.tenantId.toLowerCase();
  const chunks = tenantChunks('getTenantCostBreakdown', opts.from, opts.to);
  const bodies = await mapBounded(chunks, PROJECT_COST_CONCURRENCY, async (c) =>
    unwrapMetering<UpstreamCostResponse>(
      await meteringHttp.json<unknown>(
        `/api/costs/tenant/${encodeURIComponent(opts.tenantId)}${qs({
          start: c.start,
          end: c.end,
        })}`,
        tenantOverrideHeader(opts.tenantId),
      ),
    ),
  );
  let total = 0;
  const rows = new Map<string, TenantProjectCostRow>();
  for (const body of bodies) {
    total += micros(body?.total_cost_usd);
    for (const row of body?.by_project ?? []) {
      if (row.tenant_id && String(row.tenant_id).toLowerCase() !== tid) continue;
      const pid = String(row.project_id).toLowerCase();
      const acc = rows.get(pid) ?? {
        project_id: pid,
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
      };
      acc.cost_usd += micros(row.cost_usd);
      acc.input_tokens += row.input_tokens ?? 0;
      acc.output_tokens += row.output_tokens ?? 0;
      acc.request_count += row.request_count ?? 0;
      rows.set(pid, acc);
    }
  }
  for (const r of rows.values()) r.cost_usd = usd(r.cost_usd);
  return {
    total_cost_usd: usd(total),
    by_project: [...rows.values()],
    upstream_calls: chunks.length,
  };
}

/**
 * Tenant spend per ACTING person over [from, to] (inclusive YYYY-MM-DD, UTC).
 *
 * billing guards this route with `require_service_caller` (per-member spend is
 * admin data), so — like `getAdminSystemUsage` — it carries the secure-apps
 * service-account bearer. `X-Tenant-Id` is sent too: billing's
 * `enforce_tenant_isolation` then refuses a path tenant that differs from it.
 * The caller (route) is responsible for gating to a workspace-admin of THIS
 * tenant; the bearer proves only that fr is a trusted service.
 */
export async function getTenantActorCost(opts: {
  tenantId: string;
  from: string;
  to: string;
}): Promise<TenantActorCost> {
  const chunks = tenantChunks('getTenantActorCost', opts.from, opts.to);
  const bodies = await mapBounded(chunks, PROJECT_COST_CONCURRENCY, async (c) =>
    unwrapMetering<UpstreamActorCostResponse>(
      await meteringHttp.json<unknown>(
        `/api/costs/tenant/${encodeURIComponent(opts.tenantId)}/actors${qs({
          start: c.start,
          end: c.end,
        })}`,
        {
          headers: {
            ...(await getSecureAppsAuthenticator().getAuthHeader()),
            'X-Tenant-Id': opts.tenantId,
          },
        },
      ),
    ),
  );
  let total = 0;
  const rows = new Map<string, TenantActorCostRow>();
  for (const body of bodies) {
    total += micros(body?.total_cost_usd);
    for (const line of body?.by_actor ?? []) {
      const aid = String(line.actor_id).toLowerCase();
      const acc = rows.get(aid) ?? {
        actor_id: aid,
        cost_usd: 0,
        byo_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
      };
      const c = micros(line.cost_usd);
      acc.cost_usd += c;
      if (line.byo) acc.byo_cost_usd += c;
      acc.input_tokens += line.input_tokens ?? 0;
      acc.output_tokens += line.output_tokens ?? 0;
      acc.request_count += line.request_count ?? 0;
      rows.set(aid, acc);
    }
  }
  for (const r of rows.values()) {
    r.cost_usd = usd(r.cost_usd);
    r.byo_cost_usd = usd(r.byo_cost_usd);
  }
  return {
    total_cost_usd: usd(total),
    by_actor: [...rows.values()],
    upstream_calls: chunks.length,
  };
}

/** GET /api/usage/tenant/{tenant_id}/series — tenant-scoped time-series. */
export async function getTenantUsageSeries(opts: {
  tenantId: string;
  window: string;
  granularity: 'hourly' | 'daily';
}): Promise<UpstreamUsageSeriesResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/usage/tenant/${encodeURIComponent(opts.tenantId)}/series${qs({
      window: opts.window,
      granularity: opts.granularity,
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamUsageSeriesResponse>(body);
}

/** GET /api/usage/tenant/{tenant_id}/breakdown — tenant-scoped per-service. */
export async function getTenantUsageBreakdown(opts: {
  tenantId: string;
  window: string;
}): Promise<UpstreamUsageBreakdownResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/usage/tenant/${encodeURIComponent(opts.tenantId)}/breakdown${qs({
      window: opts.window,
    })}`,
    tenantOverrideHeader(opts.tenantId),
  );
  return unwrapMetering<UpstreamUsageBreakdownResponse>(body);
}

/**
 * GET /api/admin/usage/system — super-admin system-wide rollup.
 *
 * Crosses every tenant; ignores X-Tenant-Id upstream. Caller is
 * responsible for gating to super-admin users; billing enforces the
 * `license-admin` role independently — and this is the ONLY call in this
 * module that has to prove it.
 *
 * THE ONE CALL HERE THAT CARRIES A CREDENTIAL, and deliberately so.
 * `meteringHttp` is shared by every function in this file and sends no
 * Authorization header. That is correct for the me-scoped reads, which billing
 * authorises from the forwarded `X-Subject-Id` / `X-Tenant-Id` — they work
 * today and giving the whole client an admin bearer would silently change how
 * they are authorised. This route is different: it is guarded by billing's
 * `require_admin` (billing_service/src/auth_deps.py), which demands a Keycloak
 * JWT carrying `license-admin`. Sending none produced a 401 that fr reported to
 * the operator as a 500 — a message pointing at fr, the one place the fault was
 * not.
 *
 * The portal-realm authenticator cannot serve here: billing verifies against
 * the `secure-apps` realm and does not know the portal signing key. Measured
 * from the running pod 2026-08-27: the secure-apps service account holds
 * `license-admin`, and this endpoint answers 200 with its bearer.
 */
export async function getAdminSystemUsage(opts: {
  window: 'today' | 'month' | string;
}): Promise<UpstreamSystemUsageResponse> {
  const body = await meteringHttp.json<unknown>(
    `/api/admin/usage/system${qs({ window: opts.window })}`,
    { headers: await getSecureAppsAuthenticator().getAuthHeader() },
  );
  return unwrapMetering<UpstreamSystemUsageResponse>(body);
}

/**
 * GET /api/budget/status/me — active tenant's budget aggregate.
 *
 * Requires X-Subject-Id + X-Tenant-Id headers; both injected by HttpClient
 * from the request ALS frame.
 */
export async function getMyBudgetStatus(): Promise<UpstreamBudgetAggregateStatus> {
  const body = await meteringHttp.json<unknown>('/api/budget/status/me');
  return unwrapMetering<UpstreamBudgetAggregateStatus>(body);
}

// ----- Window helpers ------------------------------------------------------

export function todayWindow(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return { start, end: now };
}

export function monthWindow(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  return { start, end: now };
}

// ----- Cross breakdown: project × member × funding (billing-service #263) -----
//
// billing `GET /api/usage/breakdown` reads ONE rollup (billing_cost_usage_daily)
// that carries project, actor, app, funding, provider and model together, so a
// project × member × funding table is a single aggregate rather than a join of
// the two cost rollups /api/tenant/billing uses.
//
//   /api/usage/breakdown     per-MEMBER data: `require_service_caller` (the
//                            secure-apps SA bearer, like `getTenantActorCost`)
//                            + X-Tenant-Id, which billing pins the read to.
//   /api/usage/breakdown/me  self-service: X-Tenant-Id + X-Actor-Id, no bearer.
//
// Rows: `dims` holds exactly the requested dimensions; project/actor/app are
// null for the unattributed bucket; funding ∈ local_gpu | platform_external |
// tenant_byo | unknown; `cost_usd` is a decimal STRING. Data is the daily
// rollup — complete UTC days only. ≤ 5000 rows (`truncated`), totals cover all.

export interface UpstreamUsageCrossRow {
  dims: Record<string, string | null>;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
}

export interface UpstreamUsageCrossBreakdown {
  tenant_id: string;
  from: string;
  to: string;
  group_by: string[];
  actor_id?: string | null;
  totals: { events: number; input_tokens: number; output_tokens: number; cost_usd: string };
  rows: UpstreamUsageCrossRow[];
  truncated: boolean;
}

/** Query params billing accepts on both breakdown routes (CSV values). */
export interface UsageCrossQuery {
  from?: string;
  to?: string;
  group_by?: string;
  project_id?: string;
  actor_id?: string;
  funding?: string;
  app?: string;
  provider?: string;
  model?: string;
}

/** Tenant-wide cross breakdown, pinned to `tenantId` by X-Tenant-Id. Caller gates. */
export async function getTenantUsageCrossBreakdown(opts: {
  tenantId: string;
  query: UsageCrossQuery;
}): Promise<UpstreamUsageCrossBreakdown> {
  return unwrapMetering<UpstreamUsageCrossBreakdown>(
    await meteringHttp.json<unknown>(`/api/usage/breakdown${qs({ ...opts.query })}`, {
      headers: {
        ...(await getSecureAppsAuthenticator().getAuthHeader()),
        'X-Tenant-Id': opts.tenantId,
      },
    }),
  );
}

/** The caller's OWN cross breakdown: `actorId` is the verified Keycloak sub. */
export async function getMyUsageCrossBreakdown(opts: {
  tenantId: string;
  actorId: string;
  query: Omit<UsageCrossQuery, 'actor_id'>;
}): Promise<UpstreamUsageCrossBreakdown> {
  return unwrapMetering<UpstreamUsageCrossBreakdown>(
    await meteringHttp.json<unknown>(`/api/usage/breakdown/me${qs({ ...opts.query })}`, {
      headers: { 'X-Tenant-Id': opts.tenantId, 'X-Actor-Id': opts.actorId },
    }),
  );
}
