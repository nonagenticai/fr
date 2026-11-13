// cost.ts — the pure half of the project Cost page (R6, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3/§5;
// cockpit C7 / R-CK3 / R-CK6). No fetching, no Svelte: every number the page prints is built here
// and unit-tested.
//
// ⛔ NULL IS "UNKNOWN", NEVER ZERO. Billing returns null amounts when the tenant's markup cannot be
// established (`cost_basis: 'unavailable'`); every formatter here answers null/absent rather than
// "$0.00", and a group's total is marked `partial` when any row it covers has no amount.
//
// ⛔ A PHASE IS THE ONE THE CARD RECORDED. Grouping never infers a phase from a date: the backend
// annotates each by_card row with the card's own `phase` field (or Closure for a closure card).

import type { CockpitProjectCosts, CostBoardState, CostCardRow } from '$lib/types/cockpit';
import { moneyWords } from '$lib/projects/cockpit-status';
import { humanize } from '$lib/components/registers/registers';

/** The phase filter value that keeps every phase. */
export const ALL_PHASES = 'all';

export interface CostPhase {
  name: string;
  label: string;
}

/**
 * The phase the page shows: the user's pick, else the current phase, else every phase.
 * Same rule as the Board's phase filter (`boardFilterShown`), minus the card-only buckets.
 */
export function costPhaseShown(
  phases: readonly CostPhase[],
  current: string | null,
  chosen: string | null,
): string {
  if (chosen === ALL_PHASES) return ALL_PHASES;
  if (chosen && phases.some((p) => p.name === chosen)) return chosen;
  if (current && phases.some((p) => p.name === current)) return current;
  return ALL_PHASES;
}

/** The rows the filter keeps: every row for "All phases", else the rows whose card recorded that phase. */
export function rowsInPhase(rows: readonly CostCardRow[], phase: string): CostCardRow[] {
  return phase === ALL_PHASES ? [...rows] : rows.filter((r) => r.phase === phase);
}

// ── The header line ─────────────────────────────────────────────────────────

/**
 * The confirmed Cost summary line (session lead, R0 mock): "$29.78 total (282 model calls) ·
 * [budget not set]", or "… · of $50.00 budget" when a budget is set. Never invents a $0: when the
 * amounts are unavailable it says so instead of formatting one.
 */
export function spendSummary(
  costs: Pick<CockpitProjectCosts, 'totals'>,
  budget: number | null,
  currency: string,
  budgetKnown = true,
): string {
  return spendLine(costs.totals.cost, costs.totals.calls, budget, currency, budgetKnown);
}

/**
 * The same line from the status header's figures (`total`, `calls`) — ONE format everywhere.
 *
 * `budgetKnown` distinguishes the TWO reasons a budget can be absent (R6): `true` (the default, and
 * what an older backend means) ⇒ no budget is set; `false` ⇒ RM could not be read, so the budget is
 * UNKNOWN and the line says so instead of claiming the project has none.
 */
export function spendLine(
  total: number | null,
  calls: number,
  budget: number | null,
  currency: string,
  budgetKnown = true,
): string {
  const callsWords = `${calls.toLocaleString('en-US')} model call${calls === 1 ? '' : 's'}`;
  const money = moneyWords(total, currency);
  const budgetWords = budget === null || !Number.isFinite(budget) ? null : moneyWords(budget, currency);
  const noBudget = budgetKnown ? '[budget not set]' : '[budget unavailable]';
  if (!money) return `Spend unavailable (${callsWords})${budgetWords ? ` · of ${budgetWords} budget` : ` · ${noBudget}`}`;
  return budgetWords
    ? `${money} total (${callsWords}) · of ${budgetWords} budget`
    : `${money} total (${callsWords}) · ${noBudget}`;
}

/**
 * The phase-scoped line: "$12.00 in this phase (40 model calls)". Spend whose card recorded no phase
 * is outside every phase, so a filtered view would otherwise read "$0.00 in Execution" while the
 * project has spend; `unphased` discloses it: "… · $3.00 not tied to a phase (12 model calls)".
 * `unphasedLabel` replaces "not tied to a phase" when the reason is unknown (older backend).
 */
export function phaseSummary(
  rows: readonly CostCardRow[],
  phaseLabel: string,
  currency: string,
  unphased: readonly CostCardRow[] = [],
  unphasedLabel = 'not tied to a phase',
): string {
  const { cost, calls, partial } = sumRows(rows);
  const callsWords = `${calls.toLocaleString('en-US')} model call${calls === 1 ? '' : 's'}`;
  const money = cost === null ? null : moneyWords(cost, currency);
  const line = money
    ? `${money}${partial ? ' (a floor; some amounts unavailable)' : ''} in ${phaseLabel} (${callsWords})`
    : `Spend in ${phaseLabel} unavailable (${callsWords})`;
  if (unphased.length === 0) return line;
  const u = sumRows(unphased);
  const uCalls = `${u.calls.toLocaleString('en-US')} model call${u.calls === 1 ? '' : 's'}`;
  const uMoney = u.cost === null ? 'spend unavailable' : `${moneyWords(u.cost, currency)}${u.partial ? ' (a floor)' : ''}`;
  return `${line} · ${uMoney} ${unphasedLabel} (${uCalls})`;
}

/**
 * "As of 25 Oct 13:03 UTC" — the billing read time, in UTC as the R0 mock shows it. null when the
 * stamp is unreadable (the page then prints nothing rather than a fabricated time).
 */
export function asOfWords(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `As of ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** What `provisionalTodayLine` reads: the backend's `today_provisional` (or its absence). */
export interface ProvisionalToday {
  cost_usd: string | null;
  calls: number;
  currency: string;
  as_of: string;
  /** First day (YYYY-MM-DD) the figure covers; before as_of's day when the rollup is behind. */
  since?: string | null;
}

/** `today_provisional_unavailable_reason` in words. Unknown codes add nothing (never a raw code). */
const PROVISIONAL_REASON_WORDS: Record<string, string> = {
  billing_not_deployed: 'not available yet',
  billing_unreachable: 'billing could not be reached',
  no_active_tenant: 'no active workspace',
  billing_malformed: 'billing answered unreadably',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The usage pages' one-line provisional figure (cockpit C7): billing's not-yet-rolled-up spend,
 * "Today so far (provisional): $1.00 · 42 model calls · as of 29 Oct 16:40 UTC". When the rollup is
 * behind (`since` is before the as-of day) the figure covers more than today and says so:
 * "Since 27 Oct (provisional): …". A missing figure (billing unreadable, or the markup unknown so the
 * amount is withheld) says it is unavailable, with the backend's reason in words — never "$0.00",
 * which is exactly what the settled rollup reads until tonight.
 */
export function provisionalTodayLine(
  p: ProvisionalToday | null | undefined,
  unavailableReason?: string | null,
): string {
  const why = unavailableReason ? PROVISIONAL_REASON_WORDS[unavailableReason] : undefined;
  if (!p) return `Today's provisional spend is unavailable${why ? ` (${why})` : ''}`;
  const asOf = asOfWords(p.as_of);
  const tail = [
    `${p.calls.toLocaleString('en-US')} model call${p.calls === 1 ? '' : 's'}`,
    asOf ? asOf.charAt(0).toLowerCase() + asOf.slice(1) : null,
  ].filter((x): x is string => x !== null);
  const n = p.cost_usd === null ? NaN : Number.parseFloat(p.cost_usd);
  const money = Number.isFinite(n) ? moneyWords(n, p.currency) : null;
  // A present figure with no amount = the markup is unknown, so the billed amount is withheld.
  if (!money) return ["Today's provisional spend is unavailable (your workspace's pricing could not be read)", ...tail].join(' · ');
  const asOfDay = Number.isNaN(Date.parse(p.as_of)) ? null : new Date(p.as_of).toISOString().slice(0, 10);
  const since = p.since && /^\d{4}-\d{2}-\d{2}$/.test(p.since) ? p.since : null;
  const label =
    since && asOfDay && since < asOfDay
      ? `Since ${Number(since.slice(8, 10))} ${MONTHS[Number(since.slice(5, 7)) - 1]} (provisional)`
      : 'Today so far (provisional)';
  return [`${label}: ${money}`, ...tail].join(' · ');
}

/** What the amounts ARE, in words. null for an unreadable pricing basis (no amount is shown then). */
export function basisWords(costBasis: CockpitProjectCosts['cost_basis']): string | null {
  if (costBasis === 'billed') return 'Amounts are what your workspace is charged.';
  if (costBasis === 'incurred') return 'Amounts are internal cost, before your provider’s markup.';
  return null;
}

// ── Sums and groups ─────────────────────────────────────────────────────────

export interface CostSum {
  cost: number | null;
  calls: number;
  /** True when at least one covered row has no amount: `cost` is then a floor, never a total. */
  partial: boolean;
}

export function sumRows(rows: readonly CostCardRow[]): CostSum {
  let cost = 0;
  let partial = false;
  let calls = 0;
  for (const r of rows) {
    calls += Number.isFinite(r.calls) ? r.calls : 0;
    if (typeof r.cost === 'number' && Number.isFinite(r.cost)) cost += r.cost;
    else partial = true;
  }
  return { cost: partial && cost === 0 ? null : cost, calls, partial };
}

export interface CostGroup {
  key: string;
  label: string;
  cost: number | null;
  calls: number;
  partial: boolean;
  /** Share of the grouped total, 0–100; null when the total is unknown. */
  share: number | null;
}

function groupRows(
  rows: readonly CostCardRow[],
  keyOf: (r: CostCardRow) => string | null,
  labelOf: (key: string | null) => string,
  order?: (a: string | null, b: string | null) => number,
): CostGroup[] {
  const acc = new Map<string | null, CostCardRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    acc.set(k, [...(acc.get(k) ?? []), r]);
  }
  const total = sumRows(rows).cost;
  const entries = [...acc.entries()];
  if (order) entries.sort((a, b) => order(a[0], b[0]));
  return entries.map(([k, list]) => {
    const { cost, calls, partial } = sumRows(list);
    return {
      key: k ?? '__none__',
      label: labelOf(k),
      cost,
      calls,
      partial,
      share: cost !== null && total !== null && total > 0 ? (cost / total) * 100 : null,
    };
  });
}

/**
 * Spend by PHASE, in the project's phase order, then "Not tied to a phase". A phase name no longer
 * in the project's phase list is still shown (as written, made readable) — never dropped.
 */
export function groupByPhase(rows: readonly CostCardRow[], phases: readonly CostPhase[]): CostGroup[] {
  const order = new Map(phases.map((p, i) => [p.name, i] as const));
  const label = new Map(phases.map((p) => [p.name, p.label] as const));
  return groupRows(
    rows,
    (r) => r.phase ?? null,
    (k) => (k === null ? 'Not tied to a phase' : (label.get(k) ?? humanize(k))),
    (a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      const ia = order.get(a) ?? Number.MAX_SAFE_INTEGER;
      const ib = order.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ia - ib || a.localeCompare(b);
    },
  );
}

/** Spend by CAPABILITY (RM's name for the card's type), then a bucket for rows no capability names. */
export function groupByCapability(rows: readonly CostCardRow[]): CostGroup[] {
  return groupRows(
    rows,
    (r) => r.capability ?? null,
    (k) => (k === null ? 'No capability recorded' : humanize(k)),
    (a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    },
  );
}

export interface CostCardLine {
  key: string;
  cardId: string | null;
  name: string;
  phaseLabel: string | null;
  capability: string | null;
  cost: number | null;
  calls: number;
  partial: boolean;
  /** Phase + capability share the row's recorded values; null means "not recorded", never a guess. */
  phase: string | null;
}

/**
 * What an unannotated row says, by the CAUSE — never "not recorded" as if the cards said so.
 * null ⇒ the board was readable AND the answer carries the annotation, so a null phase/capability
 * IS the card's own record.
 *
 * Four different facts must not share a sentence: the board could not be read (unknown), the
 * project has no board at all (a fact — archived projects lose `planka_board_id`), the ANSWER
 * carries no annotation at all (a pre-R6 backend: it never recorded a phase, so the page cannot say
 * what the board records), or the board was read and the card genuinely records nothing.
 *
 * `annotationRecorded` is whether the rows carry the `phase` field — the same guard the Plan page
 * uses; it only matters when the board state reads 'ok'.
 */
export function unannotatedWords(boardState: CostBoardState, annotationRecorded = true): string | null {
  if (boardState === 'unavailable') return 'Unknown — board unreadable';
  if (boardState === 'no_board') return 'Unknown — this project has no board';
  if (!annotationRecorded) return 'Unknown — not recorded by this server';
  return null;
}

/**
 * One line per card (biggest spend first), for the by-card table. A card id the readable board no
 * longer carries is kept — the spend is real — and labelled honestly; when the board was not
 * readable (or does not exist, or the answer carries no annotation at all) the label names THAT
 * cause instead of claiming the card is gone.
 */
export function cardLines(
  rows: readonly CostCardRow[],
  cardNames: ReadonlyMap<string, string>,
  phases: readonly CostPhase[],
  boardState: CostBoardState = 'ok',
  annotationRecorded = true,
): CostCardLine[] {
  const phaseLabel = new Map(phases.map((p) => [p.name, p.label] as const));
  const unresolvedName =
    unannotatedWords(boardState, annotationRecorded) ?? 'A card that is no longer on the board';
  const acc = new Map<string, CostCardRow[]>();
  for (const r of rows) {
    const k = r.card_id ?? '__none__';
    acc.set(k, [...(acc.get(k) ?? []), r]);
  }
  const lines = [...acc.entries()].map(([k, list]): CostCardLine => {
    const first = list[0]!;
    const { cost, calls, partial } = sumRows(list);
    return {
      key: k,
      cardId: first.card_id,
      name:
        first.card_id === null
          ? 'Not attributed to a card'
          : (cardNames.get(first.card_id) ?? unresolvedName),
      phase: first.phase ?? null,
      phaseLabel: first.phase ? (phaseLabel.get(first.phase) ?? humanize(first.phase)) : null,
      capability: first.capability ? humanize(first.capability) : null,
      cost,
      calls,
      partial,
    };
  });
  return lines.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.calls - a.calls);
}

// ── Charts ──────────────────────────────────────────────────────────────────

export interface CostDay {
  day: string;
  settled: number | null;
  provisional: number | null;
  calls: number;
}

/**
 * The settled/provisional series: one row per day, keeping settled and same-day provisional
 * separate. Costs the pricing could not establish are null (a gap), never 0.
 */
export function costDays(costs: Pick<CockpitProjectCosts, 'settled' | 'provisional'>): CostDay[] {
  const days = new Map<string, CostDay>();
  for (const d of costs.settled) {
    const cur = days.get(d.day) ?? { day: d.day, settled: null, provisional: null, calls: 0 };
    days.set(d.day, { ...cur, settled: d.cost, calls: cur.calls + d.calls });
  }
  const p = costs.provisional;
  if (p.since) {
    const cur = days.get(p.since) ?? { day: p.since, settled: null, provisional: null, calls: 0 };
    days.set(p.since, { ...cur, provisional: p.cost, calls: cur.calls + p.calls });
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface BurnPoint {
  day: string;
  /** Settled spend through this day, plus the provisional figure on the provisional day. */
  cumulative: number;
  /** True on the point carrying today's provisional spend (not yet rolled up). */
  includesProvisional: boolean;
}

/**
 * The burn series: cumulative spend per day. Only meaningful when every amount is known — the
 * caller renders the chart only when `cost_basis !== 'unavailable'` (a cumulative line through
 * unknowns would be a fabricated total).
 */
export function burnSeries(costs: Pick<CockpitProjectCosts, 'settled' | 'provisional'>): BurnPoint[] {
  let running = 0;
  const out: BurnPoint[] = [];
  for (const d of costDays(costs)) {
    if (typeof d.settled === 'number' && Number.isFinite(d.settled)) running += d.settled;
    let includesProvisional = false;
    if (typeof d.provisional === 'number' && Number.isFinite(d.provisional)) {
      running += d.provisional;
      includesProvisional = true;
    }
    out.push({ day: d.day, cumulative: Math.round(running * 100) / 100, includesProvisional });
  }
  return out;
}

/** The most groups a stacked bar shows; the rest fold into one "Other" segment (never a repeated colour). */
export const STACK_MAX = 5;

/** Fold all but the largest `STACK_MAX - 1` groups into an "Other" group (kept when it has spend). */
export function stackGroups(groups: readonly CostGroup[]): CostGroup[] {
  if (groups.length <= STACK_MAX) return [...groups];
  const withCost = [...groups].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));
  const keep = withCost.slice(0, STACK_MAX - 1);
  const rest = groups.filter((g) => !keep.some((k) => k.key === g.key));
  const cost = rest.reduce<number | null>((acc, g) => (g.cost === null || acc === null ? null : acc + g.cost), 0);
  const calls = rest.reduce((acc, g) => acc + g.calls, 0);
  const partial = rest.some((g) => g.partial);
  const total = groups.reduce<number | null>((acc, g) => (g.cost === null || acc === null ? null : acc + g.cost), 0);
  const others: CostGroup = {
    key: '__other__',
    label: 'Other',
    cost,
    calls,
    partial,
    share: cost !== null && total !== null && total > 0 ? (cost / total) * 100 : null,
  };
  // Keep the input order (phase order) for what is left, with "Other" last.
  return [...groups.filter((g) => keep.some((k) => k.key === g.key)), others];
}

/** A segment's width (% of the bar) — 0 when the total is unknown, so the bar is not drawn from a lie. */
export function segmentWidth(group: CostGroup, total: number | null): number {
  if (group.cost === null || total === null || total <= 0) return 0;
  return Math.max(0, Math.min(100, (group.cost / total) * 100));
}

/** The colour token per stacked segment, by index. ONE palette, six distinct tokens. */
export const STACK_COLORS: readonly string[] = [
  'var(--color-accent)',
  'var(--color-info)',
  'var(--color-warning)',
  'var(--color-success)',
  'var(--color-secondary)',
  'var(--color-text-muted)',
];

export function stackColor(i: number): string {
  return STACK_COLORS[i % STACK_COLORS.length] ?? 'var(--color-text-muted)';
}

/** "25 Oct" — a billing day ("2026-10-25") in the reader's words. */
export function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${month}`;
}
