// Tests for the wire-Decimal formatter behind /admin/pricing's money columns.
//
// The anchor case is `0E-8`: Python's `str(Decimal)` form of a NUMERIC(_, 8)
// zero. ~40 live provider_pricing rows rendered that raw into the
// "Output $/1M" column before this formatter existed, so the first assertion
// below is the measured defect, verbatim.
//
// The other two properties are the ones a "just use toFixed(2)" rewrite would
// silently break, so they are pinned explicitly:
//   * a sub-cent rate must NOT round to `0.00` (that reads as free), and
//   * an unparseable value must survive VERBATIM (a formatter that swallows
//     garbage destroys the evidence that garbage is stored).

import { describe, it, expect } from 'vitest';
import { formatDecimal, expandExponent, trimTrailingZeros, EM_DASH } from './decimal';

describe('formatDecimal', () => {
  it('renders the Decimal zero exponent form as 0, not "0E-8"', () => {
    // The measured live value from /admin/pricing, "Output $/1M", deepgram.
    expect(formatDecimal('0E-8')).toBe('0');
    expect(formatDecimal('0E-10')).toBe('0');
    expect(formatDecimal('-0E-8')).toBe('0');
  });

  it('drops trailing zeros without rounding significant digits', () => {
    expect(formatDecimal('15.00000000')).toBe('15');
    expect(formatDecimal('100.00000000')).toBe('100');
    expect(formatDecimal('0.43500000')).toBe('0.435');
    // Never rounded: this is a rate, and 78.33 is a different rate.
    expect(formatDecimal('78.33333333')).toBe('78.33333333');
    expect(formatDecimal('0.06153846')).toBe('0.06153846');
  });

  it('does not round a sub-cent rate away to zero', () => {
    // A 2-decimal formatter turns this into "0.00", which reads as free.
    expect(formatDecimal('0.00100000')).toBe('0.001');
    expect(formatDecimal('0.00000001')).toBe('0.00000001');
  });

  it('renders absent values as an em-dash, but zero as zero', () => {
    expect(formatDecimal(null)).toBe(EM_DASH);
    expect(formatDecimal(undefined)).toBe(EM_DASH);
    expect(formatDecimal('')).toBe(EM_DASH);
    expect(formatDecimal('   ')).toBe(EM_DASH);
    expect(formatDecimal('0')).toBe('0');
    expect(formatDecimal(0)).toBe('0');
  });

  it('passes an unparseable value through verbatim rather than hiding it', () => {
    // Formatting is not sanitising. If billing ever hands us junk, the operator
    // must see the junk, not a placeholder that looks like a normal empty cell.
    expect(formatDecimal('n/a')).toBe('n/a');
    expect(formatDecimal('NaN')).toBe('NaN');
    expect(formatDecimal('1.2.3')).toBe('1.2.3');
    expect(formatDecimal('$5')).toBe('$5');
  });

  it('keeps negatives negative', () => {
    expect(formatDecimal('-2.50000000')).toBe('-2.5');
  });
});

describe('expandExponent', () => {
  it('expands without going through a double', () => {
    expect(expandExponent('0E-8')).toBe('0.00000000');
    expect(expandExponent('2E-3')).toBe('0.002');
    expect(expandExponent('1.5E+3')).toBe('1500');
    expect(expandExponent('1.234E2')).toBe('123.4');
  });

  it('leaves plain decimal notation untouched', () => {
    expect(expandExponent('78.33333333')).toBe('78.33333333');
    expect(expandExponent('0')).toBe('0');
  });
});

describe('trimTrailingZeros', () => {
  it('never truncates an integer', () => {
    expect(trimTrailingZeros('100')).toBe('100');
    expect(trimTrailingZeros('1000')).toBe('1000');
  });

  it('collapses an all-zero fraction to a single 0', () => {
    expect(trimTrailingZeros('0.00000000')).toBe('0');
    expect(trimTrailingZeros('-0.00000000')).toBe('0');
  });
});
