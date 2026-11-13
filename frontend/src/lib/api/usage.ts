// src/lib/api/usage.ts
//
// Foundation Plan 4 Lane A — typed client for the fr backend's
// `/api/me/usage/*` endpoints. Mirrors interfaces from
// fr/backend/src/routes/me/usage.ts. Keep these in sync — there is no
// shared types package today.
//
// Auth: every call goes through `authFetch`, which attaches the
// browser's Keycloak access token as a Bearer header.
//
// These helpers MUST run client-side (after the auth store has been
// hydrated) — never from a SvelteKit SSR `load()`. SSR has no auth
// store, so the request would be tokenless and 401.

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';
import { logRawError } from '$lib/workers/wm-errors';

/** Neutral copy for a failed budget read — never the status or an upstream body. */
export const BUDGET_READ_ERROR_TEXT = 'Could not read your budget right now.';

// ----- Response shapes (mirror backend) ------------------------------------

export type UsageWindow = 'today' | 'month';

export interface UsageSummaryResponse {
  window: UsageWindow;
  requests: number;
  tokens: number;
  /** Raw provider/incurred cost (no markup) — sent to super-admins only. */
  internal_cost_usd?: string;
  /**
   * Billed cost — internal × (1 + tenant.markup_pct/100). What users see.
   * `null` when the markup cannot be established (`cost_basis: 'unavailable'`):
   * render "—", never a dollar figure.
   */
  billed_cost_usd: string | null;
  cost_basis: CustomerCostBasis;
  /**
   * The workspace's spend not yet in the nightly rollup (billing
   * /api/costs/provisional), independent of `window`. `null` when unreadable —
   * never zeros; `today_provisional_unavailable_reason` says why. Optional: an
   * older backend omits both.
   */
  today_provisional?: TodayProvisional | null;
  today_provisional_unavailable_reason?: string | null;
}

/** Today's provisional spend, through the same cost lens as the other figures. */
export interface TodayProvisional {
  currency: string;
  /** Incurred (super-admin) or billed; null when the markup is unknown — never $0. */
  cost_usd: string | null;
  cost_basis: 'incurred' | CustomerCostBasis;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  settled_through: string | null;
  since: string | null;
  as_of: string;
}

/** `'unavailable'`: the tenant's markup is unknown, so the billed amount is withheld. */
export type CustomerCostBasis = 'billed' | 'unavailable';

export type UsageGranularity = 'hourly' | 'daily';

export interface UsageSeriesBucket {
  ts: string;
  requests: number;
  tokens: number;
  /** Incurred cost — sent to super-admins only. */
  cost_usd?: string;
  /** null when withheld (markup unknown) — render "—". */
  billed_cost_usd: string | null;
  // Estimated public provider cost for BYO usage; absent/null when none applies.
  provider_estimate_usd?: string | null;
}

export interface UsageSeriesResponse {
  window: '30d';
  granularity: UsageGranularity;
  buckets: UsageSeriesBucket[];
  /**
   * Forwarded from the metering_service — true when the granularity
   * has no cost rollup (hourly today) or the cost_daily table is
   * empty for the window. Page renders `—` for cost cells in that
   * case instead of a misleading $0.00.
   */
  cost_unavailable: boolean;
  markup_pct: number | null;
  cost_basis: CustomerCostBasis;
}

export interface UsageBreakdownService {
  service: string;
  requests: number;
  tokens: number;
  /** Incurred cost — sent to super-admins only. */
  cost_usd?: string;
  /** null when withheld (markup unknown) — render "—". */
  billed_cost_usd: string | null;
  // Estimated public provider cost for BYO usage on this service.
  provider_estimate_usd?: string | null;
}

export interface UsageBreakdownResponse {
  window: '30d';
  services: UsageBreakdownService[];
  cost_unavailable: boolean;
  markup_pct: number | null;
  cost_basis: CustomerCostBasis;
}

export interface QuotaConsumed {
  quota: number | null;
  consumed: number;
}

export interface UsageQuotaResponse {
  requests_per_month: QuotaConsumed;
  tokens_per_month: QuotaConsumed;
  /** `consumed` is null when withheld (markup unknown) — render "—". */
  cost_usd_per_month: {
    quota: number | null;
    consumed: string | null;
    cost_basis: 'incurred' | CustomerCostBasis;
  };
}

// ----- Wrappers -------------------------------------------------------------
//
// Every non-2xx below is rendered verbatim at the user: the four `/usage/*`
// readers land in `loadError` (settings/usage/+page.svelte:186), the budget
// reader in `budgetError` (:346), the plan reader in `planError` (:235).
//
// They all used to throw `<fn>: <status>` and nothing else. A metering 502
// carrying `{error:{upstream:{body:{detail: "…"}}}}` therefore showed
// `fetchUsageSummary: 502` — a message that names fr, which is the one place
// the fault was not, and gives the reader nothing to act on. `/api/me/plan` is
// worse still: the panel says in words that a plan "could not be read" and is
// NOT a statement that you are on a free plan, then prints a bare status under
// it, so a billing outage and a genuinely absent plan look identical.
//
// `errorDetailOf` — already the reader used at `fetchAdminSystemUsage` below —
// takes the UNDRAINED `Response`, which is the right half of the pair here:
// `authFetch` returns the response without touching its body, and none of these
// six read it before the `!r.ok` branch. (`errorDetailFrom` is for an
// already-parsed body; passing it a `Response` returns '' silently and the user
// gets the bare label back.)
//
// The label stays as the fallback when the body carries nothing legible — it is
// what makes the message attributable to a specific call.

export async function fetchUsageSummary(
  window: UsageWindow,
): Promise<UsageSummaryResponse> {
  const r = await authFetch(`/api/me/usage/summary?window=${window}`);
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`fetchUsageSummary: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as UsageSummaryResponse;
}

export async function fetchUsageSeries(
  granularity: UsageGranularity = 'daily',
): Promise<UsageSeriesResponse> {
  const r = await authFetch(
    `/api/me/usage/series?window=30d&granularity=${granularity}`,
  );
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`fetchUsageSeries: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as UsageSeriesResponse;
}

export async function fetchUsageBreakdown(): Promise<UsageBreakdownResponse> {
  const r = await authFetch(`/api/me/usage/breakdown?window=30d`);
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`fetchUsageBreakdown: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as UsageBreakdownResponse;
}

export async function fetchUsageQuota(): Promise<UsageQuotaResponse> {
  const r = await authFetch(`/api/me/usage/quota`);
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`fetchUsageQuota: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as UsageQuotaResponse;
}

// ----- Budget status (per active tenant) -----------------------------------

export interface BudgetEntry {
  budget_id?: string;
  tenant_id?: string;
  /**
   * The licence this row belongs to, or null for a row no licence backs
   * (manual / top-up). A tenant's figure is a SUM over these rows, which is
   * why the console breaks them out instead of showing one number as one budget.
   */
  license_id?: string | null;
  source?: string;
  budget_tokens?: number;
  /** Billing's own consumed count for this row, when it sends one. */
  used_tokens?: number;
  consumed_tokens?: number;
  remaining_tokens?: number;
  usage_pct?: number;
  over_budget?: boolean;
  priority?: number;
  period?: string;
  starts_at?: string | null;
  expires_at?: string | null;
}

export interface BudgetStatusResponse {
  tenant_id: string;
  total_remaining: number;
  budget_count: number;
  next_expiry: string | null;
  budgets: BudgetEntry[];
}

export async function fetchBudgetStatus(): Promise<BudgetStatusResponse> {
  const r = await authFetch('/api/me/budget/status');
  if (!r.ok) {
    // NEUTRAL COPY (fr#1409). This used to throw `${status} — ${detail}`, and
    // every consumer renders the thrown message: the tenant budget page's
    // `loadError`, the settings panel and SpendCard. An upstream detail is not
    // the customer's to read, so the status and body go to the console and the
    // user gets a sentence.
    logRawError('budget status', r.status, await errorDetailOf(r));
    throw new Error(BUDGET_READ_ERROR_TEXT);
  }
  return (await r.json()) as BudgetStatusResponse;
}

// ----- Plan / access charges (the ACCESS-billing axis) ---------------------

export interface PlanAccessCharge {
  service_key: string | null;
  amount_usd: string;
  cadence: string;
  included_cost_usd: string | null;
  /** Month-to-date usage against THIS product's allowance and what's left; null when unavailable. */
  used_usd: string | null;
  remaining_usd: string | null;
}

export interface MyPlanResponse {
  access_charges: PlanAccessCharge[];
  monthly_total_usd: string;
  /** Sum of monthly included-usage credits — "$X/mo usage included". */
  monthly_included_usd: string;
  /**
   * Month-to-date usage consumed against the included allowance, and what's left.
   * Billed (marked-up) for a customer; `null` when withheld (markup unknown).
   */
  included_used_usd: string | null;
  included_remaining_usd: string | null;
  /** `incurred` (super-admin), `billed`, or `unavailable` (figures withheld). */
  cost_basis?: 'incurred' | 'billed' | 'unavailable';
}

/** The active tenant's fixed access charges (paid-license fees). */
export async function fetchMyPlan(): Promise<MyPlanResponse> {
  const r = await authFetch('/api/me/plan');
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`fetchMyPlan: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as MyPlanResponse;
}

// ----- System-wide super-admin aggregate -----------------------------------

export interface SystemTenantUsage {
  tenant_id: string;
  tenant_name: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  incurred_cost_usd: string;
  markup_pct: number;
  billed_cost_usd: string;
}

export interface SystemProviderUsage {
  provider: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  incurred_cost_usd: string;
}

export interface SystemUsageGrandTotal {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  incurred_cost_usd: string;
  billed_cost_usd: string;
}

export type AdminUsageWindow = 'today' | 'month' | string;

export interface AdminSystemUsageResponse {
  window: string;
  start: string;
  end: string;
  generated_at: string;
  grand_total: SystemUsageGrandTotal;
  by_tenant: SystemTenantUsage[];
  by_provider: SystemProviderUsage[];
}

export async function fetchAdminSystemUsage(
  window: AdminUsageWindow = 'month',
): Promise<AdminSystemUsageResponse> {
  const r = await authFetch(`/api/admin/usage/system?window=${encodeURIComponent(window)}`);
  if (!r.ok) {
    // Say WHICH service refused and why. This page rendered a bare
    // "fetchAdminSystemUsage: 500" while the actual cause was billing-service
    // answering 401 — a message that points the reader at fr, which is the one
    // place the fault was not. The backend now returns the structured
    // `{error:{code,message,service,upstream}}` shape here, and `errorDetailOf`
    // already knows how to read it (same helper the provisioning console uses).
    const detail = await errorDetailOf(r);
    throw new Error(`fetchAdminSystemUsage: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as AdminSystemUsageResponse;
}
