// Pure colour-assignment tests. The whole point of the shared module is that
// the legend swatch (KagGraphExploreTab) and the canvas node fill
// (KagGraphExplorer) can't drift, so these lock the determinism + the
// type/community palette separation.

import { describe, it, expect } from 'vitest';
import {
  colorForType,
  colorForCommunity,
  TYPE_PALETTE,
  COMMUNITY_PALETTE,
} from './graph-colors';

describe('graph-colors', () => {
  it('maps a type to its SORTED-index palette slot (legend == canvas)', () => {
    const allTypes = ['Organisation', 'Person', 'Policy']; // already sorted
    expect(colorForType('Organisation', allTypes)).toBe(TYPE_PALETTE[0]);
    expect(colorForType('Person', allTypes)).toBe(TYPE_PALETTE[1]);
    expect(colorForType('Policy', allTypes)).toBe(TYPE_PALETTE[2]);
  });

  it('is deterministic — same (type, allTypes) always yields the same colour', () => {
    const allTypes = ['A', 'B', 'C'];
    expect(colorForType('B', allTypes)).toBe(colorForType('B', allTypes));
    expect(colorForType('B', allTypes)).toBe(TYPE_PALETTE[1]);
  });

  it('hashes types beyond the curated palette to a stable HSL colour', () => {
    const many = Array.from({ length: 15 }, (_, i) => `T${i}`);
    const c = colorForType('T14', many); // index 14 > palette length 10
    expect(c).toMatch(/^hsl\(/);
    expect(colorForType('T14', many)).toBe(c); // repeatable
  });

  it('returns a hashed colour for a type not present in allTypes', () => {
    expect(colorForType('Ghost', ['A', 'B'])).toMatch(/^hsl\(/);
  });

  it('colours communities from a palette DISJOINT from the type palette', () => {
    // No community colour may collide with any type colour, or "by theme" and
    // "by type" would be visually indistinguishable.
    const typeSet = new Set(TYPE_PALETTE);
    for (const c of COMMUNITY_PALETTE) expect(typeSet.has(c)).toBe(false);
    expect(colorForCommunity(0)).toBe(COMMUNITY_PALETTE[0]);
    // Wraps around the palette rather than running off the end.
    expect(colorForCommunity(COMMUNITY_PALETTE.length)).toBe(COMMUNITY_PALETTE[0]);
  });
});
