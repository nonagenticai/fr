// src/routes/me/usage.ts
//
// Foundation Plan 4 Lane A — `/settings/usage` page backend.
//
// Surfaces four GET endpoints that aggregate the authenticated user's
// metering data:
//
//   GET /api/me/usage/summary?window=today|month
//     → { window, requests, tokens, internal_cost_usd, billed_cost_usd, cost_basis,
//         today_provisional | null, today_provisional_unavailable_reason }
//     today_provisional = billing /api/costs/provisional for the request tenant
//     (spend not yet rolled up), same cost lens; its failure nulls only it.
//
//   GET /api/me/usage/series?window=30d&granularity=hourly|daily
//     → { window, granularity, buckets: [{ts, requests, tokens, cost_usd}],
//         cost_unavailable }
//     Now backed by the real upstream `GET /api/usage/me/series`. Hourly
//     granularity returns cost_unavailable=true (no hourly cost rollup
//     upstream); daily returns real cost figures from cost_daily.
//
//   GET /api/me/usage/breakdown?window=30d
//     → { window, services: [{service, requests, tokens, cost_usd}],
//         cost_unavailable }
//     Now backed by the real upstream `GET /api/usage/me/breakdown`.
//     cost_unavailable is forwarded so the UI can render `—` for cost
//     cells instead of $0.00 when the upstream has no cost data.
//
//   GET /api/me/usage/quota
//     → { requests_per_month: {quota:null, consumed},
//         tokens_per_month:   {quota:null, consumed},
//         cost_usd_per_month: {quota:null, consumed} }
//     The upstream metering_service has no per-user quota concept
//     today — quotas live on `licenses` (per-license, not per-user).
//     We return null quotas (= unmetered) and the user's consumption
//     for the current calendar month so the UI can render a "no quota
//     set" panel without misleading numbers.
//
// Auth: every handler runs `validateAuth` and lets UnauthorizedError
// bubble; the global error handler maps it to 401. The X-Subject-Id
// the upstream needs is injected by HttpClient from the
// AsyncLocalStorage request context (see middleware/request-context).

import { inArray } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { applyMarkup } from '../../lib/money';
import {
  isIntegrationError,
  integrationErrorResponse,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import { db, workspaces } from '../../db/client';
import { isValidUuid } from '../../utils/tenant';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { listAccessibleTenants } from '../../lib/accessible-tenants';
import { getRequestContext, tryGetRequestContext } from '../../middleware/request-context';
import {
  getTenantUsageRange,
  getTenantCostsRange,
  getTenantUsageSeries,
  getTenantUsageBreakdown,
  getMyBudgetStatus,
  getAdminSystemUsage,
  getCostByCorrelation,
  getProvisionalCosts,
  todayWindow,
  monthWindow,
  type UpstreamCostResponse,
  type UpstreamProvisionalCosts,
  type UpstreamSystemUsageResponse,
  type UpstreamSystemTenantUsage,
  type UpstreamBudgetAggregateStatus,
  type UpstreamCostByCorrelationResponse,
  type CostCorrelationGroupBy,
} from '../../integrations/metering/usage';
import {
  listAccessCharges,
  getTenantAllowanceUsage,
  type PricingRow,
  type TenantAllowanceUsageEntry,
} from '../../services/pricing-admin';

// ----- Response envelopes ---------------------------------------------------

export interface UsageSummaryResponse {
  window: 'today' | 'month';
  requests: number;
  tokens: number;
  /**
   * Raw provider (incurred) cost — what we paid the external provider.
   * SUPER-ADMIN ONLY: omitted for everyone else (pre-markup cost is internal
   * margin data; a customer sees `billed_cost_usd`).
   */
  internal_cost_usd?: string;
  /**
   * Billed cost — internal × (1 + tenant.markup_pct/100). Non-super-admin UIs
   * display this number; super-admin UIs can show internal_cost_usd alongside.
   * `null` when the tenant's markup cannot be established (`cost_basis:
   * 'unavailable'`) — never the incurred figure under a billed label.
   */
  billed_cost_usd: string | null;
  /** What `billed_cost_usd` is: `'billed'`, or `'unavailable'` (null amount). */
  cost_basis: CustomerCostBasis;
  /**
   * The request tenant's spend since the last settled rollup day (billing
   * `GET /api/costs/provisional`), which `billed_cost_usd` above does not yet
   * include. `null` when it could not be read — never zeros — with the reason in
   * `today_provisional_unavailable_reason`.
   */
  today_provisional: TodayProvisional | null;
  today_provisional_unavailable_reason: TodayProvisionalUnavailableReason | null;
}

/**
 * Today's not-yet-rolled-up spend, through the SAME cost lens as the page's other
 * figures: incurred for a super-admin, billed (× markup) for everyone else, and
 * `cost_usd: null` (`cost_basis: 'unavailable'`) when the markup is unknown.
 */
export interface TodayProvisional {
  currency: string;
  cost_usd: string | null;
  cost_basis: 'incurred' | CustomerCostBasis;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  settled_through: string | null;
  since: string | null;
  as_of: string;
}

type TodayProvisionalUnavailableReason =
  | 'no_active_tenant'
  /** billing answered 404: the endpoint is not deployed yet. */
  | 'billing_not_deployed'
  /** any other billing failure (5xx, timeout, network). */
  | 'billing_unreachable'
  /** billing answered without a readable cost / as_of. */
  | 'billing_malformed';

/** `'unavailable'` = the tenant's markup is unknown, so the billed amount is withheld. */
export type CustomerCostBasis = 'billed' | 'unavailable';

export interface UsageSeriesBucket {
  ts: string;
  requests: number;
  tokens: number;
  /** Incurred cost — SUPER-ADMIN ONLY, omitted for everyone else. */
  cost_usd?: string;
  /** null when the markup is unknown and billing did not price the bucket itself. */
  billed_cost_usd: string | null;
  // Estimated public provider cost for BYO usage; absent when none applies.
  provider_estimate_usd?: string | null;
}

export interface UsageSeriesResponse {
  window: '30d';
  granularity: 'hourly' | 'daily';
  buckets: UsageSeriesBucket[];
  /**
   * Forwarded from the upstream — true when the granularity has no
   * cost rollup (hourly today) or the cost_daily table is empty for
   * the window. UI should render `—` for cost cells in that case
   * instead of $0.00.
   */
  cost_unavailable: boolean;
  markup_pct: number | null;
  /** `'unavailable'` when any bucket's billed amount was withheld (markup unknown). */
  cost_basis: CustomerCostBasis;
}

export interface UsageBreakdownService {
  service: string;
  requests: number;
  tokens: number;
  /** Incurred cost — SUPER-ADMIN ONLY, omitted for everyone else. */
  cost_usd?: string;
  /** null when the markup is unknown and billing did not price the row itself. */
  billed_cost_usd: string | null;
  // Estimated public provider cost for BYO usage on this service.
  provider_estimate_usd?: string | null;
}

export interface UsageBreakdownResponse {
  window: '30d';
  services: UsageBreakdownService[];
  cost_unavailable: boolean;
  markup_pct: number | null;
  /** `'unavailable'` when any row's billed amount was withheld (markup unknown). */
  cost_basis: CustomerCostBasis;
}

export interface AdminSystemUsageResponse extends UpstreamSystemUsageResponse {}

interface MyBudgetStatusResponse extends UpstreamBudgetAggregateStatus {}

export interface QuotaConsumed {
  quota: number | null;
  consumed: number;
}

export interface UsageQuotaResponse {
  requests_per_month: QuotaConsumed;
  tokens_per_month: QuotaConsumed;
  /**
   * `consumed`: incurred for a super-admin, billed for everyone else, `null`
   * (`cost_basis: 'unavailable'`) when the markup cannot be established.
   */
  cost_usd_per_month: {
    quota: number | null;
    consumed: string | null;
    cost_basis: 'incurred' | CustomerCostBasis;
  };
}

/** One access charge on the caller's plan (the ACCESS-billing axis). */
interface MyPlanAccessCharge {
  service_key: string | null;
  amount_usd: string;
  cadence: string;
  /** Monthly included-usage credit (USD) bundled into this charge; null = none. */
  included_cost_usd: string | null;
  /**
   * Month-to-date usage drawn against THIS product's allowance and what's left,
   * from billing's per-product compute-on-read fold. `null` when billing can't
   * report it (older deploy) — the tile then omits the per-product line.
   * Billing's fold is INCURRED cost; a non-super-admin gets it marked up
   * (`applyMarkup`), or `null` when the tenant's markup is unknown.
   */
  used_usd: string | null;
  remaining_usd: string | null;
}

export interface MyPlanResponse {
  /** The active tenant's fixed access charges (product-scoped or tenant-wide). */
  access_charges: MyPlanAccessCharge[];
  /** Sum of the `monthly`-cadence charges — the recurring "$X/mo" figure. */
  monthly_total_usd: string;
  /** Sum of the `monthly`-cadence included-usage credits — "$X/mo included". */
  monthly_included_usd: string;
  /**
   * Month-to-date usage consumed against `monthly_included_usd` (clamped to the
   * allowance) and what's left. `0.00`/`0.00` when there's no included credit.
   *
   * Owner ruling: no pre-markup (incurred) cost reaches a non-super-admin. The
   * allowance nets against INCURRED cost on the billing side, but a customer is
   * shown the BILLED (marked-up) consumption; a super-admin (verified frame flag
   * `callerIsSuperAdmin === true`) sees incurred. Markup unknown → both `null`
   * with `cost_basis: 'unavailable'` — never the incurred figure.
   */
  included_used_usd: string | null;
  included_remaining_usd: string | null;
  /** What the usage figures are: incurred (super-admin), billed, or withheld. */
  cost_basis: 'incurred' | CustomerCostBasis;
}

// ----- Helpers --------------------------------------------------------------

function pickSummaryWindow(req: Request): 'today' | 'month' {
  const w = new URL(req.url).searchParams.get('window');
  return w === 'month' ? 'month' : 'today';
}

function pickGranularity(req: Request): 'hourly' | 'daily' {
  const g = new URL(req.url).searchParams.get('granularity');
  return g === 'hourly' ? 'hourly' : 'daily';
}

function tokensTotal(c: UpstreamCostResponse): number {
  return (c.total_input_tokens ?? 0) + (c.total_output_tokens ?? 0);
}

/**
 * Apply per-tenant markup to a decimal-string USD value. Returns the
 * cents-quantized result as a string. `markupPct=null` returns the
 * input unchanged (no tenant context → no markup to apply).
 *
 * Mirrors `services/billing.py::apply_markup` exactly — both must use
 * the same rounding so the summary view and the series view agree.
 */

// ----- Handlers -------------------------------------------------------------

/** GET /api/me/usage/summary?window=today|month */
export async function handleGetMyUsageSummary(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const superAdmin = isSuperAdmin(user);
  const window = pickSummaryWindow(req);
  const range = window === 'month' ? monthWindow() : todayWindow();
  // Scope to the active request context's tenant. The HttpClient also
  // forwards X-Tenant-Id from ALS automatically, but passing it
  // explicitly here makes the per-tenant contract visible at the route
  // boundary (and lets the breakdown handler reuse the same call shape
  // with an override).
  const tenantId = tryActiveTenantId();
  if (!tenantId) {
    const empty: UsageSummaryResponse = {
      window,
      requests: 0,
      tokens: 0,
      ...(superAdmin ? { internal_cost_usd: '0' } : {}),
      billed_cost_usd: '0',
      cost_basis: 'billed',
      today_provisional: null,
      today_provisional_unavailable_reason: 'no_active_tenant',
    };
    return jsonResponse(empty);
  }
  // Pull markup_pct from the tenant breakdown endpoint alongside usage/cost.
  // It surfaces markup_pct for the active tenant — using its markup value
  // keeps summary + chart + breakdown all consistent. 404-safe so an older
  // metering deploy (no tenant breakdown endpoint yet) keeps this working.
  // Today's provisional spend is read beside them; its failure never fails the
  // summary (readProvisionalCosts does not throw).
  const [usage, costs, breakdown, provisional] = await Promise.all([
    getTenantUsageRange({ tenantId, ...range, granularity: 'daily' }),
    getTenantCostsRange({ tenantId, ...range }),
    fetchTenantMarkupPct(tenantId),
    readProvisionalCosts(tenantId),
  ]);
  const markupPct = breakdown;
  const internal = costs.total_cost_usd ?? '0';
  const body: UsageSummaryResponse = {
    window,
    requests: usage.total_requests ?? 0,
    tokens: tokensTotal(costs),
    ...(superAdmin ? { internal_cost_usd: internal } : {}),
    // An unknown markup is NOT a zero markup, and the incurred figure is never
    // shown under a billed label (owner ruling: no pre-markup cost reaches a
    // non-super-admin). The amount is withheld instead; a super-admin still has
    // `internal_cost_usd`.
    billed_cost_usd: markupPct === null ? null : applyMarkup(internal, markupPct),
    cost_basis: markupPct === null ? 'unavailable' : 'billed',
    ...priceProvisional(provisional, superAdmin, markupPct),
  };
  return jsonResponse(body);
}

type ProvisionalRead =
  | { raw: UpstreamProvisionalCosts }
  | { reason: TodayProvisionalUnavailableReason };

/**
 * billing's provisional read for the tenant, or the reason it is unavailable.
 * NEVER throws: the endpoint is newer than this code (a 404 means "not
 * deployed"), and a missing provisional figure must not take the settled ones
 * down with it.
 */
async function readProvisionalCosts(tenantId: string): Promise<ProvisionalRead> {
  try {
    return { raw: await getProvisionalCosts({ tenantId }) };
  } catch (err) {
    const reason = isUpstreamStatus(err, 404) ? 'billing_not_deployed' : 'billing_unreachable';
    reportSwallowedFailure(err, {
      service: 'billing',
      method: 'GET',
      path: '/api/costs/provisional',
      degradedTo: `today_provisional=null (${reason})`,
    });
    return { reason };
  }
}

/** Price the provisional read through the caller's cost lens (same as the summary's). */
function priceProvisional(
  read: ProvisionalRead,
  superAdmin: boolean,
  markupPct: number | null,
): Pick<UsageSummaryResponse, 'today_provisional' | 'today_provisional_unavailable_reason'> {
  if ('reason' in read) return { today_provisional: null, today_provisional_unavailable_reason: read.reason };
  const raw = read.raw;
  const incurred = Number.parseFloat(String(raw?.cost ?? ''));
  if (!Number.isFinite(incurred) || typeof raw?.as_of !== 'string' || raw.as_of === '') {
    return { today_provisional: null, today_provisional_unavailable_reason: 'billing_malformed' };
  }
  const decimal = incurred.toFixed(6);
  // Cents for every caller (applyMarkup's rounding; markup 0 = the incurred figure unchanged), so a
  // super-admin and a customer read the same precision as the summary's billed figure.
  const priced: Pick<TodayProvisional, 'cost_usd' | 'cost_basis'> = superAdmin
    ? { cost_usd: applyMarkup(decimal, 0), cost_basis: 'incurred' }
    : markupPct === null
      ? { cost_usd: null, cost_basis: 'unavailable' }
      : { cost_usd: applyMarkup(decimal, markupPct), cost_basis: 'billed' };
  return {
    today_provisional: {
      currency: raw.currency ?? 'USD',
      ...priced,
      calls: raw.calls ?? 0,
      input_tokens: raw.tokens_in ?? 0,
      output_tokens: raw.tokens_out ?? 0,
      settled_through: raw.settled_through ?? null,
      since: raw.since ?? null,
      as_of: raw.as_of,
    },
    today_provisional_unavailable_reason: null,
  };
}

/**
 * A row's billed amount: billing's own pre-computed figure when it sent one,
 * else incurred × markup, else — markup unknown — `null` (and `onWithheld` is
 * called). Never the incurred figure: that is what the series/breakdown used
 * to degrade to, under the `billed_cost_usd` label, for every caller.
 */
function billedOrWithheld(
  upstreamBilled: string | null | undefined,
  incurred: string,
  markupPct: number | null,
  onWithheld: () => void,
): string | null {
  if (upstreamBilled !== null && upstreamBilled !== undefined) return upstreamBilled;
  if (markupPct === null) {
    onWithheld();
    return null;
  }
  return applyMarkup(incurred, markupPct);
}

/**
 * The active tenant's markup_pct from metering's tenant breakdown, or null on a
 * 404 (an older metering deploy). Shared by every surface that turns incurred
 * cost into billed cost so they all agree.
 *
 * ⚠️ 404 ONLY. This catch used to be bare `() => null`, which meant ANY
 * metering failure produced `markupPct = null`, and `applyMarkup` returns its
 * input unchanged for null -- so billed === incurred. A transient upstream
 * fault silently billed the tenant AT COST, in a response byte-identical to a
 * legitimately zero-markup tenant.
 */
export async function fetchTenantMarkupPct(tenantId: string): Promise<number | null> {
  try {
    const breakdown = await getTenantUsageBreakdown({ tenantId, window: '30d' });
    return breakdown?.markup_pct ?? null;
  } catch (err) {
    if (!isUpstreamStatus(err, 404)) throw err;
    reportSwallowedFailure(err, {
      service: 'metering',
      method: 'GET',
      path: '/tenant-usage-breakdown',
      degradedTo: 'markup_pct=null (billed cost withheld for non-super-admins: cost_basis=unavailable)',
    });
    return null;
  }
}

/** Pull tenantId from ALS — undefined when no request frame is active. */
function tryActiveTenantId(): string | undefined {
  try {
    return getRequestContext().tenantId;
  } catch {
    return undefined;
  }
}

/**
 * True when the error is an upstream HTTP failure with the given status.
 * Used to fall back to an empty payload on 404 (i.e. an old metering
 * deploy that doesn't yet ship the series/breakdown endpoints).
 */
function isUpstreamStatus(err: unknown, status: number): boolean {
  return isIntegrationError(err) && err.upstreamStatus === status;
}

// --- "Your plan" (ACCESS-billing axis) -------------------------------------
/** Month-to-date total incurred (internal) cost USD for the tenant. */
async function getMonthCostsUsd(tenantId: string): Promise<string> {
  const costs = await getTenantCostsRange({ tenantId, ...monthWindow() });
  return costs.total_cost_usd ?? '0';
}

/**
 * How the plan's usage figures reach the caller: `incurred` (super-admin, as
 * billing folds them), `billed` (incurred × markup), or `unavailable` (markup
 * unknown — every usage figure is withheld).
 */
type PlanCostLens =
  | { basis: 'incurred' }
  | { basis: 'billed'; markupPct: number }
  | { basis: 'unavailable' };

function decimalOrZero(v: unknown): string {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

/**
 * Billing's per-product fold is INCURRED. For a customer: used is marked up,
 * and remaining is recomputed from the marked-up CONSUMPTION of that bucket
 * (allowance − remaining is what the invoice ladder drew from it, so the
 * product→tenant-wide spill is preserved). Withheld when the markup is unknown.
 */
function planUsageLine(
  usage: TenantAllowanceUsageEntry | undefined,
  lens: PlanCostLens,
): { used_usd: string | null; remaining_usd: string | null } {
  if (!usage) return { used_usd: null, remaining_usd: null };
  if (lens.basis === 'incurred') return { used_usd: usage.used_usd, remaining_usd: usage.remaining_usd };
  if (lens.basis === 'unavailable') return { used_usd: null, remaining_usd: null };
  const allowance = Number.parseFloat(decimalOrZero(usage.allowance_usd));
  const consumed = Math.max(0, allowance - Number.parseFloat(decimalOrZero(usage.remaining_usd)));
  const billedConsumed = Number.parseFloat(applyMarkup(consumed.toFixed(2), lens.markupPct));
  return {
    used_usd: applyMarkup(decimalOrZero(usage.used_usd), lens.markupPct),
    remaining_usd: Math.max(0, allowance - billedConsumed).toFixed(2),
  };
}

function toAccessCharge(
  row: PricingRow,
  usageByKey: Map<string, TenantAllowanceUsageEntry>,
  lens: PlanCostLens,
): MyPlanAccessCharge {
  const sk = row.service_key;
  const inc = row.included_cost_usd;
  const serviceKey = typeof sk === 'string' ? sk : null;
  const usage = usageByKey.get(serviceKey ?? '');
  return {
    service_key: serviceKey,
    amount_usd: String(row.amount_usd ?? '0'),
    cadence: typeof row.cadence === 'string' ? row.cadence : 'monthly',
    included_cost_usd: inc == null ? null : String(inc),
    ...planUsageLine(usage, lens),
  };
}

/**
 * GET /api/me/plan — the active tenant's ACCESS charges (paid-license fees).
 *
 * Reads billing's admin `/api/config/access-charges` via the secure-apps SA and
 * filters to the caller's tenant (resolved server-side from the ALS request
 * context) — the browser never sees other tenants' rows. 404-safe so an older
 * billing deploy (no access-charges endpoint yet) returns an empty plan instead
 * of erroring the usage page.
 */
export async function handleGetMyPlan(req: Request): Promise<Response> {
  await validateAuth(req);
  const tenantId = tryActiveTenantId();
  // The verified frame flag (set from validated claims), never a body/header.
  const superAdmin = tryGetRequestContext()?.callerIsSuperAdmin === true;
  const empty: MyPlanResponse = {
    access_charges: [],
    monthly_total_usd: '0.00',
    monthly_included_usd: '0.00',
    included_used_usd: '0.00',
    included_remaining_usd: '0.00',
    cost_basis: superAdmin ? 'incurred' : 'billed',
  };
  if (!tenantId) return jsonResponse(empty);

  let rows: PricingRow[];
  try {
    rows = await listAccessCharges();
  } catch (err) {
    if (isUpstreamStatus(err, 404)) return jsonResponse(empty);
    throw err;
  }

  // Per-product live used/remaining fold. Only worth a call when the tenant has
  // any charge to annotate. 404-safe (older billing without the fold) → the
  // per-product line is simply omitted; the tenant-wide summary below still works.
  const usageByKey = new Map<string, TenantAllowanceUsageEntry>();
  const hasMine = rows.some((r) => r.tenant_id === tenantId);
  // A customer's usage figures are marked up; resolve the markup once, only when
  // there is something to price.
  let lens: PlanCostLens = superAdmin ? { basis: 'incurred' } : { basis: 'billed', markupPct: 0 };
  if (hasMine && !superAdmin) {
    const markupPct = await fetchTenantMarkupPct(tenantId);
    lens = markupPct === null ? { basis: 'unavailable' } : { basis: 'billed', markupPct };
  }
  if (hasMine) {
    try {
      for (const e of await getTenantAllowanceUsage(tenantId)) {
        usageByKey.set(e.service_key ?? '', e);
      }
    } catch (err) {
      if (!isUpstreamStatus(err, 404)) throw err;
    }
  }

  const mine = rows.filter((r) => r.tenant_id === tenantId).map((r) => toAccessCharge(r, usageByKey, lens));
  const monthly = mine.filter((c) => c.cadence === 'monthly');
  const monthlyTotal = monthly.reduce(
    (sum, c) => sum + (Number.parseFloat(c.amount_usd) || 0),
    0,
  );
  const monthlyIncluded = monthly.reduce(
    (sum, c) => sum + (Number.parseFloat(c.included_cost_usd ?? '') || 0),
    0,
  );

  // Month-to-date usage against the included allowance. Only fetch costs when
  // there's a credit to measure against. 404-safe (older metering deploy) → 0.
  // Incurred for a super-admin, marked up for everyone else (owner ruling), and
  // withheld outright when the markup is unknown.
  let usedUsd = 0;
  if (monthlyIncluded > 0 && lens.basis !== 'unavailable') {
    try {
      const incurred = decimalOrZero(await getMonthCostsUsd(tenantId));
      const shown =
        lens.basis === 'billed' ? Number.parseFloat(applyMarkup(incurred, lens.markupPct)) : Number.parseFloat(incurred);
      usedUsd = Math.min(Math.max(shown, 0), monthlyIncluded);
    } catch (err) {
      if (!isUpstreamStatus(err, 404)) throw err;
    }
  }
  const remainingUsd = Math.max(0, monthlyIncluded - usedUsd);
  const withheld = lens.basis === 'unavailable';

  const body: MyPlanResponse = {
    access_charges: mine,
    monthly_total_usd: monthlyTotal.toFixed(2),
    monthly_included_usd: monthlyIncluded.toFixed(2),
    included_used_usd: withheld ? null : usedUsd.toFixed(2),
    included_remaining_usd: withheld ? null : remainingUsd.toFixed(2),
    cost_basis: lens.basis,
  };
  return jsonResponse(body);
}

/** GET /api/me/usage/series?window=30d&granularity=hourly|daily */
export async function handleGetMyUsageSeries(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const superAdmin = isSuperAdmin(user);
  const granularity = pickGranularity(req);
  const tenantId = tryActiveTenantId();
  if (!tenantId) {
    const empty: UsageSeriesResponse = {
      window: '30d',
      granularity,
      buckets: [],
      cost_unavailable: true,
      markup_pct: null,
      cost_basis: 'billed',
    };
    return jsonResponse(empty);
  }
  try {
    const upstream = await getTenantUsageSeries({ tenantId, window: '30d', granularity });
    const markupPct = upstream.markup_pct ?? null;
    let withheld = false;
    const body: UsageSeriesResponse = {
      window: '30d',
      granularity,
      buckets: upstream.buckets.map((b) => {
        const cost = b.cost_usd ?? '0';
        return {
          ts: b.ts,
          requests: b.requests ?? 0,
          tokens: b.tokens ?? 0,
          // Incurred cost is internal margin data: super-admin only.
          ...(superAdmin ? { cost_usd: cost } : {}),
          // Prefer upstream's pre-computed billed; fall back to local
          // applyMarkup. Markup unknown too: WITHHELD (null), never incurred.
          billed_cost_usd: billedOrWithheld(b.billed_cost_usd, cost, markupPct, () => {
            withheld = true;
          }),
          // Raw passthrough — the BYO provider list-price estimate is not
          // subject to fr's markup (it's the tenant's own provider cost).
          provider_estimate_usd: b.provider_estimate_usd ?? null,
        };
      }),
      cost_unavailable: upstream.cost_unavailable,
      // markup_pct + billed would let a customer recompute incurred cost.
      markup_pct: superAdmin ? markupPct : null,
      cost_basis: 'billed',
    };
    if (withheld) body.cost_basis = 'unavailable';
    return jsonResponse(body);
  } catch (err) {
    // Old metering_service deploys (pre-series endpoint) return 404.
    // Surface an empty-but-valid payload so the page still renders;
    // mark cost_unavailable so the UI doesn't show $0.00 cells.
    if (isUpstreamStatus(err, 404)) {
      const body: UsageSeriesResponse = {
        window: '30d',
        granularity,
        buckets: [],
        cost_unavailable: true,
        markup_pct: null,
        cost_basis: 'billed',
      };
      return jsonResponse(body);
    }
    throw err;
  }
}

/** GET /api/me/usage/breakdown?window=30d */
export async function handleGetMyUsageBreakdown(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const superAdmin = isSuperAdmin(user);
  const tenantId = tryActiveTenantId();
  if (!tenantId) {
    const empty: UsageBreakdownResponse = {
      window: '30d',
      services: [],
      cost_unavailable: true,
      markup_pct: null,
      cost_basis: 'billed',
    };
    return jsonResponse(empty);
  }
  try {
    const upstream = await getTenantUsageBreakdown({ tenantId, window: '30d' });
    const markupPct = upstream.markup_pct ?? null;
    let withheld = false;
    const body: UsageBreakdownResponse = {
      window: '30d',
      services: upstream.services.map((s) => {
        const cost = s.cost_usd ?? '0';
        return {
          service: s.service,
          requests: s.requests ?? 0,
          tokens: s.tokens ?? 0,
          ...(superAdmin ? { cost_usd: cost } : {}),
          billed_cost_usd: billedOrWithheld(s.billed_cost_usd, cost, markupPct, () => {
            withheld = true;
          }),
          provider_estimate_usd: s.provider_estimate_usd ?? null,
        };
      }),
      cost_unavailable: upstream.cost_unavailable,
      markup_pct: superAdmin ? markupPct : null,
      cost_basis: 'billed',
    };
    if (withheld) body.cost_basis = 'unavailable';
    return jsonResponse(body);
  } catch (err) {
    if (isUpstreamStatus(err, 404)) {
      const body: UsageBreakdownResponse = {
        window: '30d',
        services: [],
        cost_unavailable: true,
        markup_pct: null,
        cost_basis: 'billed',
      };
      return jsonResponse(body);
    }
    throw err;
  }
}

/**
 * GET /api/me/budget/status — active tenant's budget for the caller.
 *
 * Thin proxy onto metering /api/budget/status/me. HttpClient forwards
 * X-Subject-Id + X-Tenant-Id from ALS automatically; metering returns
 * 400 if there's no active tenant context.
 */
export async function handleGetMyBudgetStatus(req: Request): Promise<Response> {
  await validateAuth(req);
  try {
    const status = await getMyBudgetStatus();
    return jsonResponse(status);
  } catch (err) {
    // Old metering deploys return 404 for this path; surface an empty
    // aggregate so the UI can render "no budget configured" cleanly.
    if (isUpstreamStatus(err, 404)) {
      const empty: MyBudgetStatusResponse = {
        tenant_id: tryActiveTenantId() ?? '',
        total_remaining: 0,
        budget_count: 0,
        next_expiry: null,
        budgets: [],
      };
      return jsonResponse(empty);
    }
    throw err;
  }
}

/**
 * GET /api/admin/usage/system — super-admin system-wide aggregate.
 *
 * Gated on the local super-admin allowlist (same predicate as
 * `/api/me/usage/by-tenant`). Metering re-checks `license-admin` on its
 * side — defence in depth.
 */
/**
 * Replace upstream's tenant label with fr's own, because fr's is better.
 *
 * billing writes `tenant_name = tenant_id` when it cannot resolve a name, and
 * that is worse than writing NULL: the frontend guards the mono id column with
 * `{#if t.tenant_name}`, so a UUID-shaped "name" satisfies the guard and the row
 * renders the same id TWICE — which reads as an fr rendering bug rather than a
 * missing name upstream.
 *
 * Measured in `billing_metering_events` 2026-09-06, last 30 days:
 *   9 of 10 tenants carry `tenant_name` == their own uuid   (4,446 rows)
 *   1 of 10 carries a real name                             (1,359 rows)
 *
 * fr holds the authoritative label for every one of them in `workspaces`, so it
 * does not need to trust the copy that travelled through another service. Same
 * defect shape as `user_roles.tenant_name`: a foreign/denormalized copy read in
 * preference to the local source of truth.
 *
 * A tenant fr genuinely does not know stays NULL and the UI shows the id — that
 * is honest, and the UI already renders that case correctly.
 */
async function withLocalTenantNames(
  rows: UpstreamSystemTenantUsage[],
): Promise<UpstreamSystemTenantUsage[]> {
  // ⚠️ The uuid filter is load-bearing, not defensive. `inArray` with a
  // malformed id raises `invalid input syntax for type uuid` in Postgres,
  // which would turn a display concern into a 500 on the whole page.
  const ids = [...new Set(rows.map((r) => r.tenant_id).filter(isValidUuid))];
  if (ids.length === 0) return rows;

  const known = new Map<string, string>();
  const found = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, ids));
  for (const w of found) if (w.name) known.set(w.id, w.name);

  return rows.map((r) => {
    const local = known.get(r.tenant_id);
    if (local) return { ...r, tenant_name: local };
    // Normalise every "upstream does not actually know the name" spelling to
    // NULL, because the template distinguishes them and the API must not.
    //
    //   * an id echoed back as a name — printing it would fill BOTH the name
    //     and the id column with the same uuid;
    //   * an EMPTY or whitespace-only string. billing's columns are NOT NULL
    //     (`billing_metering_events.tenant_name`, alembic 0001), so its
    //     write-time fix for a registry miss stores `''` rather than NULL.
    //
    // ⚠️ The empty case is the one that bites, and it is NOT hypothetical —
    // the billing lane is shipping that write now. The metering template reads
    //     {t.tenant_name ?? t.tenant_id}
    // and `''` is NOT nullish, so `??` keeps it and the cell renders BLANK —
    // strictly worse than the duplicated uuid this function was written to fix.
    // A `&&` truthiness guard (what this used to be) also misses it, because
    // `''` is falsy and never reaches the comparison.
    //
    // Normalising here rather than at the template keeps fr correct under all
    // three spellings — NULL, '', and uuid-echo — so this change and billing's
    // are order-independent; neither side has to land first.
    const name = typeof r.tenant_name === 'string' ? r.tenant_name.trim() : r.tenant_name;
    if (!name || name === r.tenant_id) return { ...r, tenant_name: null };
    return { ...r, tenant_name: name };
  });
}

export async function handleGetAdminSystemUsage(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  if (!isSuperAdmin(user)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  const window = new URL(req.url).searchParams.get('window') ?? 'month';
  try {
    const data = await getAdminSystemUsage({ window });
    const body: AdminSystemUsageResponse = {
      ...data,
      by_tenant: await withLocalTenantNames(data.by_tenant),
    };
    return jsonResponse(body);
  } catch (err) {
    // Report the UPSTREAM failure, do not launder it into a 500.
    //
    // Measured live 2026-08-27: billing-service answers this call with 401
    // (`UPSTREAM_UNAUTHORIZED`), and the operator saw only "500" — which reads
    // as "fr is broken" and sends you looking in the wrong service. The same
    // wrapper is already used by tools/analytics.ts and tools/n8n.ts; this
    // handler simply never had it.
    //
    // NB the 401 itself was fixed separately in #871: the admin call now
    // presents `getSecureAppsAuthenticator()`, whose service account holds the
    // `license-admin` realm role billing's `require_admin` demands. Verified
    // live 2026-09-06 — this page renders real numbers. This wrapper stays
    // because it is the right shape for the NEXT upstream failure, not because
    // that one is still open. (The previous version of this comment said fr's
    // HttpClient carried "no auth at all"; that is no longer true and would
    // send the next reader looking for a bug that has been closed.)
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    throw err;
  }
}

/** GET /api/me/usage/quota */
export async function handleGetMyUsageQuota(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const superAdmin = isSuperAdmin(user);
  // Per-user quota does NOT exist in metering_service today — the
  // schema's quota lives on `licenses.plan.quota_monthly`, which is
  // per-license. Until per-user quotas ship, surface null quotas
  // (= unmetered) plus current-month consumption so the UI can render
  // a "no per-user quota set" banner without inventing numbers.
  const range = monthWindow();
  const tenantId = tryActiveTenantId();
  if (!tenantId) {
    const empty: UsageQuotaResponse = {
      requests_per_month: { quota: null, consumed: 0 },
      tokens_per_month: { quota: null, consumed: 0 },
      cost_usd_per_month: { quota: null, consumed: '0', cost_basis: superAdmin ? 'incurred' : 'billed' },
    };
    return jsonResponse(empty);
  }
  const [usage, costs, markupPct] = await Promise.all([
    getTenantUsageRange({ tenantId, ...range, granularity: 'daily' }),
    getTenantCostsRange({ tenantId, ...range }),
    superAdmin ? Promise.resolve(null) : fetchTenantMarkupPct(tenantId),
  ]);
  const incurred = costs.total_cost_usd ?? '0';
  const body: UsageQuotaResponse = {
    requests_per_month: {
      quota: null,
      consumed: usage.total_requests ?? 0,
    },
    tokens_per_month: {
      quota: null,
      consumed: tokensTotal(costs),
    },
    cost_usd_per_month: superAdmin
      ? { quota: null, consumed: incurred, cost_basis: 'incurred' }
      : markupPct === null
        ? // Everyone else: billed — the same number the summary shows them, and
          // withheld there too when the markup is unknown.
          { quota: null, consumed: null, cost_basis: 'unavailable' }
        : { quota: null, consumed: applyMarkup(incurred, markupPct), cost_basis: 'billed' },
  };
  return jsonResponse(body);
}

// ----- Per-operation (by-correlation) cost ----------------------------------
//
// Fleet-wide cost-correlation read. fr stamps `X-Correlation-Id` (the
// per-request ALS correlation id) on every outbound LLM call, so billing's
// priced cost events are keyed by that same id — this surfaces them back per
// operation. Callers pass the correlation ids they already hold (e.g. the
// `correlation_id` recorded on `n8n_execution_mapping` when a workflow was
// triggered, or a graph-execution session id). Scoped to the active tenant.

const VALID_COST_GROUP_BY: ReadonlySet<CostCorrelationGroupBy> = new Set([
  'stage',
  'model',
  'provider',
  'correlation_id',
  'day',
]);

/**
 * `cost_usd` here is what the caller sees: for a super-admin the INCURRED
 * (pre-markup) figure billing priced from ProviderPricing; for everyone else the
 * BILLED figure (incurred × (1 + markup_pct/100), `applyMarkup`, the same rule
 * as the summary/series/breakdown), or `null` when the tenant's markup cannot be
 * established — never the incurred number under a billed label.
 * `cost_basis` says which one it is.
 */
interface CostByCorrelationResponse
  extends Omit<UpstreamCostByCorrelationResponse, 'total_cost_usd' | 'groups'> {
  total_cost_usd: string | null;
  groups: Array<
    Omit<UpstreamCostByCorrelationResponse['groups'][number], 'cost_usd'> & {
      cost_usd: string | null;
    }
  >;
  cost_basis: 'incurred' | 'billed' | 'unavailable';
}

/**
 * Group-by dimensions only a super-admin may request. `provider` is the raw
 * upstream provider that served the call — internal routing, not something the
 * customer chose — and per-provider dollars are exactly the cost breakdown the
 * owner ruling keeps from customers. Dropped (like an unknown dimension) for
 * everyone else.
 */
const SUPER_ADMIN_ONLY_COST_GROUP_BY: ReadonlySet<CostCorrelationGroupBy> = new Set(['provider']);

/**
 * GET /api/me/costs/by-correlation?ids=<uuid,…>&group_by=<dim,…>
 *
 * `ids` is a comma-separated list of correlation ids (max 500; we cap the
 * forwarded set defensively). `group_by` is optional and validated against
 * the billing-supported dimensions; unknown values are dropped. Returns a
 * zeroed response (no upstream call) when no ids are supplied. 404 from an
 * older billing deploy (pre-endpoint) is surfaced as the same zeroed shape so
 * the caller renders cleanly.
 */
export async function handleGetMyCostByCorrelation(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const superAdmin = isSuperAdmin(user);
  const params = new URL(req.url).searchParams;
  const ids = (params.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 500);
  const groupBy = (params.get('group_by') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is CostCorrelationGroupBy =>
      VALID_COST_GROUP_BY.has(s as CostCorrelationGroupBy) &&
      (superAdmin || !SUPER_ADMIN_ONLY_COST_GROUP_BY.has(s as CostCorrelationGroupBy)),
    );

  const empty: CostByCorrelationResponse = {
    total_cost_usd: '0',
    total_input_tokens: 0,
    total_output_tokens: 0,
    event_count: 0,
    groups: [],
    cost_basis: superAdmin ? 'incurred' : 'billed',
  };

  const tenantId = tryActiveTenantId();
  if (!tenantId || ids.length === 0) {
    return jsonResponse(empty);
  }
  try {
    const upstream = await getCostByCorrelation({ ids, groupBy, tenantId });
    // Additive to the grandfathered envelope (same top-level object, plus
    // `cost_basis`); only the cost VALUES differ for a non-super-admin.
    const data: CostByCorrelationResponse = superAdmin
      ? { ...upstream, cost_basis: 'incurred' }
      : await billedCostByCorrelation(upstream, tenantId);
    return jsonResponse(data satisfies CostByCorrelationResponse);
  } catch (err) {
    if (isUpstreamStatus(err, 404)) {
      return jsonResponse(empty);
    }
    throw err;
  }
}

/**
 * The customer's view of a by-correlation response: every dollar figure turned
 * from incurred into billed with the tenant's markup (same `applyMarkup` rule
 * as the summary/series/breakdown), or withheld (`null`, `cost_basis:
 * 'unavailable'`) when the markup cannot be established — never the incurred
 * figure under a billed label. Any `provider` group key is dropped as defence in
 * depth (the dimension itself is already refused for non-super-admins).
 */
async function billedCostByCorrelation(
  upstream: UpstreamCostByCorrelationResponse,
  tenantId: string,
): Promise<CostByCorrelationResponse> {
  const markupPct = await fetchTenantMarkupPct(tenantId);
  const billed = (incurred: string): string | null =>
    markupPct === null ? null : applyMarkup(incurred, markupPct);
  return {
    total_cost_usd: billed(upstream.total_cost_usd ?? '0'),
    total_input_tokens: upstream.total_input_tokens,
    total_output_tokens: upstream.total_output_tokens,
    event_count: upstream.event_count,
    groups: upstream.groups.map((g) => {
      const { provider: _provider, ...key } = g.key;
      return { ...g, key, cost_usd: billed(g.cost_usd ?? '0') };
    }),
    cost_basis: markupPct === null ? 'unavailable' : 'billed',
  };
}

// ----- Super-admin per-tenant breakdown -------------------------------------

export interface PerTenantUsageEntry {
  tenant_id: string;
  tenant_name: string | null;
  today: { requests: number; cost_usd: string };
  month: { requests: number; cost_usd: string };
}

export interface PerTenantUsageResponse {
  items: PerTenantUsageEntry[];
}

/**
 * GET /api/me/usage/by-tenant
 *
 * Super-admin only. Walks every workspace the user can act in — the SAME
 * enumeration the header workspace switcher uses, `lib/accessible-tenants.ts`
 * — and returns today + month {requests, cost_usd} for each.
 *
 * ⚠️ This route used to keep its own copy of that enumeration, justified by a
 * comment saying `/api/me/workspaces` "is owned by a parallel worktree". The
 * copy then drifted from the original on two of its three sources, and the
 * result was visible on one page in one session: this table listed FOUR
 * workspaces under the caption "every workspace you can act in" while the
 * switcher above it offered SIX. Missing were the execution tenant and the
 * caller's OWN JWT tenant — and the latter was the ACTIVE workspace, so the
 * page's headline total (scoped by `tryActiveTenantId()`) was computed for a
 * tenant this table did not contain. Do not re-fork this list.
 *
 * Surfaces an empty `items: []` for super-admins who happen to have no
 * accessible tenants (defensive — should never happen in practice because the
 * switchable set is always surfaced for super-admins).
 *
 * Non-super-admins get 403. The page itself hides the table for
 * non-super-admin users, but the server still gates so an enumeration
 * probe gets a clean refusal.
 */
export async function handleGetMyUsageByTenant(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  if (!isSuperAdmin(user)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  const tenants = await listAccessibleTenants(user);
  const today = todayWindow();
  const month = monthWindow();

  // Parallel fan-out across tenants. Each tenant runs 4 upstream calls
  // (today usage, today costs, month usage, month costs). The metering
  // service serves these from the cost_daily + metering_event_daily
  // rollups so this is cheap relative to typical UI fetches.
  const items = await Promise.all(
    tenants.map(async (t): Promise<PerTenantUsageEntry> => {
      const [usageToday, costsToday, usageMonth, costsMonth] = await Promise.all([
        getTenantUsageRange({ tenantId: t.id, ...today, granularity: 'daily' }),
        getTenantCostsRange({ tenantId: t.id, ...today }),
        getTenantUsageRange({ tenantId: t.id, ...month, granularity: 'daily' }),
        getTenantCostsRange({ tenantId: t.id, ...month }),
      ]);
      return {
        tenant_id: t.id,
        // `workspaces.name` is NOT NULL; the caller's own tenant falls back to
        // its id inside the helper. Never null in practice — the field stays
        // nullable for the wire contract's sake.
        tenant_name: t.name,
        today: {
          requests: usageToday.total_requests ?? 0,
          cost_usd: costsToday.total_cost_usd ?? '0',
        },
        month: {
          requests: usageMonth.total_requests ?? 0,
          cost_usd: costsMonth.total_cost_usd ?? '0',
        },
      };
    }),
  );

  const body: PerTenantUsageResponse = { items };
  return jsonResponse(body);
}
