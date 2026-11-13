// routes/(admin)/admin/(platform)/metering/page-helpers.ts
//
// Money cells for /admin/metering.
//
// ## Why this file exists rather than reusing `settings/usage/page-helpers.ts`
//
// `formatCostUsd` there returns `'$0.00'` for a non-numeric input, and that
// behaviour is PINNED by a test (`settings/usage/page.test.ts:27`) because
// /settings/usage feeds it fields that are already known-numeric. On
// /admin/metering the same collapse is a different claim: this page's whole
// subject is the DELTA between what we paid providers and what we billed
// tenants, so a `$0.00` here reads as "this window is break-even", which is a
// statement about money that an unparseable string has not earned.
//
// The idiom is the one `breakdownCostCell` / `budgetConsumption` already
// established next door: never invent a number — render `—` and say why.
//
// ⚠️ A genuine `'0'` / `'0.00'` from upstream is a MEASUREMENT and must keep
// rendering as a zero dollar amount. The defect is only the case where the
// input cannot be read at all. Collapsing the two is exactly what this
// replaces, so a helper that dashed every zero would be the same bug facing
// the other way.
//
// ⚠️ And the user-facing STRINGS below deliberately avoid printing the literal
// they warn about. A caption reading "not $0.00" renders the exact value a
// reader — and a test asserting that value is absent — scans for: a caption
// impersonating the thing it describes. Say "not an amount of zero" instead.

export type MoneyCell =
  | { kind: 'value'; text: string }
  | { kind: 'unknown'; text: string; title: string };

const DASH = '—';

/** True only for a string that parses to a finite number. */
function finiteOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * One dollar amount reported by the metering rollup.
 *
 * `null` / `undefined` / `''` / `'NaN'` / any unparseable string is NOT zero
 * dollars; it is an amount metering did not report.
 */
export function moneyCell(raw: unknown, what = 'This amount'): MoneyCell {
  const n = finiteOf(raw);
  if (n === null) {
    return {
      kind: 'unknown',
      text: DASH,
      title:
        `${what} was not reported as a number by the metering rollup ` +
        `(received ${describe(raw)}). This is missing data, not an amount of zero.`,
    };
  }
  return { kind: 'value', text: `$${n.toFixed(2)}` };
}

/**
 * The margin cell: billed minus incurred.
 *
 * ⛔ This used to be `if (!Number.isFinite(i) || !Number.isFinite(b)) return
 * '$0.00'` — so a window in which either side was unreadable rendered as a
 * measured break-even margin on a billing surface, indistinguishable from a
 * genuinely zero-margin window. A margin is a subtraction: it cannot be known
 * unless BOTH operands are known, and naming WHICH side is missing is what lets
 * an operator tell an upstream outage from a pricing mistake.
 */
export function marginCell(incurred: unknown, billed: unknown): MoneyCell {
  const i = finiteOf(incurred);
  const b = finiteOf(billed);
  if (i === null || b === null) {
    const missing =
      i === null && b === null
        ? 'neither the incurred nor the billed amount'
        : i === null
          ? 'the incurred (provider) amount'
          : 'the billed (tenant) amount';
    return {
      kind: 'unknown',
      text: DASH,
      title:
        `Margin cannot be computed: ${missing} was not reported as a number ` +
        `(incurred ${describe(incurred)}, billed ${describe(billed)}). ` +
        `Rendering zero here would claim this window broke even, which this ` +
        `data does not show.`,
    };
  }
  return { kind: 'value', text: `$${(b - i).toFixed(2)}` };
}

/** A short, safe rendering of an unusable input, for the tooltip. */
function describe(raw: unknown): string {
  if (raw === null) return 'null';
  if (raw === undefined) return 'nothing';
  if (typeof raw === 'string') return raw === '' ? 'an empty string' : `“${raw.slice(0, 32)}”`;
  return typeof raw;
}
