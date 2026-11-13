// lib/usage-funding.ts
//
// Pure helpers for the funding-split usage surfaces (billing-service #263
// `/api/usage/breakdown` and `/breakdown/me`):
//
//   routes/tenant/usage-breakdown.ts   GET /api/tenant/usage/breakdown
//   routes/me/usage-funding.ts         GET /api/me/usage/funding
//   services/cockpit/project-cockpit   ProjectCost.funding
//
// ── WHO PAYS: the `funding` dimension ─────────────────────────────────────────
//
//   local_gpu          fr's own GPUs        — fr's cost, marked up
//   platform_external  fr-paid provider key — fr's cost, marked up
//   tenant_byo         the tenant's own key — the CUSTOMER's provider bill,
//                                             never marked up (same rule as
//                                             /api/tenant/billing byo_cost_usd)
//   unknown            billing could not classify — treated as fr's cost
//
// ── COST LENS (owner ruling, as everywhere else fr shows money) ───────────────
//
// A super-admin sees incurred cost. Everyone else sees BILLED cost (incurred ×
// the tenant's markup). When the markup is unknown the fr-paid figures are
// WITHHELD (null) — never the incurred figure under a billed label. BYO stays
// visible: it is the customer's own number, not fr's.
//
// Because markup depends on funding, every upstream read asks billing for
// `funding` as an extra dimension and this module folds it back out when the
// caller did not group by it. Money is summed in integer micro-dollars.

import { applyMarkup } from './money';

export const FUNDING_VALUES = ['local_gpu', 'platform_external', 'tenant_byo', 'unknown'] as const;
export type Funding = (typeof FUNDING_VALUES)[number];

export const BREAKDOWN_DIMS = ['project', 'actor', 'funding', 'app', 'provider', 'model', 'day'] as const;
export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number];

export type CostLens =
  | { basis: 'incurred' }
  | { basis: 'billed'; markupPct: number }
  | { basis: 'unavailable' };

export interface CrossRowIn {
  dims: Record<string, string | null>;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
}

export interface PricedRow {
  dims: Record<string, string | null>;
  events: number;
  input_tokens: number;
  output_tokens: number;
  /** null when withheld (markup unknown, fr-paid funding). */
  cost_usd: number | null;
}

export interface FundingTotal {
  funding: string;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

const toMicros = (n: number): number => Math.round(n * 1e6);

function decimal(s: string | number | null | undefined): string {
  const n = Number.parseFloat(String(s ?? '0'));
  return Number.isFinite(n) ? n.toFixed(6) : '0.000000';
}

/** One row's cost through the lens. BYO is never marked up and never withheld. */
export function priceCost(costUsd: string, funding: string | null | undefined, lens: CostLens): number | null {
  const d = decimal(costUsd);
  if (funding === 'tenant_byo' || lens.basis === 'incurred') return Number(d);
  if (lens.basis === 'unavailable') return null;
  return Number(applyMarkup(d, lens.markupPct));
}

/** Parse + validate a `group_by` CSV. Returns the error text on a bad dimension. */
export function parseGroupBy(
  raw: string | null,
  fallback: readonly BreakdownDim[],
  allowed: readonly BreakdownDim[] = BREAKDOWN_DIMS,
): BreakdownDim[] | { error: string } {
  const parts = (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [...fallback];
  const bad = parts.filter((p) => !(allowed as readonly string[]).includes(p));
  if (bad.length) return { error: `unknown group_by dimension(s): ${bad.join(', ')}` };
  return [...new Set(parts)] as BreakdownDim[];
}

/** The dims to ASK billing for: always including funding (markup needs it). */
export function upstreamGroupBy(dims: readonly BreakdownDim[]): BreakdownDim[] {
  return dims.includes('funding') ? [...dims] : [...dims, 'funding'];
}

/**
 * Price every upstream row (which carries `funding`) and fold to `dims`.
 * A group with any withheld part has a withheld (null) cost — never a partial sum.
 * Sorted by cost desc (withheld last), then events desc.
 */
export function foldRows(rows: readonly CrossRowIn[], dims: readonly string[], lens: CostLens): PricedRow[] {
  const acc = new Map<string, { row: PricedRow; micros: number; withheld: boolean }>();
  for (const r of rows) {
    const keyDims: Record<string, string | null> = {};
    for (const d of dims) keyDims[d] = r.dims[d] ?? null;
    const key = JSON.stringify(dims.map((d) => keyDims[d]));
    let a = acc.get(key);
    if (!a) {
      a = {
        row: { dims: keyDims, events: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        micros: 0,
        withheld: false,
      };
      acc.set(key, a);
    }
    a.row.events += r.events ?? 0;
    a.row.input_tokens += r.input_tokens ?? 0;
    a.row.output_tokens += r.output_tokens ?? 0;
    const c = priceCost(r.cost_usd, r.dims.funding, lens);
    if (c === null) a.withheld = true;
    else a.micros += toMicros(c);
  }
  const out = [...acc.values()].map(({ row, micros, withheld }) => ({
    ...row,
    cost_usd: withheld ? null : micros / 1e6,
  }));
  return out.sort(
    (a, b) =>
      (b.cost_usd ?? -1) - (a.cost_usd ?? -1) || b.events - a.events,
  );
}

/** Per-funding totals (from a `group_by=funding` read) plus the grand total. */
export function fundingTotals(
  rows: readonly CrossRowIn[],
  lens: CostLens,
): {
  by_funding: FundingTotal[];
  totals: { events: number; input_tokens: number; output_tokens: number; cost_usd: number | null };
} {
  const folded = foldRows(rows, ['funding'], lens);
  const by_funding: FundingTotal[] = folded.map((r) => ({
    funding: r.dims.funding ?? 'unknown',
    events: r.events,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd,
  }));
  let micros = 0;
  let withheld = false;
  const totals = { events: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 as number | null };
  for (const f of by_funding) {
    totals.events += f.events;
    totals.input_tokens += f.input_tokens;
    totals.output_tokens += f.output_tokens;
    if (f.cost_usd === null) withheld = true;
    else micros += toMicros(f.cost_usd);
  }
  totals.cost_usd = withheld ? null : micros / 1e6;
  return { by_funding, totals };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** billing's MAX_WINDOW_DAYS: (to - from) may not exceed this many days. */
export const MAX_WINDOW_DAYS = 92;
export const DEFAULT_WINDOW_DAYS = 30;

function isRealDay(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** from/to (inclusive UTC days). Default: the last 30 days ending today. */
export function resolveWindow(
  params: URLSearchParams,
): { from: string; to: string } | { error: string } {
  const to = params.get('to') ?? new Date().toISOString().slice(0, 10);
  const from =
    params.get('from') ??
    new Date(Date.parse(`${to}T00:00:00Z`) - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (!isRealDay(from) || !isRealDay(to)) return { error: 'from/to must be YYYY-MM-DD' };
  if (from > to) return { error: 'from must be on or before to' };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) return { error: `date range too wide (max ${MAX_WINDOW_DAYS} days)` };
  return { from, to };
}

/** Pass-through filters, CSV. Only the keys in `allowed` are forwarded. */
export function pickFilters(
  params: URLSearchParams,
  allowed: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowed) {
    const v = params.get(k);
    if (v !== null && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}
