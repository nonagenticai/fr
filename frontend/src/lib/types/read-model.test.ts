import { describe, it, expect } from 'vitest';
import { isAvailable, type Block } from './read-model';

const meta = { source: 'fr-db', fetched_at: '2026-07-08T00:00:00Z', available: true };

describe('isAvailable', () => {
  it('narrows an available block with non-null data', () => {
    const b: Block<number> = { data: 42, meta };
    expect(isAvailable(b)).toBe(true);
  });

  it('is false when the block is marked unavailable', () => {
    const b: Block<number> = { data: null, meta: { ...meta, available: false, error: 'boom' } };
    expect(isAvailable(b)).toBe(false);
  });

  it('is false when available is true but data is null (defensive)', () => {
    const b: Block<number> = { data: null, meta };
    expect(isAvailable(b)).toBe(false);
  });

  it('is false for null / undefined blocks', () => {
    expect(isAvailable(null)).toBe(false);
    expect(isAvailable(undefined)).toBe(false);
  });
});
