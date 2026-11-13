// PHASE 2 render helpers: every one of these decides whether a missing value
// can masquerade as a measured one, so each is pinned with its negative case.
import { describe, it, expect } from 'vitest';
import {
  boundedLabel,
  durationText,
  fidelityOf,
  modalKey,
  safePrUrl,
} from './logic';

describe('boundedLabel', () => {
  it('strips control chars, collapses whitespace, bounds length', () => {
    expect(boundedLabel('a\n\tb\u0000c')).toBe('a b c');
    expect(boundedLabel('y'.repeat(100), 10)).toBe(`${'y'.repeat(9)}…`);
    expect(boundedLabel(null)).toBe('not reported');
    expect(boundedLabel('   ', 10, '—')).toBe('—');
  });
  it('strips Unicode format + C1 controls: bidi override/isolate, zero-width, NEL', () => {
    expect(boundedLabel('evil\u202Eledom')).toBe('evil ledom');
    expect(boundedLabel('a\u2066b\u2069c')).toBe('a b c');
    expect(boundedLabel('z\u200Bw')).toBe('z w');
    expect(boundedLabel('n\u0085m')).toBe('n m');
  });
});

describe('safePrUrl', () => {
  it('links only https://github.com/<org>/<repo>/pull/<n>', () => {
    expect(safePrUrl('https://github.com/nonagenticai/fr/pull/12')).toBe('https://github.com/nonagenticai/fr/pull/12');
    expect(safePrUrl('javascript:alert(1)')).toBeNull();
    expect(safePrUrl('https://evil.example/nonagenticai/fr/pull/1')).toBeNull();
    expect(safePrUrl(42)).toBeNull();
  });
});

describe('fidelityOf / modalKey / durationText', () => {
  it('fidelity: all captured → captured; any reconstructed → proxy; none → null', () => {
    expect(fidelityOf(['captured', 'captured'])).toBe('captured');
    expect(fidelityOf(['captured', 'reconstructed'])).toBe('mixed');
    expect(fidelityOf(['reconstructed', null])).toBe('reconstructed');
    expect(fidelityOf([null, undefined])).toBeNull();
  });
  it('modal decision key; none recorded → null', () => {
    expect(modalKey(['pass', 'fail', 'pass'])).toBe('pass');
    expect(modalKey([null, undefined])).toBeNull();
  });
  it('durations; null is "no data", never 0s', () => {
    expect(durationText(79140)).toBe('21h 59m');
    expect(durationText(null)).toBe('no data');
  });
});
