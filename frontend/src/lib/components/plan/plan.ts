// plan.ts — the pure half of Plan & scope (R6, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3/§5): the
// milestone state words and the per-phase capability grouping. No fetching, no Svelte.
//
// ⛔ C10, HONESTLY. A closed project's milestones follow the project: a milestone whose target date
// had passed when the project closed reads as REACHED — derived from the dates, and the panel says
// so. Nothing in fr measures milestone completion; a milestone with no target date, or one whose
// target was still ahead at closure, is NEVER shown as reached.
//
// ⛔ CAPABILITIES PER PHASE (§3), from the ONE place a capability name exists: the by-card cost rows
// the cockpit already annotates (the card's OWN `phase` field + the RM capability of its
// `card_type`). A phase is never inferred from a date; a card with no phase is listed as such.

import type { CostCardRow, ProjectMilestone } from '$lib/types/cockpit';
import { humanize } from '$lib/components/registers/registers';

export interface PhaseCapabilityGroup {
  /** The phase the cards recorded (null = the cards that record no phase). */
  name: string | null;
  label: string;
  /** Distinct capability names (RM's, made readable), sorted — never invented. */
  capabilities: string[];
  /** Distinct cards in this phase whose row names no capability. */
  cardsWithoutCapability: number;
  /** Distinct cards in this phase (the rows that carry spend, as the Cost page reads them). */
  cards: number;
}

/**
 * Group the by-card spend rows' capabilities by the phase each card RECORDS, in the project's phase
 * order, with a "Not tied to a phase" bucket last. Rows with no `card_id` are spend no card owns and
 * are left out — they are not a capability of any phase.
 */
export function capabilitiesByPhase(
  rows: readonly CostCardRow[],
  phases: readonly { name: string; label: string }[],
): PhaseCapabilityGroup[] {
  const order = new Map(phases.map((p, i) => [p.name, i] as const));
  const label = new Map(phases.map((p) => [p.name, p.label] as const));
  const acc = new Map<string | null, { caps: Set<string>; noCap: Set<string>; cards: Set<string> }>();
  for (const r of rows) {
    if (r.card_id === null) continue;
    const key = r.phase ?? null;
    const a = acc.get(key) ?? { caps: new Set<string>(), noCap: new Set<string>(), cards: new Set<string>() };
    a.cards.add(r.card_id);
    if (r.capability) a.caps.add(humanize(r.capability));
    else a.noCap.add(r.card_id);
    acc.set(key, a);
  }
  const out = [...acc.entries()].map(([key, a]): PhaseCapabilityGroup => ({
    name: key,
    label: key === null ? 'Not tied to a phase' : (label.get(key) ?? humanize(key)),
    capabilities: [...a.caps].sort((x, y) => x.localeCompare(y)),
    cardsWithoutCapability: a.noCap.size,
    cards: a.cards.size,
  }));
  out.sort((a, b) => {
    if (a.name === null) return 1;
    if (b.name === null) return -1;
    const ia = order.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const ib = order.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib || a.name.localeCompare(b.name);
  });
  return out;
}

export interface MilestoneView {
  position: number;
  name: string;
  targetDate: string | null;
  state: 'reached' | 'missed' | 'unknown' | 'scheduled';
  words: string;
}

/** "25 Oct 2026" for a date-only value; a full stamp still gets the day + month + year. */
export function dateWords(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const dayKey = (value: string | null): string | null => {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (m) return m[1]!;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/**
 * One milestone, in words that follow the project's lifecycle (C10).
 *  - running:      "Target date 25 Oct 2026" / "No target date".
 *  - closed:       reached when the target date is on/before the closure day (derived — the panel
 *                  says no separate completion is recorded); missed when it fell after; unknown
 *                  when there is no target date or no closure day.
 */
export function milestoneView(m: ProjectMilestone, closed: boolean, closedOn: string | null): MilestoneView {
  const target = dateWords(m.target_date);
  if (!closed) {
    return {
      position: m.position,
      name: m.name,
      targetDate: m.target_date,
      state: 'scheduled',
      words: target ? `Target date ${target}` : 'No target date',
    };
  }
  const t = dayKey(m.target_date);
  const end = dayKey(closedOn);
  if (t && end) {
    const reached = t <= end;
    return {
      position: m.position,
      name: m.name,
      targetDate: m.target_date,
      state: reached ? 'reached' : 'missed',
      words: reached
        ? `Reached by its target date, ${target}; the project closed ${dateWords(closedOn)}.`
        : `Not reached: its target date, ${target}, was after the project closed on ${dateWords(closedOn)}.`,
    };
  }
  return {
    position: m.position,
    name: m.name,
    targetDate: m.target_date,
    state: 'unknown',
    words: t
      ? `Target date ${target}; whether it was reached is not recorded.`
      : 'No target date, and whether it was reached is not recorded.',
  };
}

/**
 * The panel-level caveat a closed project shows above its milestones. The state comes from the
 * recorded dates: fr holds no milestone-completion record, and says so instead of implying one.
 */
export const MILESTONE_BASIS_WORDS =
  'This project is closed, so a milestone reads as reached when its target date had passed by the closing date. That is derived from the dates; no separate completion is recorded.';
