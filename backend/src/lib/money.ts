// backend/src/lib/money.ts
//
// The ONE place fr turns an incurred cost into a billed cost.
//
// WHY THIS FILE EXISTS
// --------------------
// There used to be two copies of `applyMarkup` -- `routes/me/usage.ts:209` and
// `routes/me/licenses.ts:260` -- and the second carried a doc-comment claiming
// it "Mirrors routes/me/usage.ts::applyMarkup and services/billing.py::
// apply_markup so the licenses card agrees". Nothing enforced that claim, and
// MEASURED 2026-09-03 it was false: over 40,000 (cost, markup) pairs the TS and
// Python implementations disagreed on 2,199 of them -- 5.5% -- by one cent, in
// BOTH directions.
//
// billing-service is the authority: it computes what the tenant is actually
// charged. fr only DISPLAYS a billed figure (it never persists a charge), so
// the defect is a portal that can disagree with the invoice.
//
// ⚠️ PRODUCTION EXPOSURE, measured 2026-09-03 — and it is MUCH SMALLER than the
// 5.5% above, which is a property of my synthetic corpus, not of production.
// I am recording the correction rather than leaving the flattering number to
// stand on its own:
//   * `billing.tenant_config` has ZERO rows, so every tenant falls through to
//     `settings.default_markup_pct` = 30.0. Production has exactly ONE markup.
//   * At 30.0 the multiplier is `Decimal("1.3")` EXACTLY, so half-cent ties are
//     rare — the synthetic 5.5% came from spanning 25 different percentages.
//   * Over all 1375 real `billing_cost_daily` rows: 3 disagree (0.218%), across
//     3 tenants, each by one cent, each in fr's favour.
//   * At the AGGREGATED granularities fr actually renders (month-to-date,
//     per-month, per-tenant/service totals): ZERO disagreements today.
//
// So this is not "1 value in 18 is wrong on screen right now". It is: three
// per-day rollup rows are wrong, and the exposure is currently suppressed by an
// empty config table. The moment anyone sets a per-tenant markup through
// `PUT /api/admin/pricing/tenant-config/:tenantId` — 5%, 7%, 12.5% — the rate
// climbs back toward the synthetic figure. The fix is worth having for that
// reason and because agreeing with the authority is not optional for money; it
// is NOT worth overstating.
//
// Two causes, both from the old one-liner `(internal * (1 + pct/100)).toFixed(2)`:
//   1. IEEE-754 binary float vs Python's exact `Decimal` arithmetic.
//   2. `toFixed` rounds half away from zero; `Decimal.quantize` defaults to
//      ROUND_HALF_EVEN (banker's rounding).
// This implementation is exact integer arithmetic with ROUND_HALF_EVEN, so it
// agrees with billing-service on all 40,000 pairs. `tests/unit/lib/money.test.ts`
// pins that with a differential corpus; if billing-service ever changes its
// rounding, that test is what tells us.
//
// ⛔ `markupPct` IS REQUIRED, AND THAT IS THE POINT.
// The old signature was `(internalUsd: string, markupPct: number | null)` and
// returned the input unchanged for null. That one line is what let a metering
// outage bill a tenant AT COST: any failed markup read became `null`, and null
// silently meant "no markup" -- indistinguishable from a real zero-markup
// tenant. Python's `apply_markup(internal_usd, markup_pct: float)` has no null
// path at all; the TS signature was weaker than the contract it claimed to
// mirror. Callers must now decide what an unknown markup means AT THE CALL
// SITE, in the open, where a reader can see it.

/** Split a decimal numeral into (unscaled bigint, scale). Throws on garbage. */
function parseDecimal(s: string): { unscaled: bigint; scale: number } {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    // Money must never be guessed. Upstream serialises these from a Python
    // Decimal, so a non-numeral here is a contract break, not a value.
    throw new TypeError(`applyMarkup: not a decimal numeral: ${JSON.stringify(s)}`);
  }
  const [, sign, whole, frac = ''] = m;
  const digits = `${whole || '0'}${frac}`;
  return { unscaled: BigInt(sign === '-' ? `-${digits}` : digits), scale: frac.length };
}

/** Quantize unscaled/scale to 2 decimal places, ROUND_HALF_EVEN. */
function quantize2(unscaled: bigint, scale: number): string {
  const TARGET = 2;
  if (scale <= TARGET) {
    const scaled = unscaled * 10n ** BigInt(TARGET - scale);
    return format2(scaled);
  }
  const div = 10n ** BigInt(scale - TARGET);
  const neg = unscaled < 0n;
  const abs = neg ? -unscaled : unscaled;
  let q = abs / div;
  const rem = abs % div;
  const twice = rem * 2n;
  // Ties go to the EVEN quotient -- this is the half of the contract that
  // `toFixed` gets wrong, and it is why 5.5% of values used to differ.
  if (twice > div || (twice === div && q % 2n === 1n)) q += 1n;
  return format2(neg ? -q : q);
}

function format2(scaled: bigint): string {
  const neg = scaled < 0n;
  const abs = (neg ? -scaled : scaled).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/**
 * Billed (charged) cost from incurred cost and the tenant's markup percentage.
 *
 * Mirrors `billing_service/src/services/billing.py::apply_markup` EXACTLY,
 * including its `Decimal(str(1 + markup_pct / 100))` multiplier construction --
 * the float arithmetic in that expression is part of the contract, so it is
 * reproduced rather than "improved".
 *
 * @param internalUsd incurred cost as a decimal string (throws if not one)
 * @param markupPct   percentage; REQUIRED -- see the note at the top of this file
 */
export function applyMarkup(internalUsd: string, markupPct: number): string {
  if (!Number.isFinite(markupPct)) {
    throw new TypeError(`applyMarkup: markupPct must be finite, got ${markupPct}`);
  }
  const internal = parseDecimal(internalUsd);
  // String(1 + pct/100) reproduces Python's `str(1 + markup_pct / 100)`: both
  // emit the shortest representation that round-trips the same double.
  const multiplier = parseDecimal(String(1 + markupPct / 100));
  return quantize2(
    internal.unscaled * multiplier.unscaled,
    internal.scale + multiplier.scale,
  );
}
