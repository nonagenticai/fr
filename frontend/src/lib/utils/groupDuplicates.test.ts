import { describe, expect, test } from 'vitest';
import { groupDuplicates, titleKey } from './groupDuplicates';

describe('groupDuplicates', () => {
  const rows = [
    { id: 'a', type: 'req', title: 'Use Postgres' },
    { id: 'b', type: 'req', title: 'use  postgres ' },
    { id: 'c', type: 'principle', title: 'Use Postgres' },
    { id: 'd', type: 'req', title: 'Other' },
    { id: 'e', type: 'req', title: 'Use Postgres' },
  ];

  test('collapses same type + title, keeps every member and the count', () => {
    const groups = groupDuplicates(rows, (r) => titleKey(r.title, r.type));
    expect(groups.map((g) => [g.first.id, g.count])).toEqual([
      ['a', 3],
      ['c', 1],
      ['d', 1],
    ]);
    expect(groups[0].items.map((r) => r.id)).toEqual(['a', 'b', 'e']);
  });

  test('never drops a row: member total equals input length', () => {
    const groups = groupDuplicates(rows, (r) => titleKey(r.title, r.type));
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(rows.length);
  });

  test('different types with the same title stay apart', () => {
    expect(titleKey('X', 'a')).not.toBe(titleKey('X', 'b'));
  });

  test('without a type, titles alone group', () => {
    const groups = groupDuplicates(rows, (r) => titleKey(r.title));
    expect(groups[0].count).toBe(4);
  });

  test('empty input yields no groups', () => {
    expect(groupDuplicates([], () => 'k')).toEqual([]);
  });
});
