// cost.test.ts — the Cost page's pure logic (R6, cockpit C7). Every number the page prints is
// built here, so this is where the null≠zero rules and the phase/capability derivation are pinned.
import { describe, it, expect } from 'vitest';
import type { CockpitProjectCosts, CostCardRow } from '$lib/types/cockpit';
import {
  ALL_PHASES,
  asOfWords,
  basisWords,
  burnSeries,
  cardLines,
  costDays,
  costPhaseShown,
  groupByCapability,
  groupByPhase,
  phaseSummary,
  provisionalTodayLine,
  rowsInPhase,
  segmentWidth,
  spendLine,
  spendSummary,
  stackGroups,
  sumRows,
  unannotatedWords,
} from './cost';

const COSTS: CockpitProjectCosts = {
  cost_basis: 'billed',
  settled: [
    { day: '2026-10-23', cost: 10, calls: 100, tokens_in: 1, tokens_out: 1 },
    { day: '2026-10-24', cost: 5, calls: 50, tokens_in: 1, tokens_out: 1 },
  ],
  provisional: { since: '2026-10-25', cost: 2.5, calls: 25, tokens_in: 1, tokens_out: 1 },
  by_card: [],
  by_card_since: '2026-10-23',
  totals: { cost: 17.5, settled_cost: 15, provisional_cost: 2.5, calls: 175, tokens_in: 3, tokens_out: 3 },
  currency: 'USD',
  basis: 'billed',
  as_of: '2026-10-25T13:03:00Z',
};

const ROWS: CostCardRow[] = [
  { card_id: 'c1', cost: 10, calls: 100, phase: 'setup', card_type: 'project_setup', capability: 'project_management' },
  { card_id: 'c2', cost: 4, calls: 40, phase: 'execution', card_type: 'development_bug_fix', capability: 'development' },
  { card_id: 'c3', cost: 1, calls: 10, phase: 'execution', card_type: 'qa_check', capability: 'qa' },
  { card_id: null, cost: 2, calls: 25, phase: null, card_type: null, capability: null },
];

const PHASES = [
  { name: 'setup', label: 'Setup' },
  { name: 'preliminary', label: 'Preliminary' },
  { name: 'execution', label: 'Execution' },
];

describe('the header line (confirmed R0 format)', () => {
  it('shows spend, model calls, and the honest no-budget label', () => {
    expect(spendSummary(COSTS, null, 'USD')).toBe('$17.50 total (175 model calls) · [budget not set]');
  });

  it('draws the budget only when one is set', () => {
    expect(spendSummary(COSTS, 50, 'USD')).toBe('$17.50 total (175 model calls) · of $50.00 budget');
  });

  it('an UNKNOWN budget (RM unreadable) is "[budget unavailable]", never "not set"', () => {
    expect(spendSummary(COSTS, null, 'USD', false)).toBe('$17.50 total (175 model calls) · [budget unavailable]');
    expect(spendLine(null, 175, null, 'USD', false)).toBe('Spend unavailable (175 model calls) · [budget unavailable]');
    // A budget that IS present still shows when RM answered — the flag only words the absence.
    expect(spendSummary(COSTS, 50, 'USD', false)).toBe('$17.50 total (175 model calls) · of $50.00 budget');
  });

  it('an unpriced total is "unavailable", never $0.00', () => {
    const out = spendLine(null, 175, null, 'USD');
    expect(out).toBe('Spend unavailable (175 model calls) · [budget not set]');
    expect(out).not.toContain('$0.00');
  });

  it('as-of is UTC, in one line', () => {
    expect(asOfWords('2026-10-25T13:03:00Z')).toBe('As of 25 Oct 13:03 UTC');
    expect(asOfWords('not a date')).toBeNull();
  });

  it('the basis is said in words; an unreadable pricing basis says nothing', () => {
    expect(basisWords('billed')).toContain('charged');
    expect(basisWords('incurred')).toContain('markup');
    expect(basisWords('unavailable')).toBeNull();
  });
});

describe('the phase filter', () => {
  it('defaults to the current phase, then All when it is not one of the project’s phases', () => {
    expect(costPhaseShown(PHASES, 'execution', null)).toBe('execution');
    expect(costPhaseShown(PHASES, 'closed-phase', null)).toBe(ALL_PHASES);
    expect(costPhaseShown(PHASES, 'execution', ALL_PHASES)).toBe(ALL_PHASES);
    expect(costPhaseShown(PHASES, 'execution', 'setup')).toBe('setup');
    expect(costPhaseShown([], 'execution', null)).toBe(ALL_PHASES);
  });

  it('keeps only the rows whose CARD recorded that phase; All keeps everything', () => {
    expect(rowsInPhase(ROWS, 'execution').map((r) => r.card_id)).toEqual(['c2', 'c3']);
    expect(rowsInPhase(ROWS, ALL_PHASES)).toHaveLength(4);
  });

  it('the phase line says what the phase’s card spend was', () => {
    expect(phaseSummary(rowsInPhase(ROWS, 'execution'), 'Execution', 'USD')).toBe('$5.00 in Execution (50 model calls)');
  });

  it('a filtered line discloses spend no phase holds, instead of reading as the whole picture', () => {
    const unphased = ROWS.filter((r) => r.phase == null);
    expect(phaseSummary(rowsInPhase(ROWS, 'execution'), 'Execution', 'USD', unphased)).toBe(
      '$5.00 in Execution (50 model calls) · $2.00 not tied to a phase (25 model calls)',
    );
    expect(phaseSummary([], 'Execution', 'USD', unphased)).toBe(
      '$0.00 in Execution (0 model calls) · $2.00 not tied to a phase (25 model calls)',
    );
  });
});

describe('sums and groups (null ≠ zero)', () => {
  it('a null amount makes the sum a floor, and an all-null set is unknown rather than 0', () => {
    expect(sumRows([...ROWS, { card_id: 'x', cost: null, calls: 5 }])).toEqual({ cost: 17, calls: 180, partial: true });
    expect(sumRows([{ card_id: 'x', cost: null, calls: 5 }])).toEqual({ cost: null, calls: 5, partial: true });
  });

  it('phases keep the project order, then "Not tied to a phase" last', () => {
    const groups = groupByPhase(ROWS, PHASES);
    expect(groups.map((g) => g.label)).toEqual(['Setup', 'Execution', 'Not tied to a phase']);
    expect(groups[0]).toMatchObject({ cost: 10, calls: 100, share: (10 / 17) * 100 });
    expect(groups.at(-1)).toMatchObject({ cost: 2, calls: 25 });
  });

  it('a phase name no longer in the phase list is still shown, made readable', () => {
    const groups = groupByPhase([{ card_id: 'z', cost: 1, calls: 1, phase: 'legacy_phase' }], PHASES);
    expect(groups.map((g) => g.label)).toEqual(['Legacy phase']);
  });

  it('capabilities group by RM’s name; rows no capability names are their own bucket', () => {
    const groups = groupByCapability(ROWS);
    expect(groups.map((g) => g.label)).toEqual(['Development', 'Project management', 'Qa', 'No capability recorded']);
    expect(groups.at(-1)).toMatchObject({ cost: 2, calls: 25 });
  });

  it('the by-card lines sort by spend and label an unresolved card honestly', () => {
    const lines = cardLines(
      [...ROWS, { card_id: 'gone', cost: 3, calls: 3, phase: 'setup', capability: 'qa' }],
      new Map([
        ['c1', 'Set up the workspace'],
        ['c2', 'Fix the login bug'],
        ['c3', 'Check the fix'],
      ]),
      PHASES,
    );
    expect(lines.map((l) => l.name)).toEqual([
      'Set up the workspace',
      'Fix the login bug',
      'A card that is no longer on the board',
      'Not attributed to a card',
      'Check the fix',
    ]);
    expect(lines[0]).toMatchObject({ phaseLabel: 'Setup', capability: 'Project management' });
  });

  it('an unresolved card is labelled by the BOARD’s state — never "no longer on the board" when the board is unreadable', () => {
    const names = new Map([['c1', 'Set up the workspace']]);
    const rows = [
      { card_id: 'c1', cost: 1, calls: 1, phase: 'setup' },
      { card_id: 'gone', cost: 2, calls: 2, phase: null },
    ];
    // A readable board: the card really is not on it any more. (Biggest spend first.)
    expect(cardLines(rows, names, PHASES, 'ok').map((l) => l.name)).toEqual([
      'A card that is no longer on the board',
      'Set up the workspace',
    ]);
    // Board unreadable: the name is UNKNOWN, not a claim that the card is gone.
    expect(cardLines(rows, names, PHASES, 'unavailable').map((l) => l.name)).toEqual([
      'Unknown — board unreadable',
      'Set up the workspace',
    ]);
    // No board at all: the project's own fact, not a read failure.
    expect(cardLines(rows, names, PHASES, 'no_board').map((l) => l.name)).toEqual([
      'Unknown — this project has no board',
      'Set up the workspace',
    ]);
    // An absent board state defaults to 'ok' WITH the annotation recorded: the card really is not
    // on the readable board. When the ANSWER carries no annotation at all (a pre-R6 backend), the
    // name is UNKNOWN — the page cannot say the card is gone.
    expect(cardLines(rows, names, PHASES).map((l) => l.name)[0]).toBe('A card that is no longer on the board');
    expect(cardLines(rows, names, PHASES, 'ok', false).map((l) => l.name)[0]).toBe(
      'Unknown — not recorded by this server',
    );
  });

  it('unannotatedWords names the CAUSE per board state, and null only when the board was read', () => {
    expect(unannotatedWords('unavailable')).toBe('Unknown — board unreadable');
    expect(unannotatedWords('no_board')).toBe('Unknown — this project has no board');
    expect(unannotatedWords('ok')).toBeNull();
    // An answer with no annotation at all (pre-R6): a null phase there is NOT the card's record.
    expect(unannotatedWords('ok', false)).toBe('Unknown — not recorded by this server');
  });
});

describe('the charts’ series', () => {
  it('a settled day, a provisional day, and a same-day merge', () => {
    expect(costDays(COSTS).map((d) => [d.day, d.settled, d.provisional])).toEqual([
      ['2026-10-23', 10, null],
      ['2026-10-24', 5, null],
      ['2026-10-25', null, 2.5],
    ]);
    const merged = costDays({ ...COSTS, provisional: { ...COSTS.provisional, since: '2026-10-24' } });
    expect(merged.at(-1)).toMatchObject({ day: '2026-10-24', settled: 5, provisional: 2.5, calls: 75 });
  });

  it('the burn is cumulative and includes provisional on its own day', () => {
    expect(burnSeries(COSTS).map((p) => [p.day, p.cumulative, p.includesProvisional])).toEqual([
      ['2026-10-23', 10, false],
      ['2026-10-24', 15, false],
      ['2026-10-25', 17.5, true],
    ]);
  });

  it('more than five groups fold into one Other segment (no repeated colour)', () => {
    const groups = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => ({
      key: k,
      label: k.toUpperCase(),
      cost: 10 - i,
      calls: 1,
      partial: false,
      share: null,
    }));
    const stack = stackGroups(groups);
    expect(stack).toHaveLength(5);
    expect(stack.at(-1)).toMatchObject({ key: '__other__', label: 'Other', cost: 6 + 5 });
  });

  it('a segment width is 0 when the total is unknown — a bar is never drawn from a lie', () => {
    const g = { key: 'a', label: 'A', cost: 5, calls: 1, partial: false, share: null };
    expect(segmentWidth(g, 10)).toBe(50);
    expect(segmentWidth(g, null)).toBe(0);
    expect(segmentWidth({ ...g, cost: null }, 10)).toBe(0);
  });
});

describe('provisionalTodayLine — today on the usage pages (C7): unknown is never $0', () => {
  const P = { cost_usd: '1.00', calls: 42, currency: 'USD', as_of: '2026-10-29T16:40:00Z' };

  it('reads the provisional amount, calls and as-of time', () => {
    expect(provisionalTodayLine(P)).toBe('Today so far (provisional): $1.00 · 42 model calls · as of 29 Oct 16:40 UTC');
  });

  it('billing unreadable (field null / absent) says unavailable, not $0.00', () => {
    for (const v of [null, undefined]) {
      expect(provisionalTodayLine(v)).toBe("Today's provisional spend is unavailable");
    }
  });

  it('a withheld amount (markup unknown) is unavailable but keeps the call count', () => {
    const line = provisionalTodayLine({ ...P, cost_usd: null });
    expect(line).toBe(
      "Today's provisional spend is unavailable (your workspace's pricing could not be read) · 42 model calls · as of 29 Oct 16:40 UTC",
    );
    expect(line).not.toContain('$');
  });

  it('an unavailable figure carries the reason in words; an unknown code adds nothing', () => {
    expect(provisionalTodayLine(null, 'billing_not_deployed')).toBe("Today's provisional spend is unavailable (not available yet)");
    expect(provisionalTodayLine(null, 'billing_unreachable')).toBe("Today's provisional spend is unavailable (billing could not be reached)");
    expect(provisionalTodayLine(null, 'no_active_tenant')).toBe("Today's provisional spend is unavailable (no active workspace)");
    expect(provisionalTodayLine(null, 'billing_malformed')).toBe("Today's provisional spend is unavailable (billing answered unreadably)");
    expect(provisionalTodayLine(null, 'something_new')).toBe("Today's provisional spend is unavailable");
  });

  it('since before the as-of day (rollup behind) says "Since <date>"; since = that day says "Today"', () => {
    expect(provisionalTodayLine({ ...P, since: '2026-10-27' })).toBe(
      'Since 27 Oct (provisional): $1.00 · 42 model calls · as of 29 Oct 16:40 UTC',
    );
    expect(provisionalTodayLine({ ...P, since: '2026-10-29' })).toBe(
      'Today so far (provisional): $1.00 · 42 model calls · as of 29 Oct 16:40 UTC',
    );
  });

  it('a genuine zero is a zero, and an unreadable stamp prints no time', () => {
    expect(provisionalTodayLine({ ...P, cost_usd: '0.00', calls: 1, as_of: 'garbage' })).toBe(
      'Today so far (provisional): $0.00 · 1 model call',
    );
  });
});
