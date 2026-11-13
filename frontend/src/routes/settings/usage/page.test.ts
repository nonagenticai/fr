// src/routes/settings/usage/page.test.ts
//
// Component-level rendering tests aren't viable (vitest runs in
// `environment: 'node'` and `@testing-library/svelte` is not
// installed). Factor logic into pure helpers + verify them here.

import { describe, it, expect } from 'vitest';
import {
  includedUsagePercent,
  formatNumber,
  formatCostUsd,
  breakdownCostCell,
  quotaPercent,
  quotaLabel,
} from './page-helpers';

describe('formatNumber', () => {
  it('groups thousands with commas', () => {
    expect(formatNumber(1500)).toBe('1,500');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(1_234_567)).toBe('1,234,567');
  });
});

describe('formatCostUsd', () => {
  it('returns $0.00 for unparseable input', () => {
    expect(formatCostUsd('not-a-number')).toBe('$0.00');
  });
  it('formats with two decimals and dollar sign', () => {
    expect(formatCostUsd('4.2')).toBe('$4.20');
    expect(formatCostUsd('0')).toBe('$0.00');
    expect(formatCostUsd('123.456')).toBe('$123.46');
  });
});

describe('quotaPercent', () => {
  it('returns null when quota is null', () => {
    expect(quotaPercent(50, null)).toBeNull();
  });
  it('returns null when quota is zero or negative', () => {
    expect(quotaPercent(50, 0)).toBeNull();
    expect(quotaPercent(50, -10)).toBeNull();
  });
  it('clamps to 0..100 and rounds', () => {
    expect(quotaPercent(0, 100)).toBe(0);
    expect(quotaPercent(33, 100)).toBe(33);
    expect(quotaPercent(150, 100)).toBe(100);
    expect(quotaPercent(33.7, 100)).toBe(34);
  });
});

describe('quotaLabel', () => {
  it('returns "Unmetered" for null quota', () => {
    expect(quotaLabel(50, null)).toBe('Unmetered');
  });
  it('formats as consumed / quota with thousands separators', () => {
    expect(quotaLabel(1500, 5000)).toBe('1,500 / 5,000');
  });
  it('passes through pre-formatted strings (e.g. cost)', () => {
    expect(quotaLabel('$4.20', 100)).toBe('$4.20 / 100');
  });
});

describe('breakdownCostCell', () => {
  it('renders em-dash when upstream reports cost_unavailable', () => {
    expect(breakdownCostCell('0', true)).toBe('—');
    expect(breakdownCostCell('0.42', true)).toBe('—');
  });
  it('formats as USD when cost data is available', () => {
    expect(breakdownCostCell('1.25', false)).toBe('$1.25');
    expect(breakdownCostCell('0', false)).toBe('$0.00');
  });
});

// ---------------------------------------------------------------------------
// The plan tile. THE DEFECT: `catch { plan = null }` + a tile gated on
// `hasPlan` meant a failed `GET /api/me/plan` HID the tile — pixel-identical to
// a tenant that has no recurring access fee. A billing outage therefore told a
// paying user they were on the free tier. "Unknown plan" must never render as a
// lower tier.
// ---------------------------------------------------------------------------

import { planTileState, type PlanTotals } from './page-helpers';

const paid: PlanTotals = { monthly_total_usd: '49.00', monthly_included_usd: '10.00' };
const free: PlanTotals = { monthly_total_usd: '0', monthly_included_usd: '0' };

describe('planTileState', () => {
  it('a failed read is UNREADABLE, never the free tier', () => {
    expect(planTileState({ plan: null, error: 'HTTP 503', loaded: true })).toBe('unreadable');
  });

  it('an error outranks a plan left over from a previous load', () => {
    expect(planTileState({ plan: paid, error: 'HTTP 503', loaded: true })).toBe('unreadable');
  });

  it('loaded-but-null is still unreadable — absence is not evidence of no plan', () => {
    expect(planTileState({ plan: null, error: null, loaded: true })).toBe('unreadable');
  });

  it('a non-numeric amount is an unusable answer, not a zero one', () => {
    expect(
      planTileState({
        plan: { monthly_total_usd: '', monthly_included_usd: '' },
        error: null,
        loaded: true,
      }),
    ).toBe('unreadable');
  });

  it('before the read lands it says nothing at all', () => {
    expect(planTileState({ plan: null, error: null, loaded: false })).toBe('loading');
  });

  it('only a SUCCESSFUL read of an all-zero plan may hide the tile', () => {
    expect(planTileState({ plan: free, error: null, loaded: true })).toBe('none');
  });

  it('shows the plan when there is a fee or included usage', () => {
    expect(planTileState({ plan: paid, error: null, loaded: true })).toBe('plan');
    expect(
      planTileState({
        plan: { monthly_total_usd: '0', monthly_included_usd: '25' },
        error: null,
        loaded: true,
      }),
    ).toBe('plan');
  });
});

// Owner ruling: when the tenant's markup is unknown the backend WITHHOLDS the
// billed figure (null, cost_basis 'unavailable') instead of sending incurred.
// A null must read "—", never "$0.00" (which reads as "nothing was spent").
describe('formatCostUsd — a withheld figure', () => {
  it('renders null/undefined as an em dash, not $0.00', () => {
    expect(formatCostUsd(null)).toBe('—');
    expect(formatCostUsd(undefined)).toBe('—');
  });
  it('a withheld breakdown cell is a dash even when cost is otherwise available', () => {
    expect(breakdownCostCell(null, false)).toBe('—');
  });
});


describe('includedUsagePercent (plan tile bar)', () => {
  it('null = withheld consumption → null, never NaN', () => {
    expect(includedUsagePercent(null, '10.00')).toBeNull();
    expect(includedUsagePercent(undefined, '10.00')).toBeNull();
    expect(includedUsagePercent('abc', '10.00')).toBeNull();
  });
  it('clamps to 0..100 and rounds', () => {
    expect(includedUsagePercent('2.00', '10.00')).toBe(20);
    expect(includedUsagePercent('42.00', '10.00')).toBe(100);
    expect(includedUsagePercent('1.00', '0')).toBe(0);
  });
});
