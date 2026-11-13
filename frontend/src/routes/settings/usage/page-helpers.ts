// src/routes/settings/usage/page-helpers.ts
//
// Pure helpers for the /settings/usage page. Factored out of +page.svelte
// so vitest can verify them without DOM (the repo uses
// `environment: 'node'` for unit tests and `@testing-library/svelte` is
// not installed). Same pattern as
// `routes/settings/licenses/page-helpers.ts`.

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatCostUsd(cost: string | null | undefined): string {
  // null/undefined = WITHHELD or not reported (e.g. the tenant's markup is
  // unknown, so the backend sent no billed figure). Never "$0.00".
  if (cost === null || cost === undefined) return '—';
  const n = Number.parseFloat(cost);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

export function quotaPercent(consumed: number, quota: number | null): number | null {
  if (quota === null || quota === undefined || quota <= 0) return null;
  const pct = (consumed / quota) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * UI label for a quota row when the upstream returns `quota: null`.
 * The user shouldn't see "0 / 0" — they should see something honest.
 */
export function quotaLabel(consumed: number | string, quota: number | null): string {
  if (quota === null || quota === undefined) return 'Unmetered';
  return `${typeof consumed === 'string' ? consumed : formatNumber(consumed)} / ${formatNumber(quota)}`;
}

/**
 * Cost cell for the per-service breakdown table. When the upstream
 * reports cost_unavailable=true (no cost rollup for the granularity)
 * we render `—` instead of a misleading $0.00.
 */
export function breakdownCostCell(cost: string | null, costUnavailable: boolean): string {
  return costUnavailable ? '—' : formatCostUsd(cost);
}

// ---------------------------------------------------------------------------
// Self-contradiction guards.
//
// This page renders numbers drawn from FOUR different upstream rollups and used
// to lay them out as if they were one ledger:
//
//   * headline cards      → GET /api/costs/tenant/{id}?start=<1st of month>
//                           and  GET /api/usage/tenant/{id}   (CALENDAR MONTH)
//   * "By service" table  → GET /api/usage/tenant/{id}/breakdown?window=30d
//                           (LAST 30 DAYS, a different table and a wider window)
//   * budget panel        → GET /api/budget/status/me
//   * quota panel         → GET /api/me/usage/quota
//
// Two failure shapes follow, and both were live on 2026-09-10:
//
//   1. A `0` printed where the upstream never attributed the metric at all.
//      `inference-router` rendered `0` requests beside 30,583,866 tokens;
//      `unmapped:api` rendered `0` tokens beside 2,683 requests. Tokens cannot
//      be produced by zero requests — so at least one of those cells is not a
//      measurement, and the reader has no way to tell which. A zero that cannot
//      be distinguished from missing data is the defect (same idiom as
//      `breakdownCostCell` and `planTileState` above).
//
//   2. Two numbers laid side by side that come from different windows/rollups
//      and therefore cannot be reconciled by the reader — 22,137,386 tokens in
//      the headline sitting directly above a single 30,583,866-token row, and
//      `$258.61` incurred cost sitting above a column of `—`.
//
// The rule these helpers encode: never invent a number, and never let an
// incomparable pair render as if it were comparable. Label it or dash it.
// ---------------------------------------------------------------------------

/** The two metrics the per-service table renders numerically. */
export type BreakdownMetric = 'requests' | 'tokens';

/** Only the fields the attribution decision reads. */
export interface BreakdownMetrics {
  requests: number;
  tokens: number;
}

export type BreakdownCell =
  | { kind: 'value'; text: string }
  | { kind: 'unattributed'; text: string; title: string };

/**
 * One numeric cell of the per-service breakdown.
 *
 * A row that reports zero of one metric while reporting a positive amount of
 * the other is NOT a row that did zero of that thing — it is a row metering
 * failed to attribute along that axis. Render the honest dash, not a zero that
 * contradicts its own neighbour.
 *
 * A row that is zero on BOTH metrics (`hirag`, `karma`) is genuinely idle:
 * that zero is a measurement and stays a zero.
 */
export function breakdownMetricCell(
  metric: BreakdownMetric,
  row: BreakdownMetrics,
): BreakdownCell {
  const value = metric === 'requests' ? row.requests : row.tokens;
  if (value > 0) return { kind: 'value', text: formatNumber(value) };

  const otherMetric: BreakdownMetric = metric === 'requests' ? 'tokens' : 'requests';
  const other = metric === 'requests' ? row.tokens : row.requests;
  if (other > 0) {
    return {
      kind: 'unattributed',
      text: '—',
      title:
        `Not reported. This service records ${formatNumber(other)} ${otherMetric}, ` +
        `so its ${metric} were not attributed to it upstream — this is missing ` +
        `attribution, not a measured zero.`,
    };
  }
  return { kind: 'value', text: formatNumber(value) };
}

/**
 * The caption that stops the headline cards and the per-service table being
 * read as one total.
 *
 * The cards are calendar-month-to-date off the cost rollup; the table is the
 * last 30 days off the usage rollup. They are both right and they will not
 * agree. Returns null when they happen to agree, so the page stays quiet when
 * there is nothing to explain.
 */
export function breakdownTotalsNote(args: {
  monthRequests: number;
  monthTokens: number;
  rows: readonly BreakdownMetrics[];
}): string | null {
  const tableRequests = args.rows.reduce((a, r) => a + r.requests, 0);
  const tableTokens = args.rows.reduce((a, r) => a + r.tokens, 0);
  if (tableRequests === args.monthRequests && tableTokens === args.monthTokens) {
    return null;
  }
  return (
    `Different window and different rollup from the cards above: those cover the ` +
    `calendar month to date (${formatNumber(args.monthRequests)} requests, ` +
    `${formatNumber(args.monthTokens)} tokens); this table covers the last 30 days ` +
    `(${formatNumber(tableRequests)} requests, ${formatNumber(tableTokens)} tokens). ` +
    `The two totals are not expected to match and must not be added or compared.`
  );
}

/**
 * The caption for a cost column that is entirely `—` while the headline card
 * states a confident dollar figure.
 *
 * The dash is already correct (`breakdownCostCell`) — the defect is that it is
 * unexplained next to `$258.61`, which reads as the page disagreeing with
 * itself. Say which number came from where.
 */
export function breakdownCostNote(
  costUnavailable: boolean,
  headlineCostUsd: string | null,
  headlineLabel = 'incurred',
): string | null {
  if (!costUnavailable) return null;
  return (
    `Cost is not broken out per service for this window, so every cell below reads ` +
    `“—” (not reported) rather than $0.00. The ${formatCostUsd(headlineCostUsd)} ` +
    `${headlineLabel} figure in the cards above is the tenant-wide month-to-date ` +
    `total from the cost rollup; it is not the sum of this column.`
  );
}

// ---------------------------------------------------------------------------
// Budget panel.
// ---------------------------------------------------------------------------

/** Only the fields the budget row decision reads (mirrors `BudgetEntry`). */
export interface BudgetRowMetrics {
  budget_tokens?: number | null;
  consumed_tokens?: number | null;
}

export type BudgetConsumption =
  | { kind: 'measured'; consumedText: string; allocationText: string; pct: number | null }
  | { kind: 'unreported'; consumedText: string; allocationText: string; pct: null; title: string };

/**
 * A budget row's consumption figure.
 *
 * `consumed_tokens` is OPTIONAL on the upstream `BudgetEntry`
 * (backend/src/integrations/metering/usage.ts:384). The page used to collapse
 * that with `?? 0`, so six `license_sync` budgets rendered `0 / 10,000,000
 * tokens · 0%` — i.e. "you have spent nothing, all headroom intact" — on a page
 * simultaneously reporting 22.1M tokens spent. An absent consumption figure is
 * not zero consumption, and a 0% bar is a claim about remaining headroom that a
 * missing field has not earned.
 *
 * A genuine numeric `0` from upstream still renders as `0`.
 */
export function budgetConsumption(b: BudgetRowMetrics): BudgetConsumption {
  const allocation = b.budget_tokens;
  const allocationText =
    allocation === null || allocation === undefined ? '—' : formatNumber(allocation);
  const consumed = b.consumed_tokens;
  if (consumed === null || consumed === undefined) {
    return {
      kind: 'unreported',
      consumedText: '—',
      allocationText,
      pct: null,
      title:
        'Consumption against this budget was not reported by the metering service. ' +
        'This is not a statement that nothing has been consumed.',
    };
  }
  return {
    kind: 'measured',
    consumedText: formatNumber(consumed),
    allocationText,
    pct: quotaPercent(consumed, allocation ?? null),
  };
}

/**
 * Panel-level contradiction check.
 *
 * Even when every row carries a literal `0` from upstream — which the row-level
 * helper above must faithfully render as `0` — "no budget consumed anything"
 * cannot be true on a page that also reports tokens spent this month. Say so
 * instead of leaving the reader to spot it.
 */
export function budgetReconciliationNote(args: {
  budgets: readonly BudgetRowMetrics[];
  monthTokens: number;
}): string | null {
  if (args.budgets.length === 0) return null;
  if (args.monthTokens <= 0) return null;
  const anyConsumption = args.budgets.some(
    (b) => b.consumed_tokens !== null && b.consumed_tokens !== undefined && b.consumed_tokens > 0,
  );
  if (anyConsumption) return null;
  return (
    `This workspace recorded ${formatNumber(args.monthTokens)} tokens this month, yet ` +
    `no budget below reports any consumption. Budget consumption is not reconciled ` +
    `with metered usage — treat the allocations below as unverified, not as ` +
    `available headroom.`
  );
}

// ---------------------------------------------------------------------------
// "Your plan" tile — the access-billing axis.
// ---------------------------------------------------------------------------

/** The only two fields the tile's visibility decision reads. */
export interface PlanTotals {
  monthly_total_usd: string;
  monthly_included_usd: string;
}

/**
 * What the plan tile may claim.
 *
 * `plan` used to be set to `null` on a failed `GET /api/me/plan`, and the tile
 * is gated on `hasPlan`, so a billing outage HID the tile entirely — which on
 * this page is exactly how a tenant with no recurring access fee renders. The
 * user was therefore told, silently and confidently, that they are on the free
 * tier while paying for a plan. "Cannot determine the plan" must never paint
 * the same pixels as "there is no plan": that is a claim about money, and a
 * failed read has not earned it.
 *
 * - `unreadable` — the read failed (or resolved to nothing). Say so.
 * - `loading`    — not back yet. Not a claim.
 * - `none`       — read succeeded and every fee is zero. Genuinely no plan.
 * - `plan`       — read succeeded and there is a fee to show.
 */
export type PlanTileState = 'loading' | 'unreadable' | 'none' | 'plan';

export function planTileState(args: {
  plan: PlanTotals | null;
  error: string | null;
  loaded: boolean;
}): PlanTileState {
  if (args.error !== null) return 'unreadable';
  if (!args.loaded) return 'loading';
  // Loaded, no error, yet nothing to read: we still cannot assert "no plan".
  if (args.plan === null) return 'unreadable';
  const total = Number.parseFloat(args.plan.monthly_total_usd);
  const included = Number.parseFloat(args.plan.monthly_included_usd);
  // A non-numeric amount is an unusable answer, not a zero one. Rendering it
  // as "no plan" is the same free-tier lie by another route.
  if (!Number.isFinite(total) || !Number.isFinite(included)) return 'unreadable';
  return total > 0 || included > 0 ? 'plan' : 'none';
}

/**
 * Percent of the monthly included allowance consumed, for the plan tile's bar.
 * `null` when the consumption is WITHHELD (the backend sends `null` with
 * `cost_basis: 'unavailable'` when the tenant's markup is unknown) or not a
 * number — the tile then shows "—" and no bar, never a `NaN%` width.
 */
export function includedUsagePercent(
  used: string | null | undefined,
  included: string | null | undefined,
): number | null {
  if (used === null || used === undefined) return null;
  const u = Number.parseFloat(used);
  const inc = Number.parseFloat(included ?? '');
  if (!Number.isFinite(u) || !Number.isFinite(inc)) return null;
  if (inc <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((u / inc) * 100)));
}
