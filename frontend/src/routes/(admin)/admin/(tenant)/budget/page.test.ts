import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  budgetRemaining,
  consumedFraction,
  isLowBudget,
  packageOptions,
} from './page-helpers';
import type { BudgetEntry, BudgetStatusResponse } from '$lib/api/usage';

const entry = (over: Partial<BudgetEntry> = {}): BudgetEntry => ({
  budget_id: 'b1',
  source: 'manual',
  budget_tokens: 1_000_000,
  consumed_tokens: 0,
  period: 'monthly',
  expires_at: null,
  ...over,
});

const status = (over: Partial<BudgetStatusResponse> = {}): BudgetStatusResponse => ({
  tenant_id: 't-1',
  total_remaining: 1_000_000,
  budget_count: 1,
  next_expiry: null,
  budgets: [entry()],
  ...over,
});

describe('formatTokens', () => {
  it('compacts millions and thousands, dropping trailing .0', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(12_000)).toBe('12K');
    expect(formatTokens(500)).toBe('500');
  });
});

describe('budgetRemaining', () => {
  it('prefers an explicit remaining_tokens', () => {
    expect(budgetRemaining(entry({ remaining_tokens: 250_000 }))).toBe(250_000);
  });

  it('derives total - consumed when remaining is absent', () => {
    expect(budgetRemaining(entry({ budget_tokens: 1_000_000, consumed_tokens: 400_000 }))).toBe(
      600_000,
    );
  });

  it('never goes negative (oversold)', () => {
    expect(budgetRemaining(entry({ budget_tokens: 100, consumed_tokens: 500 }))).toBe(0);
  });
});

describe('consumedFraction', () => {
  it('is 0 for an unmetered/zero budget (no divide-by-zero)', () => {
    expect(consumedFraction(entry({ budget_tokens: 0 }))).toBe(0);
  });

  it('clamps to 1 when oversold', () => {
    expect(consumedFraction(entry({ budget_tokens: 100, consumed_tokens: 999 }))).toBe(1);
  });

  it('computes the fraction', () => {
    expect(consumedFraction(entry({ budget_tokens: 1000, consumed_tokens: 250 }))).toBe(0.25);
  });
});

describe('isLowBudget', () => {
  it('flags low at/after 80% consumed', () => {
    expect(isLowBudget(status({ total_remaining: 150_000 }))).toBe(true); // 15% left
  });

  it('is not low with plenty remaining', () => {
    expect(isLowBudget(status({ total_remaining: 900_000 }))).toBe(false);
  });

  it('is not low when there is no budget at all (avoid a false alarm)', () => {
    expect(isLowBudget(status({ budgets: [], total_remaining: 0 }))).toBe(false);
  });
});

describe('packageOptions', () => {
  it('labels free packages "free" and shows a price when non-zero', () => {
    const opts = packageOptions([
      { id: 'a', label: '1M', tokens: 1_000_000, priceUsd: 0 },
      { id: 'b', label: '5M', tokens: 5_000_000, priceUsd: 49 },
    ]);
    expect(opts[0]!.sublabel).toBe('free');
    expect(opts[1]!.sublabel).toBe('$49');
  });
});

// ---------------------------------------------------------------------------
// Top-up history. THE DEFECT: `listMyTopUps().catch(() => [])` plus a section
// gated on `history.length > 0` made a failed read DELETE the section — the
// same screen a workspace that has never been topped up gets. A money-movement
// audit trail silently read as empty.
// ---------------------------------------------------------------------------

import { historyPanelState } from './page-helpers';

describe('historyPanelState', () => {
  it('a failed read is UNREADABLE, not "never topped up"', () => {
    expect(historyPanelState(0, 'HTTP 500')).toBe('unreadable');
  });

  it('an error outranks whatever rows are in hand', () => {
    expect(historyPanelState(3, 'HTTP 500')).toBe('unreadable');
  });

  it('only a successful empty read may hide the section', () => {
    expect(historyPanelState(0, null)).toBe('empty');
  });

  it('renders rows when there are rows', () => {
    expect(historyPanelState(2, null)).toBe('rows');
  });
});
