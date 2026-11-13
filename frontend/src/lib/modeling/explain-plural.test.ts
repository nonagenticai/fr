// The prod defects of 2026-10-28 on the modeling pages: "1 relationships" and an
// "Imported changes" header that still said "ready to review" after Apply.
//
// MUTATIONS: make plural always add "s" → red; make importOutcome ignore the
// status → "applied" red.

import { describe, expect, it } from 'vitest';

import { importOutcome, plural, runVerdict } from './explain';

describe('plural', () => {
  it('says 1 relationship, 0 and 2 relationships', () => {
    expect(plural(1, 'relationship')).toBe('1 relationship');
    expect(plural(0, 'relationship')).toBe('0 relationships');
    expect(plural(2, 'view')).toBe('2 views');
  });
  it('the incomplete-run explanation counts items in words', () => {
    const v = runVerdict({ status: 'incomplete', clean: false, counts: {}, examined: { element: 0 }, expected: { element: 1 } });
    expect(v.explanation).not.toContain('1 items');
  });
});

describe('importOutcome', () => {
  it('follows the change set status', () => {
    expect(importOutcome(false, 'proposed')).toBe('are ready to review.');
    expect(importOutcome(false, 'applied')).toBe('have been applied to the model.');
    expect(importOutcome(true, 'applied')).toBe('and its contents were added.');
    expect(importOutcome(false, 'rejected')).toContain('rejected');
    expect(importOutcome(false, 'applied')).not.toContain('ready to review');
  });
});
