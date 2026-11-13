import { describe, it, expect } from 'vitest';
import { pillTone } from './pillTone';

describe('pillTone', () => {
  it("maps backend 'warn' onto the Tag primitive's 'warning'", () => {
    // The whole reason this helper exists — the vocabularies differ by this one.
    expect(pillTone('warn')).toBe('warning');
  });

  it('passes through the tones that already match', () => {
    expect(pillTone('success')).toBe('success');
    expect(pillTone('danger')).toBe('danger');
    expect(pillTone('neutral')).toBe('neutral');
  });
});
