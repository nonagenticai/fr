// tests/unit/measure.test.ts
//
// Phase-7 T/I/OE compose-endpoint — pure aggregation coverage. We exercise the
// three exported pure helpers (inventory fold, throughput dedupe, constraint
// pick) plus the backend phase mirror. No DB / Planka I/O is touched.

import { describe, expect, test } from 'bun:test';

process.env.AUTH_BYPASS = 'true';

import {
  aggregateInventory,
  countThroughput,
  foldOperatingExpenseRollups,
  pickConstraint,
} from '../../src/routes/measure';
import { phaseFromListName, isBlocked } from '../../src/lib/phase';

describe('backend phase mirror', () => {
  test('maps canonical list names to phases (case-insensitive)', () => {
    expect(phaseFromListName('TODO')).toBe('READYING');
    expect(phaseFromListName('ready')).toBe('READYING');
    expect(phaseFromListName('DOING')).toBe('DOING');
    expect(phaseFromListName('QA')).toBe('INSPECTING');
    expect(phaseFromListName('Done')).toBe('PUBLISHING');
    expect(phaseFromListName('PUBLISHED')).toBe('PUBLISHING');
    expect(phaseFromListName('Backlog')).toBeNull();
    expect(phaseFromListName(null)).toBeNull();
  });

  test('isBlocked matches any list whose name contains BLOCK', () => {
    expect(isBlocked('BLOCKED')).toBe(true);
    expect(isBlocked('blocked / waiting')).toBe(true);
    expect(isBlocked('DOING')).toBe(false);
    expect(isBlocked(null)).toBe(false);
  });
});

describe('aggregateInventory', () => {
  test('buckets non-DONE phases, counts blocked + done separately', () => {
    const inv = aggregateInventory([
      { listName: 'TODO', count: 4, complete: true },
      { listName: 'READY', count: 2, complete: true }, // both READYING
      { listName: 'DOING', count: 3, complete: true },
      { listName: 'QA', count: 1, complete: true }, // INSPECTING
      { listName: 'DONE', count: 9, complete: true }, // PUBLISHING → done_current, NOT in total
      { listName: 'BLOCKED', count: 2, complete: true }, // side-flag
      { listName: 'Backlog', count: 7, complete: true }, // outside pipeline → ignored
    ]);
    expect(inv.by_phase).toEqual({ READYING: 6, DOING: 3, INSPECTING: 1 });
    expect(inv.blocked).toBe(2);
    expect(inv.done_current).toBe(9);
    expect(inv.total).toBe(10); // 6 + 3 + 1, excludes DONE + BLOCKED
  });

  // ⛔ A TRUNCATED LIST MUST NOT PRODUCE A CONFIDENT INVENTORY.
  //
  // Planka pages cards at 50, so a DOING list of 2,842 reaches this function as
  // `count: 50, complete: false`. Before `complete` existed the aggregate
  // published 50 as the WIP number with nothing saying it was a floor, and
  // `pickConstraint` then named the constraint from it.
  test('one truncated CONTRIBUTING list makes the whole inventory a lower bound', () => {
    const inv = aggregateInventory([
      { listName: 'TODO', count: 4, complete: true },
      { listName: 'DOING', count: 50, complete: false }, // capped at a page
    ]);
    expect(inv.by_phase.DOING).toBe(50);
    // ⭐ The load-bearing bit: the number is published AND flagged.
    expect(inv.complete).toBe(false);
  });

  // ⚠️ The NEGATIVE control, and it is not decoration: a flag that goes false
  // for any truncated list at all would mark every board partial for numbers it
  // never touched. A list outside the AA pipeline is DISCARDED by this
  // function, so it cannot make the published answer partial.
  test('a truncated list OUTSIDE the pipeline does NOT flag the inventory partial', () => {
    const inv = aggregateInventory([
      { listName: 'TODO', count: 4, complete: true },
      { listName: 'Backlog', count: 50, complete: false }, // phase === null → ignored
    ]);
    expect(inv.total).toBe(4);
    expect(inv.complete).toBe(true);
  });

  test('blocked and done lists DO contribute their truncation', () => {
    expect(
      aggregateInventory([{ listName: 'BLOCKED', count: 50, complete: false }]).complete,
    ).toBe(false);
    expect(
      aggregateInventory([{ listName: 'DONE', count: 50, complete: false }]).complete,
    ).toBe(false);
  });

  // ⛔ THE SECOND CAUSE. A list that could not be READ is not the same fact as
  // a list that was truncated — but both make the published inventory smaller
  // than the truth, and the caller needs to know that either way. The route
  // contributes `{count: 0, complete: false}` for a failed list precisely so it
  // adds no cards while still flipping the flag; a dropped row would have made
  // a partially-unreadable board publish an exact-looking number.
  test('a CONTRIBUTING list that read as zero-but-incomplete still flags the inventory', () => {
    const inv = aggregateInventory([
      { listName: 'DOING', count: 3, complete: true },
      { listName: 'QA', count: 0, complete: false }, // unreadable list
    ]);
    expect(inv.total).toBe(3); // the failure adds NO cards…
    expect(inv.complete).toBe(false); // …and is not silent about it
  });

  test('empty board yields all-zero inventory', () => {
    const inv = aggregateInventory([]);
    expect(inv.total).toBe(0);
    expect(inv.blocked).toBe(0);
    expect(inv.done_current).toBe(0);
  });
});

describe('countThroughput', () => {
  const win = Date.parse('2026-05-01T00:00:00.000Z');

  test('counts distinct cards moved to a PUBLISHING list within the window', () => {
    const n = countThroughput(
      [
        {
          id: 'a1',
          type: 'moveCard',
          cardId: 'c1',
          createdAt: '2026-05-10T00:00:00.000Z',
          data: { toList: { name: 'DONE' } },
        },
        // same card bounced out and back into DONE → counts once
        {
          id: 'a2',
          type: 'moveCard',
          cardId: 'c1',
          createdAt: '2026-05-11T00:00:00.000Z',
          data: { toList: { name: 'DONE' } },
        },
        {
          id: 'a3',
          type: 'moveCard',
          cardId: 'c2',
          createdAt: '2026-05-12T00:00:00.000Z',
          data: { toList: { name: 'PUBLISHED' } },
        },
      ],
      win,
    );
    expect(n).toBe(2); // c1 + c2
  });

  test('ignores moves before the window, non-moves, and moves to non-DONE lists', () => {
    const n = countThroughput(
      [
        {
          id: 'old',
          type: 'moveCard',
          cardId: 'c9',
          createdAt: '2026-04-01T00:00:00.000Z', // before window
          data: { toList: { name: 'DONE' } },
        },
        {
          id: 'wronglist',
          type: 'moveCard',
          cardId: 'c8',
          createdAt: '2026-05-15T00:00:00.000Z',
          data: { toList: { name: 'DOING' } }, // not PUBLISHING
        },
        {
          id: 'comment',
          type: 'createComment',
          cardId: 'c7',
          createdAt: '2026-05-15T00:00:00.000Z',
          data: { toList: { name: 'DONE' } },
        },
      ],
      win,
    );
    expect(n).toBe(0);
  });
});

describe('pickConstraint', () => {
  test('BLOCKED dominates as the constraint', () => {
    const c = pickConstraint({
      by_phase: { READYING: 5, DOING: 2, INSPECTING: 0 },
      blocked: 1,
      total: 7,
      done_current: 0,
      complete: true,
    });
    expect(c?.phase).toBeNull();
    expect(c?.wip).toBe(1);
    expect(c?.reason).toContain('BLOCKED');
  });

  test('otherwise the most-loaded WIP phase is the constraint', () => {
    const c = pickConstraint({
      by_phase: { READYING: 2, DOING: 9, INSPECTING: 3 },
      blocked: 0,
      total: 14,
      done_current: 5,
      complete: true,
    });
    expect(c?.phase).toBe('DOING');
    expect(c?.wip).toBe(9);
  });

  test('empty board has no constraint', () => {
    expect(
      pickConstraint({
        by_phase: { READYING: 0, DOING: 0, INSPECTING: 0 },
        blocked: 0,
        total: 0,
        done_current: 0,
        complete: true,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⛔ OPERATING-EXPENSE: A ZERO WE MEASURED IS NOT A ZERO WE INVENTED.
//
// `loadOperatingExpense` seeded `tokens = 0, cost_usd = 0` and the loop only
// ever OVERWROTE the seed, so a window with no `analytics_rollups` rows
// returned the seed and `/measure` rendered `$0.00 · 0 tokens` — with the same
// authority as a measured zero. That is the normal state of an fr whose
// metering counters have not landed: `workers/analytics-rollup.ts` writes
// nothing at all for a tick where Prometheus returned no series
// (`promSeries === 0`).
//
// The discriminator needs no extra query: `GROUP BY metric_name` emits a row
// for a metric only when that metric has rows, so ABSENT ⇒ unknown and
// PRESENT-summing-to-0 ⇒ a real zero. `loadOperatingExpense` returns this
// fold's result verbatim as the payload's `data.oe.{tokens,cost_usd}`.
// ---------------------------------------------------------------------------
describe('foldOperatingExpenseRollups', () => {
  // KILLED BY: restoring the `let cost_usd = 0` (or `tokens = 0`) seed.
  test('no rollup rows at all ⇒ both metrics UNKNOWN (null), never 0', () => {
    expect(foldOperatingExpenseRollups([])).toEqual({ tokens: null, cost_usd: null });
  });

  // The negative control, and it is not decoration: without it the case above
  // is satisfied by a fold that answers `null` for everything, and zero and
  // unknown collapse again in the other direction.
  // KILLED BY: replacing the assignment with `Number(r.total) || null`, which
  // launders a measured zero back into "we never measured".
  test('a row PRESENT summing to 0 is a genuine ZERO, not unknown', () => {
    const out = foldOperatingExpenseRollups([
      { metric: 'tokens', total: '0' },
      { metric: 'cost_usd', total: '0' },
    ]);
    expect(out).toEqual({ tokens: 0, cost_usd: 0 });
    // Stated explicitly: `toEqual` alone would also pass for `null` under a
    // loose matcher, and the whole point is that these are numbers.
    expect(out.cost_usd).not.toBeNull();
    expect(out.tokens).not.toBeNull();
  });

  // KILLED BY: collapsing both metrics onto ONE shared unknown flag — which
  // would report this known token count as unknown (or, in the other
  // direction, print a 0 for the cost nobody measured).
  test('the two metrics are unknown INDEPENDENTLY', () => {
    expect(foldOperatingExpenseRollups([{ metric: 'tokens', total: '12345' }])).toEqual({
      tokens: 12345,
      cost_usd: null,
    });
    expect(foldOperatingExpenseRollups([{ metric: 'cost_usd', total: '1.23' }])).toEqual({
      tokens: null,
      cost_usd: 1.23,
    });
  });

  test('a non-finite sum stays UNKNOWN rather than becoming 0', () => {
    // `Number(null)` is 0 and `Number('x')` is NaN; neither is a measurement,
    // and publishing 0 for either is the same lie by a shorter route.
    expect(foldOperatingExpenseRollups([{ metric: 'cost_usd', total: 'x' }]).cost_usd).toBeNull();
    expect(foldOperatingExpenseRollups([{ metric: 'tokens', total: null }]).tokens).toBeNull();
  });

  test('rows for other metrics cannot answer for these two', () => {
    expect(foldOperatingExpenseRollups([{ metric: 'requests', total: '99' }])).toEqual({
      tokens: null,
      cost_usd: null,
    });
  });
});
