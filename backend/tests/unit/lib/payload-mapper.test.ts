// tests/unit/lib/payload-mapper.test.ts
import { describe, expect, test } from 'bun:test';
import { compileMapper } from '../../../src/lib/payload-mapper';

describe('compileMapper', () => {
  test('compiles a simple scalar path', () => {
    const mapper = compileMapper({ title: '$.title' });
    expect(mapper({ title: 'Hello' })).toEqual({ title: 'Hello' });
  });

  test('returns undefined for missing scalar path', () => {
    const mapper = compileMapper({ x: '$.missing' });
    const result = mapper({ title: 'Hello' });
    expect(result['x']).toBeUndefined();
  });

  test('compiles an array path with [*]', () => {
    const mapper = compileMapper({ ids: '$.items[*].id' });
    const result = mapper({ items: [{ id: 1 }, { id: 2 }] });
    expect(result['ids']).toEqual([1, 2]);
  });

  test('compiles recursive descent path', () => {
    const mapper = compileMapper({ titles: '$..title' });
    const result = mapper({ a: { title: 'A' }, b: { title: 'B' } });
    expect(Array.isArray(result['titles'])).toBe(true);
    expect((result['titles'] as string[]).length).toBeGreaterThanOrEqual(2);
  });

  test('returns empty array for array path with no matches', () => {
    const mapper = compileMapper({ ids: '$.missing[*].id' });
    expect(mapper({})).toEqual({ ids: [] });
  });

  test('throws for filter expression [?(...)]', () => {
    expect(() => compileMapper({ x: '$.items[?(@.active)]' })).toThrow(/forbidden/);
  });

  test('throws for script expression [(...)]', () => {
    expect(() => compileMapper({ x: '$.items[(@.length-1)]' })).toThrow();
  });

  test('throws for path not starting with $', () => {
    expect(() => compileMapper({ x: 'items.foo' })).toThrow(/must start with/);
  });

  test('handles multiple keys in one config', () => {
    const mapper = compileMapper({ a: '$.x', b: '$.y' });
    expect(mapper({ x: 1, y: 2 })).toEqual({ a: 1, b: 2 });
  });

  test('handles nested path', () => {
    const mapper = compileMapper({ city: '$.address.city' });
    expect(mapper({ address: { city: 'Amsterdam' } })).toEqual({ city: 'Amsterdam' });
  });

  test('scalar path returns first element of multi-match', () => {
    const mapper = compileMapper({ first: '$.items[0].id' });
    expect(mapper({ items: [{ id: 'a' }, { id: 'b' }] })).toEqual({ first: 'a' });
  });

  test('handles $ alone (root path)', () => {
    const mapper = compileMapper({ root: '$' });
    const obj = { x: 1 };
    expect(mapper(obj)).toEqual({ root: obj });
  });
});
