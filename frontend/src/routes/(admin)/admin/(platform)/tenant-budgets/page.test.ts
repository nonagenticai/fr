import { describe, it, expect } from 'vitest';
import {
  buildTenantBudgetView,
  budgetStateLabel,
  sortByUrgency,
  LOW_BUDGET_THRESHOLD,
} from './page-helpers';
import type { BudgetStatusResponse } from '$lib/api/usage';

function status(p: Partial<BudgetStatusResponse>): BudgetStatusResponse {
  return {
    tenant_id: 't',
    total_remaining: 0,
    budget_count: 0,
    next_expiry: null,
    budgets: [],
    ...p,
  };
}

describe('buildTenantBudgetView', () => {
  it('an unconfigured tenant is NOT 0% used', () => {
    // The whole point. `consumedFraction` in the tenant helpers returns 0 here,
    // which renders an empty bar indistinguishable from a tenant that has spent
    // nothing — and the two demand opposite actions.
    const v = buildTenantBudgetView('t1', status({ budget_count: 0 }));
    expect(v.state).toBe('unconfigured');
    expect(v.consumedFraction).toBeNull();
    expect(budgetStateLabel(v)).toBe('No budget configured');
  });

  it('a failed read is never rendered as a healthy zero', () => {
    const v = buildTenantBudgetView('t1', null);
    expect(v.consumedFraction).toBeNull();
    expect(v.remainingTokens).toBeNull();
  });

  it('an exhausted budget is distinguished from an absent one', () => {
    // Both have zero remaining; only one means "top this up".
    const v = buildTenantBudgetView(
      't1',
      status({
        budget_count: 1,
        total_remaining: 0,
        budgets: [{ budget_tokens: 1000, consumed_tokens: 1000 } as never],
      }),
    );
    expect(v.state).toBe('exhausted');
    expect(v.consumedFraction).toBe(1);
  });

  it('flags low at the threshold, not past it', () => {
    const v = buildTenantBudgetView(
      't1',
      status({
        budget_count: 1,
        total_remaining: 200,
        budgets: [{ budget_tokens: 1000, consumed_tokens: 800 } as never],
      }),
    );
    expect(v.consumedFraction).toBeCloseTo(LOW_BUDGET_THRESHOLD);
    expect(v.state).toBe('low');
  });

  it('healthy below the threshold', () => {
    const v = buildTenantBudgetView(
      't1',
      status({
        budget_count: 1,
        total_remaining: 900,
        budgets: [{ budget_tokens: 1000, consumed_tokens: 100 } as never],
      }),
    );
    expect(v.state).toBe('healthy');
    expect(v.consumedFraction).toBeCloseTo(0.1);
  });

  it('a configured but unmetered budget reports no fraction, not 0%', () => {
    // budget_tokens 0 with a real budget row: configured, unmeasurable. A
    // fraction here would be a divide-by-zero dressed up as "0% used".
    const v = buildTenantBudgetView(
      't1',
      status({
        budget_count: 1,
        total_remaining: 0,
        budgets: [{ budget_tokens: 0, consumed_tokens: 0 } as never],
      }),
    );
    expect(v.state).toBe('healthy');
    expect(v.consumedFraction).toBeNull();
    expect(budgetStateLabel(v)).toBe('Unmetered');
  });

  it('never reports negative remaining after an overspend', () => {
    const v = buildTenantBudgetView(
      't1',
      status({
        budget_count: 1,
        total_remaining: -50,
        budgets: [{ budget_tokens: 100, consumed_tokens: 150 } as never],
      }),
    );
    expect(v.remainingTokens).toBe(0);
    expect(v.consumedFraction).toBe(1);
  });
});

describe('sortByUrgency', () => {
  it('puts what needs action first and unconfigured above healthy', () => {
    const mk = (id: string, s: BudgetStatusResponse | null) => buildTenantBudgetView(id, s);
    const rows = [
      mk('healthy', status({ budget_count: 1, total_remaining: 900, budgets: [{ budget_tokens: 1000, consumed_tokens: 100 } as never] })),
      mk('unconfigured', status({ budget_count: 0 })),
      mk('exhausted', status({ budget_count: 1, total_remaining: 0, budgets: [{ budget_tokens: 10, consumed_tokens: 10 } as never] })),
      mk('low', status({ budget_count: 1, total_remaining: 100, budgets: [{ budget_tokens: 1000, consumed_tokens: 900 } as never] })),
    ];
    expect(sortByUrgency(rows).map((r) => r.tenantId)).toEqual([
      'exhausted',
      'low',
      'unconfigured',
      'healthy',
    ]);
  });

  it('does not mutate its input', () => {
    const rows = [
      buildTenantBudgetView('b', status({ budget_count: 0 })),
      buildTenantBudgetView('a', status({ budget_count: 0 })),
    ];
    const before = rows.map((r) => r.tenantId);
    sortByUrgency(rows);
    expect(rows.map((r) => r.tenantId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The Top up cell. THE DEFECT: `fetchAdminBudgetPackages().catch(() => [])`
// plus a cell gated on `packages.length === 0` rendered an em-dash on every
// row — identical to a platform with no packages configured. The failure
// removed this page's only remediation while looking like policy, and the two
// demand opposite actions (retry the read vs. go create a package).
// ---------------------------------------------------------------------------

import { topUpCellState } from './page-helpers';

describe('topUpCellState', () => {
  it('an unreadable catalogue is NOT "no packages configured"', () => {
    expect(topUpCellState(0, true)).toBe('unreadable');
  });

  it('unreadable outranks a stale catalogue still in hand', () => {
    expect(topUpCellState(4, true)).toBe('unreadable');
  });

  it('only a successful empty read may render the em-dash', () => {
    expect(topUpCellState(0, false)).toBe('none');
  });

  it('renders the top-up buttons when the catalogue read', () => {
    expect(topUpCellState(3, false)).toBe('packages');
  });
});

// ---------------------------------------------------------------------------
// Grouping by tenant kind. THE DEFECT being avoided: 5 real customers were
// listed flat among 33 `kind='service'` machine principals and 3 test tenants,
// so the operator could not tell which budget mattered. The fix groups; it
// never filters. fr#936 is the cautionary case — a filter dropped 33 rows and
// the page still returned 200, so nothing announced the loss.
// ---------------------------------------------------------------------------

import { groupOfKind, partitionByKind, summariseGroup } from './page-helpers';

describe('groupOfKind', () => {
  it('buckets the two kinds we can positively identify', () => {
    expect(groupOfKind('service')).toBe('services');
    expect(groupOfKind('test')).toBe('tests');
  });

  it('a known human kind is a workspace', () => {
    expect(groupOfKind('customer')).toBe('workspaces');
    expect(groupOfKind('internal')).toBe('workspaces');
    expect(groupOfKind('unclassified')).toBe('workspaces');
  });

  it('an unknown, absent or not-yet-migrated kind defaults to workspaces', () => {
    // `kind` arrived in licences migration 027; a deployment predating it sends
    // no kind at all, and a future release may send one this build has never
    // heard of. Either way the tenant must stay in front of the operator —
    // defaulting into a collapsed machine bucket hides a paying customer.
    expect(groupOfKind('wat')).toBe('workspaces');
    expect(groupOfKind(null)).toBe('workspaces');
    expect(groupOfKind(undefined)).toBe('workspaces');
  });
});

describe('partitionByKind', () => {
  const view = (id: string, s: BudgetStatusResponse | null) => buildTenantBudgetView(id, s);
  const unconfigured = (id: string) => view(id, status({ budget_count: 0 }));

  it('always returns all three keys, empty arrays included', () => {
    // A caller iterating the keys must render "no service tenants" rather than
    // skip a section it wrongly concluded did not exist.
    const groups = partitionByKind([unconfigured('a')], { a: 'customer' });
    expect(Object.keys(groups).sort()).toEqual(['services', 'tests', 'workspaces']);
    expect(groups.services).toEqual([]);
    expect(groups.tests).toEqual([]);
  });

  it('a tenant id absent from kindById still gets a row (fr#936 regression guard)', () => {
    // fr#936: a filter deleted 33 rows and the page still returned 200. An id
    // the kind lookup does not know about must appear, not vanish.
    const groups = partitionByKind([unconfigured('ghost')], {});
    expect(groups.workspaces.map((r) => r.tenantId)).toEqual(['ghost']);
  });

  it('drops nothing: every input lands in exactly one group', () => {
    const rows = [unconfigured('svc'), unconfigured('tst'), unconfigured('cust'), unconfigured('unknown')];
    const groups = partitionByKind(rows, { svc: 'service', tst: 'test', cust: 'customer' });
    const total = groups.workspaces.length + groups.services.length + groups.tests.length;
    expect(total).toBe(rows.length);
    expect(groups.services.map((r) => r.tenantId)).toEqual(['svc']);
    expect(groups.tests.map((r) => r.tenantId)).toEqual(['tst']);
    expect(groups.workspaces.map((r) => r.tenantId)).toEqual(['cust', 'unknown']);
  });

  it('orders by urgency within each group, not across the page', () => {
    // A low service budget must not outrank a low customer budget.
    const rows = [
      view('w-healthy', status({ budget_count: 1, total_remaining: 900, budgets: [{ budget_tokens: 1000, consumed_tokens: 100 } as never] })),
      view('w-exhausted', status({ budget_count: 1, total_remaining: 0, budgets: [{ budget_tokens: 10, consumed_tokens: 10 } as never] })),
      view('s-exhausted', status({ budget_count: 1, total_remaining: 0, budgets: [{ budget_tokens: 10, consumed_tokens: 10 } as never] })),
    ];
    const groups = partitionByKind(rows, { 's-exhausted': 'service' });
    expect(groups.workspaces.map((r) => r.tenantId)).toEqual(['w-exhausted', 'w-healthy']);
    expect(groups.services.map((r) => r.tenantId)).toEqual(['s-exhausted']);
  });
});

describe('summariseGroup', () => {
  it('an all-unconfigured group totals null, NOT 0', () => {
    // 0 asserts "no allowance"; null says "nothing was configured to total".
    // The header must not render a group of unconfigured tenants as a fleet
    // with a zero budget — that is the same conflation buildTenantBudgetView
    // exists to prevent, one level up.
    const s = summariseGroup([
      buildTenantBudgetView('a', status({ budget_count: 0 })),
      buildTenantBudgetView('b', null),
    ]);
    expect(s.count).toBe(2);
    expect(s.totalTokens).toBeNull();
    expect(s.remainingTokens).toBeNull();
    expect(s.consumedFraction).toBeNull();
    expect(s.unconfigured).toBe(2);
  });

  it('an empty group is null too, and reports no rows', () => {
    const s = summariseGroup([]);
    expect(s).toEqual({
      count: 0,
      budgetRowCount: 0,
      totalTokens: null,
      remainingTokens: null,
      consumedFraction: null,
      unconfigured: 0,
    });
  });

  it('sums the rows that carried numbers and ignores the ones that did not', () => {
    const s = summariseGroup([
      buildTenantBudgetView('a', status({ budget_count: 1, total_remaining: 900, budgets: [{ budget_tokens: 1000, consumed_tokens: 100 } as never] })),
      buildTenantBudgetView('b', status({ budget_count: 1, total_remaining: 100, budgets: [{ budget_tokens: 1000, consumed_tokens: 900 } as never] })),
      buildTenantBudgetView('c', status({ budget_count: 0 })),
    ]);
    expect(s.count).toBe(3);
    expect(s.totalTokens).toBe(2000);
    expect(s.remainingTokens).toBe(1000);
    expect(s.consumedFraction).toBeCloseTo(0.5);
    // The unconfigured row is counted, never silently folded into the average.
    expect(s.unconfigured).toBe(1);
  });

  it('an unmetered row contributes its remaining without inventing a total', () => {
    // budget_count 1 with budget_tokens 0: remaining is real, total is null.
    // The group fraction stays null rather than dividing by the zero allowance.
    const s = summariseGroup([
      buildTenantBudgetView('a', status({ budget_count: 1, total_remaining: 50, budgets: [{ budget_tokens: 0, consumed_tokens: 0 } as never] })),
    ]);
    expect(s.totalTokens).toBeNull();
    expect(s.remainingTokens).toBe(50);
    expect(s.consumedFraction).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The three money columns. THE DEFECT: the Used column held ONLY a progress
// bar, so a tenant at 0% painted a 0-width invisible div and there was nowhere
// on the page to read used tokens — or the total they were used against. The
// null discipline is unchanged: a number we do not have renders `—`, never 0.
// ---------------------------------------------------------------------------

import {
  budgetLineUsed,
  budgetLineViews,
  budgetRowsLabel,
  budgetSumLabel,
  formatTokensOrDash,
  parseBudgetOverride,
  resetResultNotice,
  usedPercentLabel,
  usedTokens,
} from './page-helpers';

/**
 * conveyor's shape, measured live 2026-10-31: 23 stacked `license_sync` rows
 * (one per licence), whose budgets and remainders are summed into one figure.
 * Per-row values are passed separately so every expectation below is exact —
 * an aggregate divided by 23 is not an integer.
 */
function stackedStatus(rows: number, rowBudget = 1000, rowRemaining = 800): BudgetStatusResponse {
  return status({
    budget_count: rows,
    total_remaining: rows * rowRemaining,
    budgets: Array.from({ length: rows }, (_, i) => ({
      budget_id: `b${i}`,
      license_id: `l${i}`,
      budget_tokens: rowBudget,
      remaining_tokens: rowRemaining,
      priority: 100,
      period: 'monthly',
      source: 'license_sync',
    })),
  });
}

describe('usedTokens', () => {
  it('is total minus remaining — the inverse of the Budget and Remaining cells', () => {
    const v = buildTenantBudgetView(
      't',
      status({ budget_count: 1, total_remaining: 200, budgets: [{ budget_tokens: 1000, remaining_tokens: 200 }] }),
    );
    expect(usedTokens(v)).toBe(800);
  });

  it('sums the rows exactly like the views total, so the three columns agree', () => {
    // 23 rows of 63,043,478 budget / 49,704,348 remaining = 1,449,999,994
    // allocated, 1,143,200,004 remaining, 306,799,990 used.
    const v = buildTenantBudgetView('conveyor', stackedStatus(23, 63_043_478, 49_704_348));
    expect(v.totalTokens).toBe(1_449_999_994);
    expect(v.remainingTokens).toBe(1_143_200_004);
    expect(usedTokens(v)).toBe(306_799_990);
  });

  it('never reports negative usage after an overspend', () => {
    const v = buildTenantBudgetView(
      't',
      status({ budget_count: 1, total_remaining: -50, budgets: [{ budget_tokens: 100, remaining_tokens: -5 }] }),
    );
    // remaining is clamped at 0, so used is the whole allowance, never negative.
    expect(usedTokens(v)).toBe(100);
  });

  it('is null — never 0 — when the total could not be read', () => {
    // An unmetered (zero-allowance) budget: configured, but there is no total
    // to subtract from. 0 would claim "spent nothing", which is not the claim.
    const v = buildTenantBudgetView(
      't',
      status({ budget_count: 1, total_remaining: 0, budgets: [{ budget_tokens: 0, remaining_tokens: 0 }] }),
    );
    expect(v.totalTokens).toBeNull();
    expect(usedTokens(v)).toBeNull();
  });

  it('is null for an unreadable row', () => {
    expect(usedTokens(buildTenantBudgetView('t', null))).toBeNull();
  });
});

describe('usedPercentLabel', () => {
  it('rounds the fraction and says what it is', () => {
    expect(usedPercentLabel(0.215)).toBe('22% used');
    expect(usedPercentLabel(1)).toBe('100% used');
    expect(usedPercentLabel(0)).toBe('0% used');
  });

  it('a null fraction is an em-dash, never "0% used"', () => {
    // The whole conflation this helper file exists to prevent: an unconfigured
    // tenant must not look like a tenant that has spent nothing.
    expect(usedPercentLabel(null)).toBe('—');
  });
});

describe('formatTokensOrDash', () => {
  it('formats numbers the way the tenant budget page does', () => {
    expect(formatTokensOrDash(1_450_000_000)).toBe('1450M');
    expect(formatTokensOrDash(306_800_000)).toBe('306.8M');
    expect(formatTokensOrDash(2_500)).toBe('2.5K');
    expect(formatTokensOrDash(42)).toBe('42');
  });

  it('a missing figure is an em-dash, never 0', () => {
    expect(formatTokensOrDash(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// The sum-vs-one-budget defect. conveyor's 1.45B is 23 stacked budget rows;
// presented bare it reads as ONE budget, which sends an operator looking for a
// row that does not exist. The row count is stated whenever it is a sum.
// ---------------------------------------------------------------------------

describe('budgetSumLabel', () => {
  it('states the row count when the figure is a sum of several rows', () => {
    const v = buildTenantBudgetView('conveyor', stackedStatus(23, 1_450_000_000, 1_143_200_000));
    expect(budgetSumLabel(v)).toBe('sum of 23 budget rows');
  });

  it('is null for a single row — one budget is one budget', () => {
    const v = buildTenantBudgetView(
      't',
      status({ budget_count: 1, total_remaining: 900, budgets: [{ budget_tokens: 1000, remaining_tokens: 900 }] }),
    );
    expect(budgetSumLabel(v)).toBeNull();
  });

  it('is null for an unreadable or unconfigured row — never "sum of 0 budget rows"', () => {
    expect(budgetSumLabel(buildTenantBudgetView('t', null))).toBeNull();
    expect(budgetSumLabel(buildTenantBudgetView('t', status({ budget_count: 0 })))).toBeNull();
  });
});

describe('budgetRowsLabel', () => {
  it('says how many rows a group header sum covers', () => {
    expect(budgetRowsLabel(23)).toBe('23 budget rows');
    expect(budgetRowsLabel(1)).toBe('1 budget row');
  });

  it('zero says no rows were summed, not "0 budget rows"', () => {
    expect(budgetRowsLabel(0)).toBe('no budget rows');
  });
});

describe('summariseGroup — the header knows how many rows its sum covers', () => {
  it('adds the entries across every view in the group', () => {
    const s = summariseGroup([
      buildTenantBudgetView('a', stackedStatus(3)),
      buildTenantBudgetView('b', stackedStatus(2)),
      buildTenantBudgetView('c', status({ budget_count: 0 })),
    ]);
    expect(s.count).toBe(3);
    expect(s.budgetRowCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The per-licence breakdown: each budget row, its used figure, and whether an
// operator can adjust it (a row with no licence cannot be).
// ---------------------------------------------------------------------------

describe('budgetLineUsed', () => {
  it('is budget_tokens minus remaining_tokens', () => {
    expect(budgetLineUsed({ budget_tokens: 1000, remaining_tokens: 250 })).toBe(750);
  });

  it('falls back to billing’s own consumed count when remaining is absent', () => {
    expect(budgetLineUsed({ budget_tokens: 1000, used_tokens: 400 })).toBe(400);
    expect(budgetLineUsed({ budget_tokens: 1000, consumed_tokens: 300 })).toBe(300);
  });

  it('never negative', () => {
    expect(budgetLineUsed({ budget_tokens: 1000, remaining_tokens: -500 })).toBe(1000);
  });

  it('is null — never 0 — for a row whose allowance is missing or zero', () => {
    expect(budgetLineUsed({ remaining_tokens: 0 })).toBeNull();
    expect(budgetLineUsed({ budget_tokens: 0, remaining_tokens: 0 })).toBeNull();
  });
});

describe('budgetLineViews', () => {
  it('carries every column the breakdown renders, with nulls preserved', () => {
    const [line] = budgetLineViews([
      {
        budget_id: 'b1',
        license_id: 'lic-1',
        source: 'license_sync',
        budget_tokens: 1000,
        remaining_tokens: 250,
        period: 'monthly',
        expires_at: '2026-12-01T00:00:00Z',
        priority: 100,
      },
    ]);
    expect(line).toEqual({
      key: 'b1',
      budgetId: 'b1',
      licenseId: 'lic-1',
      source: 'license_sync',
      budgetTokens: 1000,
      usedTokens: 750,
      remainingTokens: 250,
      period: 'monthly',
      expiresAt: '2026-12-01T00:00:00Z',
      priority: 100,
    });
  });

  it('a row no licence backs keeps licenseId null so the page can say WHY it is not adjustable', () => {
    // The control is not hidden for these rows — hiding it looks like a UI gap.
    const [line] = budgetLineViews([{ budget_id: 'topup-1', source: 'topup', budget_tokens: 5_000_000 }]);
    expect(line.licenseId).toBeNull();
    expect(line.source).toBe('topup');
    // No remaining figure: the used number is unknown, not zero.
    expect(line.usedTokens).toBeNull();
  });

  it('a row with no ids still gets a stable fallback key', () => {
    const lines = budgetLineViews([{ budget_tokens: 1 }, { budget_tokens: 2 }]);
    expect(lines.map((l) => l.key)).toEqual(['row-0', 'row-1']);
  });
});

// ---------------------------------------------------------------------------
// Adjust input: EMPTY means "clear the override", and a typo never reaches the
// write. Anything that is not a non-negative whole number is refused locally.
// ---------------------------------------------------------------------------

describe('parseBudgetOverride', () => {
  it('an empty input CLEARS the override (null), it does not mean "no change"', () => {
    expect(parseBudgetOverride('')).toEqual({ ok: true, value: null });
    expect(parseBudgetOverride('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts a whole number of tokens', () => {
    expect(parseBudgetOverride('5000000')).toEqual({ ok: true, value: 5_000_000 });
    expect(parseBudgetOverride('0')).toEqual({ ok: true, value: 0 });
  });

  it('refuses a negative, fractional or non-numeric value before any request is sent', () => {
    expect(parseBudgetOverride('-1').ok).toBe(false);
    expect(parseBudgetOverride('1.5').ok).toBe(false);
    expect(parseBudgetOverride('lots').ok).toBe(false);
  });
});

describe('resetResultNotice', () => {
  it('states WHAT the reset did, from billing’s own numbers', () => {
    expect(resetResultNotice('conveyor', { reset_count: 23, previous_consumed_total: 306_800_000 })).toBe(
      'Reset 23 budget rows for conveyor — 306.8M consumed tokens cleared.',
    );
    expect(resetResultNotice('acme', { reset_count: 1, previous_consumed_total: 0 })).toBe(
      'Reset 1 budget row for acme — 0 consumed tokens cleared.',
    );
  });

  it('reset_count 0 is an ANSWER — nothing matched — not a success', () => {
    expect(resetResultNotice('acme', { reset_count: 0, previous_consumed_total: 0 })).toBe(
      'No budget rows were reset for acme.',
    );
  });
});

// ---------------------------------------------------------------------------
// Unreadable vs unconfigured, at the new columns. Both give nulls; neither may
// manufacture a 0 or a "sum of 0 rows".
// ---------------------------------------------------------------------------

describe('unreadable vs unconfigured at the new columns', () => {
  it('an unreadable read yields no figures and no sum label', () => {
    const v = buildTenantBudgetView('t', null);
    expect(v.entries).toEqual([]);
    expect(usedTokens(v)).toBeNull();
    expect(formatTokensOrDash(v.totalTokens)).toBe('—');
    expect(budgetSumLabel(v)).toBeNull();
  });

  it('an unconfigured tenant is likewise empty — the caller distinguishes them by its own error set', () => {
    const v = buildTenantBudgetView('t', status({ budget_count: 0 }));
    expect(v.entries).toEqual([]);
    expect(usedTokens(v)).toBeNull();
    expect(budgetSumLabel(v)).toBeNull();
  });

  it('the entries that were read survive on the view for the breakdown', () => {
    const v = buildTenantBudgetView('t', stackedStatus(2, 2000, 1000));
    expect(v.entries).toHaveLength(2);
    expect(budgetLineViews(v.entries)).toHaveLength(2);
  });
});
