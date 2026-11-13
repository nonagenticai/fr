// Pure helpers for the C3 phase spine and the C8 decision log (components PhaseSpine / DecisionLog).
// The read model (backend services/cockpit/spine.ts) does the projection; this file only turns it
// into widths, words and filters, so every rule here is unit-tested without a DOM.
import type {
  CockpitDecision,
  CockpitSpine,
  DecidedByKind,
  SpineCardState,
  SpinePhase,
  SpinePhaseState,
} from '$lib/types/cockpit';
import { durationWords } from '$lib/projects/cockpit-status';

/** Share of the track a phase that never ran takes (a hollow placeholder), in percent. */
export const UNRUN_SHARE = 8;
/** The narrowest a phase that did run is drawn, in percent, so a 2-minute phase stays clickable. */
export const MIN_RUN_SHARE = 6;

/**
 * Segment widths in percent (summing to 100): phases that ran are proportional to their time,
 * with a floor; phases that never ran share a small fixed slot each.
 */
export function segmentWidths(phases: readonly Pick<SpinePhase, 'duration_ms'>[]): number[] {
  if (phases.length === 0) return [];
  const ran = phases.map((p) => (p.duration_ms !== null && p.duration_ms > 0 ? p.duration_ms : null));
  const ranCount = ran.filter((d) => d !== null).length;
  if (ranCount === 0) return phases.map(() => 100 / phases.length);
  const unrun = phases.length - ranCount;
  const pool = Math.max(0, 100 - unrun * UNRUN_SHARE);
  const total = ran.reduce<number>((a, d) => a + (d ?? 0), 0);
  // Proportional, then lift any below the floor and take the difference from the others.
  const raw = ran.map((d) => (d === null ? null : (d / total) * pool));
  const floor = Math.min(MIN_RUN_SHARE, pool / ranCount);
  const lifted = raw.map((w) => (w === null ? null : Math.max(w, floor)));
  const excess = lifted.reduce<number>((a, w) => a + (w ?? 0), 0) - pool;
  const shrinkable = lifted.reduce<number>((a, w) => a + (w !== null && w > floor ? w - floor : 0), 0);
  return lifted.map((w) => {
    if (w === null) return UNRUN_SHARE;
    if (excess <= 0 || shrinkable <= 0 || w <= floor) return w;
    return w - ((w - floor) / shrinkable) * excess;
  });
}

/** Machine vs waiting-on-people split of a phase, in percent of its time (0/0 when it never ran). */
export function waitSplit(p: Pick<SpinePhase, 'duration_ms' | 'human_wait_ms' | 'machine_ms'>): {
  machine: number;
  people: number;
} {
  if (!p.duration_ms) return { machine: 0, people: 0 };
  const people = Math.min(100, (p.human_wait_ms / p.duration_ms) * 100);
  return { machine: 100 - people, people };
}

export const PHASE_STATE_WORDS: Record<SpinePhaseState, string> = {
  done: 'Done',
  active: 'Current',
  upcoming: 'Not started',
  not_run: 'Not run',
};

export const CARD_STATE_WORDS: Record<SpineCardState, string> = {
  todo: 'To do',
  doing: 'Doing',
  qa: 'In review',
  done: 'Done',
  blocked: 'Blocked',
};

/** Who decided, in words. A person the directory could not name is "A person". */
export function actorWords(kind: DecidedByKind | null, name: string | null = null): string {
  switch (kind) {
    case 'human':
      return name ?? 'A person';
    case 'triage_agent':
      return 'Approval agent';
    case 'rule':
      return 'A rule';
    case 'agent':
      // fr #1683: an agent member (the agent platform acting over mcp) decided it.
      return 'Agent';
    default:
      return 'Not decided yet';
  }
}

/** "41 min" / "not run" / "running, 12 min so far". */
export function phaseTimeWords(p: Pick<SpinePhase, 'duration_ms' | 'state'>): string {
  if (p.duration_ms === null) return p.state === 'not_run' ? 'not run' : 'not started';
  return p.state === 'active' ? `${durationWords(p.duration_ms)} so far` : durationWords(p.duration_ms);
}

/** "25 Oct, 07:41" in the viewer's locale; '' for an unreadable stamp. */
export function shortTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The card ids in `phase` (null ⇒ no filter). The board and the flow monitor filter by this set,
 * so clicking a phase on the spine filters every view the same way.
 */
export function cardIdsInPhase(spine: CockpitSpine | null, phase: string | null): Set<string> | null {
  if (!spine || phase === null) return null;
  return new Set(spine.cards.filter((c) => c.phase === phase).map((c) => c.id));
}

/** Keep the items whose card is in `phase`; everything when no phase is selected. */
export function filterByPhase<T>(
  items: readonly T[],
  spine: CockpitSpine | null,
  phase: string | null,
  cardIdOf: (item: T) => string | null,
): T[] {
  const ids = cardIdsInPhase(spine, phase);
  if (!ids) return [...items];
  return items.filter((i) => {
    const id = cardIdOf(i);
    return id !== null && ids.has(id);
  });
}

/** Decision rows in a phase (by the phase they were raised in, or their card's phase). */
export function decisionsInPhase(
  rows: readonly CockpitDecision[],
  spine: CockpitSpine | null,
  phase: string | null,
): CockpitDecision[] {
  if (phase === null) return [...rows];
  const ids = cardIdsInPhase(spine, phase) ?? new Set<string>();
  return rows.filter((r) => r.phase === phase || (r.card_id !== null && ids.has(r.card_id)));
}
