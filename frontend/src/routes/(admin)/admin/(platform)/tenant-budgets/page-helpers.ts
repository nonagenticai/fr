// Pure logic for the platform (cross-tenant) budget screen.
//
// The rule this file exists to enforce: NEVER present an unconfigured budget as
// a healthy one.
//
// `consumedFraction` in the tenant-scoped helpers returns 0 when the total is 0,
// which is right for a progress bar and wrong for a fleet table: a tenant with
// no budget at all would render "0% used" beside a tenant that genuinely has
// spent nothing, and the two demand opposite actions. `budget_count` is the
// authoritative "configured" signal — not a zero total, and not a zero
// remaining, since a fully-exhausted budget also totals zero remaining.

import type { BudgetEntry, BudgetStatusResponse } from '$lib/api/usage';
import { formatTokens } from '../../(tenant)/budget/page-helpers';

export type BudgetState = 'unconfigured' | 'healthy' | 'low' | 'exhausted';

export interface TenantBudgetView {
  tenantId: string;
  /** null when nothing is configured — callers must render no bar, not a 0% bar. */
  consumedFraction: number | null;
  remainingTokens: number | null;
  totalTokens: number | null;
  state: BudgetState;
  nextExpiry: string | null;
  /**
   * The budget rows `totalTokens`/`remainingTokens` are SUMMED from.
   *
   * A tenant's figure is not one budget: it is the aggregate of one
   * `license_sync` row per licence plus any manual / top-up rows. Carrying the
   * rows on the view is what lets the screen state the row count beside the
   * sum and break it down — presenting the sum as a single budget is the
   * defect this shape exists to prevent. Empty for an unconfigured or
   * unreadable tenant, never undefined.
   */
  entries: BudgetEntry[];
}

/** Low-water mark, matching the tenant screen's notification threshold. */
export const LOW_BUDGET_THRESHOLD = 0.8;

export function buildTenantBudgetView(
  tenantId: string,
  status: BudgetStatusResponse | null,
): TenantBudgetView {
  const base = {
    tenantId,
    consumedFraction: null,
    remainingTokens: null,
    totalTokens: null,
    nextExpiry: null,
    entries: [] as BudgetEntry[],
  };

  // No response at all (a failed read) is NOT "unconfigured" — but it is also
  // not something we may invent numbers for. Both render as "unknown" upstream;
  // the caller distinguishes them by whether it holds an error for the row.
  if (!status || status.budget_count === 0) {
    return { ...base, state: 'unconfigured' };
  }

  const entries = Array.isArray(status.budgets) ? status.budgets : [];
  const total = entries.reduce((sum, b) => sum + (b.budget_tokens ?? 0), 0);
  const remaining = Math.max(0, status.total_remaining ?? 0);

  // A budget can exist with an unmetered (zero) allowance. That is configured
  // but unmeasurable — a fraction would be a divide-by-zero dressed as 0%.
  if (total <= 0) {
    return {
      ...base,
      entries,
      remainingTokens: remaining,
      state: 'healthy',
      nextExpiry: status.next_expiry,
    };
  }

  const fraction = Math.min(1, Math.max(0, (total - remaining) / total));
  let state: BudgetState = 'healthy';
  if (remaining <= 0) state = 'exhausted';
  else if (fraction >= LOW_BUDGET_THRESHOLD) state = 'low';

  return {
    tenantId,
    consumedFraction: fraction,
    remainingTokens: remaining,
    totalTokens: total,
    state,
    nextExpiry: status.next_expiry,
    entries,
  };
}

/** Human label. Never says "0% used" for something that was never configured. */
export function budgetStateLabel(view: TenantBudgetView): string {
  switch (view.state) {
    case 'unconfigured':
      return 'No budget configured';
    case 'exhausted':
      return 'Exhausted';
    case 'low':
      return 'Low';
    default:
      return view.totalTokens === null ? 'Unmetered' : 'Healthy';
  }
}

// ---------------------------------------------------------------------------
// The three money columns: Budget, Remaining, Used.
//
// THE DEFECT THIS REPLACES: the Used column held ONLY a progress bar, so
// `consumedFraction === 0` painted a 0-width, invisible div and an operator
// could not read used tokens — or the total they were used against — anywhere
// on the page. A bar is a glance, not a figure.
//
// Null discipline unchanged: a number we do not have renders `—`, NEVER 0.
// ---------------------------------------------------------------------------

/** `formatTokens`, with the page's em-dash for "we do not have this number". */
export function formatTokensOrDash(n: number | null): string {
  return n === null ? '—' : formatTokens(n);
}

/**
 * Used tokens for one tenant: `total - remaining`, the inverse of the Budget
 * and Remaining cells beside it. null when either input is unknown — a 0 here
 * would claim "spent nothing" about a tenant whose total we failed to read.
 */
export function usedTokens(view: TenantBudgetView): number | null {
  if (view.totalTokens === null || view.remainingTokens === null) return null;
  return Math.max(0, view.totalTokens - view.remainingTokens);
}

/** The percent beside Used. null is an em-dash, never "0% used". */
export function usedPercentLabel(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}% used`;
}

/**
 * The qualifier that stops a tenant's SUM being read as one budget.
 *
 * conveyor is 23 stacked budget rows (one `license_sync` row per licence plus
 * manual / top-up rows) whose totals are added together. Rendering that total
 * bare says "this tenant has one 1.45B budget", which is a different claim —
 * and one that sends an operator looking for a single row to adjust. null when
 * there is nothing to qualify: zero rows (nothing to sum) or exactly one.
 */
export function budgetSumLabel(view: TenantBudgetView): string | null {
  const n = view.entries.length;
  return n > 1 ? `sum of ${n} budget rows` : null;
}

/** A group header's row count — the number of budget rows its sum covers. */
export function budgetRowsLabel(n: number): string {
  if (n <= 0) return 'no budget rows';
  return n === 1 ? '1 budget row' : `${n} budget rows`;
}

// ---------------------------------------------------------------------------
// Per-licence breakdown
// ---------------------------------------------------------------------------

/** One budget row, shaped for the expandable breakdown. */
export interface BudgetLineView {
  /** Stable `{#each}` key and draft-input key. */
  key: string;
  budgetId: string | null;
  /** null ⇒ no licence backs this row, so it cannot be adjusted per licence. */
  licenseId: string | null;
  source: string | null;
  budgetTokens: number | null;
  usedTokens: number | null;
  remainingTokens: number | null;
  period: string | null;
  expiresAt: string | null;
  priority: number | null;
}

/**
 * Used tokens for ONE budget row: `budget_tokens - remaining_tokens`.
 *
 * Falls back to billing's own `used_tokens` / `consumed_tokens` when a row
 * carries no `remaining_tokens`. null — never 0 — for a row whose allowance is
 * unknown or unmetered: a zero allowance cannot be "0% used", there is nothing
 * to measure against.
 */
export function budgetLineUsed(entry: BudgetEntry): number | null {
  const total = typeof entry.budget_tokens === 'number' ? entry.budget_tokens : null;
  if (total === null || total <= 0) return null;
  // Remaining is clamped at 0 exactly as `budgetRemaining` and the tenant view
  // do: an overspent row reports its whole allowance as used, never more.
  if (typeof entry.remaining_tokens === 'number') {
    return Math.max(0, total - Math.max(0, entry.remaining_tokens));
  }
  if (typeof entry.used_tokens === 'number') return Math.max(0, entry.used_tokens);
  if (typeof entry.consumed_tokens === 'number') return Math.max(0, entry.consumed_tokens);
  return null;
}

export function budgetLineViews(entries: readonly BudgetEntry[]): BudgetLineView[] {
  return entries.map((entry, i) => ({
    key: entry.budget_id ?? entry.license_id ?? `row-${i}`,
    budgetId: entry.budget_id ?? null,
    licenseId: entry.license_id ?? null,
    source: entry.source ?? null,
    budgetTokens: typeof entry.budget_tokens === 'number' ? entry.budget_tokens : null,
    usedTokens: budgetLineUsed(entry),
    remainingTokens:
      typeof entry.remaining_tokens === 'number' ? Math.max(0, entry.remaining_tokens) : null,
    period: entry.period ?? null,
    expiresAt: entry.expires_at ?? null,
    priority: typeof entry.priority === 'number' ? entry.priority : null,
  }));
}

/**
 * What the adjust input means.
 *
 * An EMPTY input is `null` — clear the override and fall back to the plan's
 * allowance. It is not "no change": the Save button is the change. Anything
 * that is not a non-negative whole number is refused here, before a request is
 * sent, so a typo cannot reach a billing-shaped write.
 */
export type BudgetOverrideParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

export function parseBudgetOverride(raw: string): BudgetOverrideParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, error: 'Enter a whole number of tokens, or leave it empty to clear the override.' };
  }
  if (!Number.isInteger(n)) return { ok: false, error: 'Budget tokens must be a whole number.' };
  if (n < 0) return { ok: false, error: 'Budget tokens cannot be negative.' };
  return { ok: true, value: n };
}

/**
 * The line shown after a reset. States what actually happened: a `reset_count`
 * of 0 is an ANSWER ("nothing matched"), not a failure and not a success, and
 * `previous_consumed_total` is the consumed figure now gone.
 */
export function resetResultNotice(
  tenantName: string,
  result: { reset_count: number; previous_consumed_total: number },
): string {
  if (result.reset_count <= 0) return `No budget rows were reset for ${tenantName}.`;
  const rows = result.reset_count === 1 ? '1 budget row' : `${result.reset_count} budget rows`;
  return `Reset ${rows} for ${tenantName} — ${formatTokens(result.previous_consumed_total)} consumed tokens cleared.`;
}

/**
 * What the "Top up" cell may claim.
 *
 * The package catalogue used to degrade to `[]`, and the cell is gated on
 * `packages.length === 0` rendering an em-dash — the same cell a genuinely
 * empty catalogue produces. A failed catalogue read therefore removed the only
 * remediation this page offers, on every row, while looking like a deliberate
 * "no packages are configured". The operator's next move differs completely:
 * retry the read vs. go configure a package.
 */
export type TopUpCellState = 'unreadable' | 'none' | 'packages';

export function topUpCellState(packageCount: number, unreadable: boolean): TopUpCellState {
  if (unreadable) return 'unreadable';
  return packageCount > 0 ? 'packages' : 'none';
}

/** Rows worth an operator's attention first: exhausted, then low. */
export function sortByUrgency(views: TenantBudgetView[]): TenantBudgetView[] {
  const rank: Record<BudgetState, number> = {
    exhausted: 0,
    low: 1,
    unconfigured: 2,
    healthy: 3,
  };
  return [...views].sort(
    (a, b) => rank[a.state] - rank[b.state] || a.tenantId.localeCompare(b.tenantId),
  );
}

/**
 * Grouping, not filtering.
 *
 * The page lists every tenant flat, so five real customers sit among 33
 * machine principals and 3 test tenants and the operator cannot tell which
 * budget matters. Grouping separates them WITHOUT removing a row: every input
 * view lands in exactly one bucket, and the buckets are rendered, not culled.
 * fr#936 was the opposite mistake — a filter dropped 33 rows and the page
 * still returned 200, so nothing announced the loss.
 */
export type TenantGroup = 'workspaces' | 'services' | 'tests';

export interface GroupSummary {
  count: number;
  /**
   * The number of budget ROWS the group's figures cover — the sum behind the
   * header. A header that says "5 workspaces · 1.45B" without this cannot be
   * told apart from one describing a single budget.
   */
  budgetRowCount: number;
  /** null — not 0 — when no view in the group carried a number. */
  totalTokens: number | null;
  remainingTokens: number | null;
  consumedFraction: number | null;
  unconfigured: number;
}

/**
 * Only the two kinds we can positively identify get their own bucket.
 *
 * Everything else — 'customer', 'internal', 'unclassified', a kind added after
 * this code was written, or no kind at all — is a workspace. `kind` arrived in
 * licences migration 027; a deployment predating it omits the column entirely,
 * so `null`/`undefined` is "we don't know yet", never "hide it". Defaulting the
 * unknown into `services` or `tests` would demote a paying customer into a
 * collapsed group nobody opens, which is fr#936's disappearance wearing a
 * different hat. The default MUST put the tenant in front of the operator.
 */
export function groupOfKind(kind: string | null | undefined): TenantGroup {
  if (kind === 'service') return 'services';
  if (kind === 'test') return 'tests';
  return 'workspaces';
}

/**
 * Splits views into all three groups, always — an empty group is an empty
 * array, so a caller iterating the keys renders "no service tenants" rather
 * than silently skipping a section it thought was absent.
 *
 * A tenant id missing from `kindById` is not an error and not a reason to drop
 * the row: it resolves through `groupOfKind(undefined)` into `workspaces`.
 */
export function partitionByKind(
  views: TenantBudgetView[],
  kindById: Record<string, string | null | undefined>,
): Record<TenantGroup, TenantBudgetView[]> {
  const groups: Record<TenantGroup, TenantBudgetView[]> = {
    workspaces: [],
    services: [],
    tests: [],
  };
  for (const view of views) {
    groups[groupOfKind(kindById[view.tenantId])].push(view);
  }
  // Urgency ordering is per-group: the point of the split is that a low service
  // budget must not outrank a low customer budget across the page.
  return {
    workspaces: sortByUrgency(groups.workspaces),
    services: sortByUrgency(groups.services),
    tests: sortByUrgency(groups.tests),
  };
}

/**
 * Group header figures.
 *
 * The null discipline of `buildTenantBudgetView` has to survive aggregation. A
 * sum seeded at 0 would report "0 tokens" for a group where nothing is
 * configured, which asserts "no allowance" — a claim the data never made, and a
 * different one from "we have nothing to show". So the totals stay null unless
 * at least one view in the group actually carried a number.
 */
export function summariseGroup(views: TenantBudgetView[]): GroupSummary {
  let totalTokens: number | null = null;
  let remainingTokens: number | null = null;
  let unconfigured = 0;
  let budgetRowCount = 0;

  for (const view of views) {
    if (view.totalTokens !== null) totalTokens = (totalTokens ?? 0) + view.totalTokens;
    if (view.remainingTokens !== null)
      remainingTokens = (remainingTokens ?? 0) + view.remainingTokens;
    if (view.state === 'unconfigured') unconfigured += 1;
    budgetRowCount += view.entries.length;
  }

  // Same divide-by-zero-dressed-as-0% rule as the per-row helper. `remaining`
  // null with a non-null `total` cannot arise from buildTenantBudgetView, but
  // guessing 0 for it would render a whole group as fully consumed, so refuse.
  const consumedFraction =
    totalTokens === null || totalTokens <= 0 || remainingTokens === null
      ? null
      : (totalTokens - remainingTokens) / totalTokens;

  return {
    count: views.length,
    budgetRowCount,
    totalTokens,
    remainingTokens,
    consumedFraction,
    unconfigured,
  };
}
