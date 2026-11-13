// cardTypeColors.test.ts — the group is the card type's RM capability; its
// colour is a deterministic function of the name over the token palette.
import { describe, it, expect } from 'vitest';
import {
  GROUP_PALETTE,
  UNKNOWN_GROUP_COLORS,
  getGroupColors,
  groupLabel,
  legendGroups,
} from './cardTypeColors';

describe('cardTypeColors', () => {
  it('is deterministic: the same capability name always gets the same colour', () => {
    expect(getGroupColors('development')).toEqual(getGroupColors('development'));
    expect(getGroupColors('requirements_management').bgClass).toBe(
      getGroupColors('requirements_management').bgClass,
    );
  });

  it('every colour is a design token from the palette', () => {
    for (const name of ['development', 'testing', 'bdd_tdd', 'kaizen', 'any_new_capability']) {
      const c = getGroupColors(name);
      expect(GROUP_PALETTE.map((p) => p.bgClass)).toContain(c.bgClass);
      expect(c.bgClass).toMatch(/^bg-\[var\(--color-[a-z-]+\)\]$/);
    }
  });

  it('spreads names over the palette (not one colour for all)', () => {
    const names = ['program_management', 'project_management', 'change_management', 'research', 'analysis',
      'architecture', 'design', 'testing', 'bdd_tdd', 'development', 'refactoring'];
    expect(new Set(names.map((n) => getGroupColors(n).bgClass)).size).toBeGreaterThan(3);
  });

  it('labels a capability name for humans', () => {
    expect(groupLabel('requirements_management')).toBe('Requirements management');
    expect(getGroupColors('development').label).toBe('Development');
  });

  it('null / empty is the Unclassified sentinel', () => {
    expect(getGroupColors(null)).toBe(UNKNOWN_GROUP_COLORS);
    expect(getGroupColors(undefined)).toBe(UNKNOWN_GROUP_COLORS);
    expect(getGroupColors('')).toBe(UNKNOWN_GROUP_COLORS);
  });

  it('legendGroups = the distinct capabilities on the board, sorted', () => {
    const g = legendGroups([{ card_group: 'testing' }, { card_group: null }, { card_group: 'design' }, { card_group: 'testing' }]);
    expect(g.map((x) => x.key)).toEqual(['design', 'testing']);
    expect(g[0]!.bgClass).toBe(getGroupColors('design').bgClass);
  });
});
