// src/lib/utils/decimal.ts
//
// Render a Postgres NUMERIC that arrived over the wire AS A STRING.
//
// Why this exists (measured on /admin/pricing, 2026-09-10): billing's
// provider_pricing rows are `Decimal` on the Python side and are passed through
// this stack verbatim — `ProviderPricingRow.input_per_1m_usd` and friends are
// typed `string | null` and documented "billing schema, passed through
// verbatim". Python's `str(Decimal)` is NOT always plain decimal notation: a
// NUMERIC(_, 8) zero stringifies as **`0E-8`**, and ~40 rows in the live
// pricing table rendered exactly that into the "Output $/1M" column. An
// operator reading `0E-8` where a rate belongs is being shown a serialisation
// artefact, not a price.
//
// Three rules, in this order, and each one is a bug that has actually shipped
// somewhere in this repo:
//
//  1. **Never round to a fixed scale.** `0.00100000` is a real rate. Two
//     decimal places turns it into `0.00`, which reads as free. Trailing zeros
//     are dropped; significant digits are not.
//  2. **Never fall back to a placeholder for something unparseable.** A value
//     this module cannot interpret is passed through VERBATIM so the operator
//     sees the bad data. Formatting is not sanitising: a formatter that
//     swallows garbage destroys the only evidence that garbage is stored.
//  3. **Absent is `—`, and only absent.** `null`/`undefined`/`''` are the
//     absent cases. `0` is a value and renders as `0`.
//
// Deliberately NOT locale-grouped. `Intl.NumberFormat` grouping depends on the
// runtime locale, so the same row would read `1,234.5` on one machine and
// `1.234,5` on another, and the tests would pin whichever locale CI happened to
// have. Rates here are small; correctness beats decoration.
//
// Exponent expansion is LEXICAL, never via `Number`: round-tripping
// `78.33333333` through a double and back re-introduces float noise into a
// value that arrived exact.

/** What an absent value renders as. Matches `formatDate` in the licences console. */
export const EM_DASH = '—';

/** Plain or exponent-notation decimal, optionally signed. */
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const EXPONENT_RE = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/;

/**
 * Expand exponent notation to plain decimal digits without going through a
 * double. `0E-8` → `0.00000000`, `1.5E+3` → `1500`, `2E-3` → `0.002`.
 * Returns the input unchanged if it is not exponent notation.
 */
export function expandExponent(s: string): string {
  const m = EXPONENT_RE.exec(s);
  if (!m) return s;
  const sign = m[1] === '-' ? '-' : '';
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  const exp = Number(m[4]);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) return `${sign}0.${'0'.repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`;
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/**
 * Drop trailing fractional zeros (and a bare trailing point). Integers are
 * untouched — `100` must not become `1`.
 */
export function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  if (trimmed === '' || trimmed === '-' || trimmed === '+') return '0';
  // `-0.00000000` is zero, not negative zero.
  if (/^[+-]?0$/.test(trimmed)) return '0';
  return trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
}

/**
 * Format a wire Decimal for display.
 *
 * - `null` / `undefined` / `''`  → `—`
 * - `'0E-8'`                     → `'0'`
 * - `'15.00000000'`              → `'15'`
 * - `'0.00100000'`               → `'0.001'`
 * - `'78.33333333'`              → `'78.33333333'` (never rounded)
 * - anything unparseable         → returned verbatim, so bad data stays visible
 */
export function formatDecimal(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  const s = String(value).trim();
  if (s === '') return EM_DASH;
  if (!NUMERIC_RE.test(s)) return s;
  return trimTrailingZeros(expandExponent(s));
}
