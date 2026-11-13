// railState.ts
// ===========
// Derive the cockpit mantra phase-rail display state from the read model's
// phase_rail + blocked_cards blocks. This is the customer-facing readiness
// overlay: a column is a `gate` when work is held there, `active` when it's the
// busiest in-flight column, `empty` when nothing sits in it, else `has-work`.
// Pure — unit-tested.

import type { Phase, PhaseColumn, CockpitCard } from '$lib/types/cockpit';

export type RailColumnState = 'active' | 'gate' | 'has-work' | 'done' | 'empty';

export interface RailColumnView {
  phase: Phase;
  list_name: string | null;
  count: number;
  state: RailColumnState;
  age_label: string | null;
}

const READINESS_WORD: Record<RailColumnState, string> = {
  active: 'active',
  gate: 'needs you',
  'has-work': 'in flight',
  done: 'done',
  empty: 'clear',
};

export function readinessWord(state: RailColumnState): string {
  return READINESS_WORD[state];
}

/** Compact human age, e.g. "45m", "3h", "2d". Null passes through. */
export function formatAge(ms: number | null): string | null {
  if (ms == null) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

export function deriveRailState(
  phaseRail: PhaseColumn[],
  blockedCards: CockpitCard[],
): RailColumnView[] {
  const gatedPhases = new Set<Phase>(blockedCards.map((c) => c.phase));
  return phaseRail.map((col) => {
    let state: RailColumnState;
    // DONE (PUBLISHING) is TERMINAL: its cards are finished, not "in flight", and
    // the time since they arrived is not an age anyone should act on — so no
    // `active`/`in flight` word and no "oldest" label. A held card still gates.
    const terminal = col.phase === 'PUBLISHING';
    if (gatedPhases.has(col.phase) && col.count > 0) state = 'gate';
    else if (terminal && col.count > 0) state = 'done';
    else if (col.active) state = 'active';
    else if (col.count === 0) state = 'empty';
    else state = 'has-work';
    return {
      phase: col.phase,
      list_name: col.list_name,
      count: col.count,
      state,
      age_label: state === 'done' ? null : formatAge(col.oldest_card_age_ms),
    };
  });
}
