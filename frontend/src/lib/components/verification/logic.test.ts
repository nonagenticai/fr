import { describe, it, expect } from 'vitest';
import {
  arr,
  ciText,
  count,
  entries,
  fixed,
  pct,
  relAge,
  utc,
} from './logic';

describe('verification logic — a null is never a zero', () => {
  it('pct renders null as "no data", never 0%', () => {
    expect(pct(null)).toBe('no data');
    expect(pct(undefined)).toBe('no data');
    // control: a genuine zero IS zero
    expect(pct(0)).toBe('0.0%');
  });

  it('ciText: a null end is "CI n/a", never [0, 0]', () => {
    expect(ciText([null, null])).toBe('CI n/a');
    expect(ciText([0.1, 0.3])).toBe('95% CI [0.100, 0.300]');
  });

  it('utc/relAge render absolute UTC and relative age', () => {
    const now = Date.parse('2026-09-23T07:00:00Z');
    expect(utc('2026-09-22T09:01:00Z')).toBe('2026-09-22 09:01 UTC');
    expect(relAge('2026-09-22T09:01:00Z', now)).toBe('22h ago');
    expect(relAge(null, now)).toBe('unknown age');
  });
});

describe('null-safe formatters', () => {
  it('number formatters treat null / non-numbers as not measured, never 0', () => {
    expect(fixed(null, 3)).toBe('no data');
    expect(fixed(0.05, 3)).toBe('0.050');
    expect(count(null)).toBe('no data');
    expect(count(0)).toBe('0');
    expect(pct('0.5' as unknown as number)).toBe('no data');
    expect(ciText([0.1, null])).toBe('CI n/a');
    expect(arr(null)).toEqual([]);
    expect(entries(null)).toEqual([]);
  });
});

