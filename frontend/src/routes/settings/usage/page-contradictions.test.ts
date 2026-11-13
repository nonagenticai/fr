// src/routes/settings/usage/page-contradictions.test.ts
//
// FOUR self-contradictions measured live on /settings/usage, 2026-09-10.
// Every fixture below is the VERBATIM number from that sweep, so each test
// reproduces the exact pixels a user saw rather than a synthetic analogue.
//
//   1. `inference-router  0  30,583,866  —`
//        30.5M tokens attributed to a service credited with ZERO requests.
//   2. headline `TOKENS THIS MONTH 22,137,386` sitting directly above a single
//        30,583,866-token row.
//   3. six budget rows reading `0 / 10,000,000 tokens · 0%` on a page that
//        simultaneously reports 22,137,386 tokens spent.
//   4. every per-service cost cell `—` under a headline of `$258.61`.
//
// Same convention as page.test.ts: vitest runs `environment: 'node'` and
// `@testing-library/svelte` is not installed, so the logic lives in pure
// helpers and is verified here.

import { describe, it, expect } from 'vitest';
import {
  breakdownCostNote,
  breakdownMetricCell,
  breakdownTotalsNote,
  budgetConsumption,
  budgetReconciliationNote,
  type BreakdownMetrics,
  type BudgetRowMetrics,
} from './page-helpers';

/** The six rows of "By service, last 30 days", verbatim from the sweep. */
const LIVE_SERVICES: BreakdownMetrics[] = [
  { requests: 2683, tokens: 0 }, // unmapped:api
  { requests: 55, tokens: 0 }, // api
  { requests: 0, tokens: 0 }, // hirag
  { requests: 0, tokens: 30_583_866 }, // inference-router
  { requests: 0, tokens: 0 }, // kag-graph
  { requests: 0, tokens: 0 }, // karma
];

const LIVE_MONTH_REQUESTS = 2738;
const LIVE_MONTH_TOKENS = 22_137_386;
const LIVE_MONTH_INCURRED_USD = '258.61';

// ---------------------------------------------------------------------------
// ITEM 1 — a real absence rendered as a value.
// ---------------------------------------------------------------------------

describe('breakdownMetricCell — a zero beside a positive sibling is not a measurement', () => {
  it('renders "—", not "0", for the requests of a row carrying 30.5M tokens', () => {
    const cell = breakdownMetricCell('requests', { requests: 0, tokens: 30_583_866 });
    expect(cell.kind).toBe('unattributed');
    expect(cell.text).toBe('—');
    // The dash must SAY why, or it is just a different unexplained glyph.
    expect(cell.kind === 'unattributed' && cell.title).toMatch(/not a measured zero/i);
  });

  it('renders "—", not "0", for the tokens of a row carrying 2,683 requests', () => {
    const cell = breakdownMetricCell('tokens', { requests: 2683, tokens: 0 });
    expect(cell.kind).toBe('unattributed');
    expect(cell.text).toBe('—');
  });

  it('a genuinely idle row keeps its zero — absence and idleness are different claims', () => {
    expect(breakdownMetricCell('requests', { requests: 0, tokens: 0 })).toEqual({
      kind: 'value',
      text: '0',
    });
    expect(breakdownMetricCell('tokens', { requests: 0, tokens: 0 })).toEqual({
      kind: 'value',
      text: '0',
    });
  });

  it('a measured positive value is never dashed away', () => {
    expect(breakdownMetricCell('tokens', { requests: 0, tokens: 30_583_866 })).toEqual({
      kind: 'value',
      text: '30,583,866',
    });
    expect(breakdownMetricCell('requests', { requests: 2683, tokens: 0 })).toEqual({
      kind: 'value',
      text: '2,683',
    });
  });

  it('no cell in the live table renders a contradictory zero', () => {
    for (const row of LIVE_SERVICES) {
      for (const metric of ['requests', 'tokens'] as const) {
        const cell = breakdownMetricCell(metric, row);
        const other = metric === 'requests' ? row.tokens : row.requests;
        if (cell.text === '0') expect(other).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — different denominators (calendar month vs last 30 days, cost rollup
// vs usage rollup). Both numbers are right; displaying them unlabelled is not.
// ---------------------------------------------------------------------------

describe('breakdownTotalsNote — the headline and the table are different windows', () => {
  it('explains the 22,137,386 vs 30,583,866 gap instead of leaving it to be read as an error', () => {
    const note = breakdownTotalsNote({
      monthRequests: LIVE_MONTH_REQUESTS,
      monthTokens: LIVE_MONTH_TOKENS,
      rows: LIVE_SERVICES,
    });
    expect(note).not.toBeNull();
    // Both windows must be named, and both totals quoted, or the reader still
    // cannot tell which number covers what.
    expect(note).toMatch(/calendar month/i);
    expect(note).toMatch(/last 30 days/i);
    expect(note).toContain('22,137,386');
    expect(note).toContain('30,583,866');
  });

  it('stays silent when the two rollups actually agree', () => {
    expect(
      breakdownTotalsNote({
        monthRequests: 100,
        monthTokens: 5000,
        rows: [{ requests: 100, tokens: 5000 }],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ITEM 3 — a real absence rendered as a value, plus the page-level check.
// `consumed_tokens` is OPTIONAL upstream
// (backend/src/integrations/metering/usage.ts:384) and `?? 0` turned a missing
// field into "0% consumed — full headroom".
// ---------------------------------------------------------------------------

describe('budgetConsumption — a missing consumption field is not zero consumption', () => {
  it('an absent consumed_tokens renders "—" and NO percentage', () => {
    const c = budgetConsumption({ budget_tokens: 10_000_000 });
    expect(c.kind).toBe('unreported');
    expect(c.consumedText).toBe('—');
    expect(c.pct).toBeNull();
    expect(c.allocationText).toBe('10,000,000');
  });

  it('an explicit null is treated the same as an absent field', () => {
    expect(budgetConsumption({ budget_tokens: 50_000_000, consumed_tokens: null }).kind).toBe(
      'unreported',
    );
  });

  it('a genuine numeric zero from upstream still renders as 0 / 0%', () => {
    const c = budgetConsumption({ budget_tokens: 10_000_000, consumed_tokens: 0 });
    expect(c.kind).toBe('measured');
    expect(c.consumedText).toBe('0');
    expect(c.pct).toBe(0);
  });

  it('a measured consumption keeps its number and percentage', () => {
    const c = budgetConsumption({ budget_tokens: 10_000_000, consumed_tokens: 2_500_000 });
    expect(c).toEqual({
      kind: 'measured',
      consumedText: '2,500,000',
      allocationText: '10,000,000',
      pct: 25,
    });
  });

  it('a missing allocation is dashed too, never printed as "/ 0"', () => {
    expect(budgetConsumption({ consumed_tokens: 5 }).allocationText).toBe('—');
  });
});

describe('budgetReconciliationNote — six zero budgets cannot coexist with 22.1M tokens spent', () => {
  const SIX_LIVE_BUDGETS: BudgetRowMetrics[] = [
    { budget_tokens: 10_000_000, consumed_tokens: 0 },
    { budget_tokens: 50_000_000, consumed_tokens: 0 },
    { budget_tokens: 50_000_000, consumed_tokens: 0 },
    { budget_tokens: 10_000_000, consumed_tokens: 0 },
    { budget_tokens: 10_000_000, consumed_tokens: 0 },
    { budget_tokens: 10_000_000, consumed_tokens: 0 },
  ];

  it('flags the contradiction rather than presenting the allocations as headroom', () => {
    const note = budgetReconciliationNote({
      budgets: SIX_LIVE_BUDGETS,
      monthTokens: LIVE_MONTH_TOKENS,
    });
    expect(note).not.toBeNull();
    expect(note).toContain('22,137,386');
    expect(note).toMatch(/not reconciled|unverified/i);
  });

  it('also fires when consumption is absent rather than zero', () => {
    expect(
      budgetReconciliationNote({
        budgets: [{ budget_tokens: 10_000_000 }],
        monthTokens: LIVE_MONTH_TOKENS,
      }),
    ).not.toBeNull();
  });

  it('stays silent once any budget reports real consumption', () => {
    expect(
      budgetReconciliationNote({
        budgets: [...SIX_LIVE_BUDGETS, { budget_tokens: 10_000_000, consumed_tokens: 1 }],
        monthTokens: LIVE_MONTH_TOKENS,
      }),
    ).toBeNull();
  });

  it('stays silent when the workspace genuinely spent nothing this month', () => {
    expect(budgetReconciliationNote({ budgets: SIX_LIVE_BUDGETS, monthTokens: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ITEM 4 — different denominators. The `—` cells are already CORRECT; the
// defect is that they sit unexplained under a confident $258.61.
// ---------------------------------------------------------------------------

describe('breakdownCostNote — say where $258.61 came from when the column is all dashes', () => {
  it('names the dash as "not reported" and the headline as a different rollup', () => {
    const note = breakdownCostNote(true, LIVE_MONTH_INCURRED_USD, 'incurred (provider)');
    expect(note).not.toBeNull();
    expect(note).toContain('$258.61');
    expect(note).toMatch(/not reported/i);
    expect(note).toMatch(/not the sum of this column/i);
  });

  it('stays silent when per-service cost IS available', () => {
    expect(breakdownCostNote(false, LIVE_MONTH_INCURRED_USD)).toBeNull();
  });
});
