// src/routes/(admin)/admin/(tenant)/budget/page-helpers.ts
//
// Pure logic for the tenant-admin budget screen. Extracted so vitest verifies
// it under `environment: 'node'` without rendering the component.

import type { BudgetEntry, BudgetStatusResponse } from '$lib/api/usage';
import type { TopUpPackage } from '$lib/api/budget';
import type { ComboOption } from '$lib/components/ui';

/** Compact a token count: 1_500_000 -> "1.5M", 12_000 -> "12K". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

/** Remaining tokens for one budget line, never negative. */
export function budgetRemaining(b: BudgetEntry): number {
  if (typeof b.remaining_tokens === 'number') return Math.max(0, b.remaining_tokens);
  const total = b.budget_tokens ?? 0;
  const used = b.consumed_tokens ?? 0;
  return Math.max(0, total - used);
}

/** Consumed fraction 0..1 for a progress bar; 0 when the budget is unmetered/0. */
export function consumedFraction(b: BudgetEntry): number {
  const total = b.budget_tokens ?? 0;
  if (total <= 0) return 0;
  const used = b.consumed_tokens ?? 0;
  return Math.min(1, Math.max(0, used / total));
}

/**
 * A tenant is "low" when it has crossed the notification threshold (80%
 * consumed across all budgets) — surfaced so the screen can nudge a top-up
 * even before the async budget-alert notification arrives.
 */
export function isLowBudget(status: BudgetStatusResponse, threshold = 0.8): boolean {
  const total = status.budgets.reduce((s, b) => s + (b.budget_tokens ?? 0), 0);
  if (total <= 0) return false;
  const remaining = status.total_remaining ?? 0;
  return remaining / total <= 1 - threshold;
}

/**
 * What the "Recent top-ups" section may claim.
 *
 * `listMyTopUps()` used to degrade to `[]`, and the section is gated on
 * `history.length > 0`, so a failed read made the whole section VANISH — the
 * same pixels as a workspace that has never been topped up. An admin who had
 * just added tokens saw no record of it, and the money-movement audit trail
 * silently read as empty. Failure and emptiness must render differently.
 */
export type HistoryPanelState = 'unreadable' | 'empty' | 'rows';

export function historyPanelState(
  rowCount: number,
  error: string | null,
): HistoryPanelState {
  if (error !== null) return 'unreadable';
  return rowCount > 0 ? 'rows' : 'empty';
}

/** Top-up packages → dropdown options. Shows the price only when it is non-zero. */
export function packageOptions(pkgs: TopUpPackage[]): ComboOption[] {
  return pkgs.map((p) => ({
    value: p.id,
    label: p.label,
    sublabel: p.priceUsd > 0 ? `$${p.priceUsd}` : 'free',
  }));
}
