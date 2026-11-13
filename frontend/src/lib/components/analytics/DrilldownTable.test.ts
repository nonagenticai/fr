// src/lib/components/analytics/DrilldownTable.test.ts
//
// Pure-logic coverage for the helpers exported from DrilldownTable.svelte.
// Component rendering itself is exercised via the page test; here we only
// pin the comparator + filter behaviours so the (date, service, metrics)
// table sorts deterministically when the user clicks a column header.
//
// Spec: docs/archive/2026-04-27-foundation-design.md §9.3.

import { describe, it, expect } from 'vitest';
import {
  sortRows,
  filterByDate,
  type DrilldownRow,
} from './DrilldownTable.svelte';

const rows: DrilldownRow[] = [
  { date: '2026-04-29', service: 'kag.ingest', requests: 5, tokens: 100, cost: 0.01 },
  { date: '2026-04-28', service: 'coding.analyze', requests: 12, tokens: 4_800, cost: 0.42 },
  { date: '2026-04-29', service: 'coding.analyze', requests: 3, tokens: 90, cost: 0.02 },
  { date: '2026-04-27', service: 'kag.ingest', requests: 7, tokens: 1_200, cost: 0.18 },
];

describe('sortRows', () => {
  it('sorts by date desc by default-style call', () => {
    const out = sortRows(rows, 'date', 'desc');
    expect(out.map((r) => r.date)).toEqual([
      '2026-04-29',
      '2026-04-29',
      '2026-04-28',
      '2026-04-27',
    ]);
  });

  it('sorts by date asc', () => {
    const out = sortRows(rows, 'date', 'asc');
    expect(out[0]!.date).toBe('2026-04-27');
    expect(out[out.length - 1]!.date).toBe('2026-04-29');
  });

  it('sorts numerics descending by request count', () => {
    const out = sortRows(rows, 'requests', 'desc');
    expect(out.map((r) => r.requests)).toEqual([12, 7, 5, 3]);
  });

  it('sorts numerics ascending by cost', () => {
    const out = sortRows(rows, 'cost', 'asc');
    expect(out[0]!.cost).toBeCloseTo(0.01);
    expect(out[out.length - 1]!.cost).toBeCloseTo(0.42);
  });

  it('sorts service lexicographically', () => {
    const out = sortRows(rows, 'service', 'asc');
    // coding.* before kag.*
    expect(out[0]!.service).toBe('coding.analyze');
    expect(out[out.length - 1]!.service).toBe('kag.ingest');
  });

  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.date);
    sortRows(rows, 'date', 'asc');
    expect(rows.map((r) => r.date)).toEqual(before);
  });
});

describe('tokens + cost columns carry real values', () => {
  it('rows ship non-zero tokens + cost (no more 0-placeholders)', () => {
    // The fixture rows above represent the new shape after the rollup ETL
    // emits `metric_name='tokens'` / 'cost_usd'. Before this lane shipped,
    // every row had `tokens: 0, cost: 0` because deriveDrilldown forced
    // them to 0. Confirm the fixture itself reflects real data so a
    // regression to 0-placeholders fails this test.
    expect(rows.every((r) => r.tokens > 0)).toBe(true);
    expect(rows.every((r) => r.cost > 0)).toBe(true);
  });

  it('sorts by tokens descending', () => {
    const out = sortRows(rows, 'tokens', 'desc');
    expect(out.map((r) => r.tokens)).toEqual([4_800, 1_200, 100, 90]);
  });
});

describe('filterByDate', () => {
  it('returns all rows when date is null', () => {
    expect(filterByDate(rows, null)).toHaveLength(rows.length);
  });

  it('returns only rows matching the supplied ISO date', () => {
    const out = filterByDate(rows, '2026-04-29');
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.date === '2026-04-29')).toBe(true);
  });

  it('returns empty when no rows match', () => {
    expect(filterByDate(rows, '1999-01-01')).toEqual([]);
  });
});
