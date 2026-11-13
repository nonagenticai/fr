// displayName.test.ts
//
// ⚠️ THIS FILE IS NOT A GATE ON ANY CALL SITE. It pins the primitive only. A
// component that goes back to rendering `{x.name}` raw still passes every
// assertion here — which is exactly why each fixed `<option>` has its own
// mount test next to it. Helper-tested + wiring-untested is a gate that cannot
// fail.
//
// What it DOES pin:
//   1. all four blank shapes (null, undefined, '', '   ') fall through;
//   2. a real name wins and the fallback is NOT shown (the positive control —
//      without it, `() => fallback` would pass everything above);
//   3. agreement, case for case, with the asset-workspace's `rowFieldText`
//      chain, so the app cannot acquire two different notions of "blank".

import { describe, it, expect } from 'vitest';
import { displayName } from './displayName';
import { rowFieldText } from '$lib/asset-workspace/manifest';

const ID = 'p-1';

/** Every blank shape a `text NOT NULL` column plus an untrimmed API can produce. */
const BLANKS: Array<[label: string, value: unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ["empty string — the case `?? id` misses", ''],
  ["whitespace-only — the case `|| id` catches but `?? id` does not", '   '],
  ['tab + newline only', '\t\n'],
];

describe('displayName — blank names fall through to the fallback', () => {
  for (const [label, value] of BLANKS) {
    it(`${label} → the fallback`, () => {
      expect(displayName(value, ID)).toBe(ID);
    });
  }

  it('POSITIVE CONTROL — a real name wins and the fallback is not shown', () => {
    expect(displayName('Apollo', ID)).toBe('Apollo');
    expect(displayName('Apollo', ID)).not.toBe(ID);
  });

  it('a padded real name is trimmed, not rejected', () => {
    expect(displayName('  Apollo  ', ID)).toBe('Apollo');
  });

  it('a non-string truthy value is stringified rather than discarded', () => {
    expect(displayName(42, ID)).toBe('42');
  });

  it('`0` is a name, not a blank — `||` on the raw value would lose it', () => {
    // The reason this function tests the TRIMMED STRING rather than the value's
    // truthiness: `0` and `false` are falsy but render perfectly well.
    expect(displayName(0, ID)).toBe('0');
    expect(displayName(false, ID)).toBe('false');
  });
});

describe('displayName agrees with the asset-workspace `rowFieldText` chain', () => {
  // `rowFieldText(row, field) || id` is the sanctioned expression in
  // AssetList.svelte / AssetScopePanel.svelte. The two implementations are
  // deliberately independent (utils/ must not import a feature module), so
  // this is what keeps them from diverging.
  const CASES: unknown[] = [null, undefined, '', '   ', '\t\n', 'Apollo', '  Apollo  ', 0, 42];

  for (const value of CASES) {
    it(`same verdict for ${JSON.stringify(value)}`, () => {
      expect(displayName(value, ID)).toBe(rowFieldText({ name: value }, 'name') || ID);
    });
  }
});
