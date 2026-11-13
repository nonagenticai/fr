// Backend list-name → AA phase mapping (READYING → DOING → INSPECTING → PUBLISHING), used by
// `/api/measure` (T/I/OE lenses) and the card-detail route's phase journey.
//
// ⛔ PUBLISHING (DONE) is NOT a key here: it is decided by the ONE shared predicate,
// lib/done-equivalent.ts isDoneEquivalentListName — an exact normalized allowlist the DONE-move
// guard also uses. `frontend/src/lib/cards/phase.ts` decides PUBLISHING through a byte-identical
// copy of that predicate (frontend/src/lib/cards/done-equivalent.ts; EQUALITY pinned by its
// done-equivalent.test.ts). The
// non-DONE keys below match the frontend's.

import { isDoneEquivalentListName } from './done-equivalent';

export type Phase = 'READYING' | 'DOING' | 'INSPECTING' | 'PUBLISHING';

/** Canonical mantra order. */
export const PHASES: readonly Phase[] = [
  'READYING',
  'DOING',
  'INSPECTING',
  'PUBLISHING',
] as const;

/** The non-DONE (work-in-progress) phases — Inventory counts only these. */
export const WIP_PHASES: readonly Phase[] = [
  'READYING',
  'DOING',
  'INSPECTING',
] as const;

const LIST_TO_PHASE: Record<string, Phase> = {
  TODO: 'READYING',
  READY: 'READYING',
  READYING: 'READYING',
  DOING: 'DOING',
  QA: 'INSPECTING',
  INSPECTING: 'INSPECTING',
};

/**
 * ⛔ PUBLISHING (DONE) is decided by the ONE shared predicate (lib/done-equivalent.ts), never
 * by a key in the map above — the DONE-move guard uses the same function, so nothing this
 * mirror counts as DONE can be reached without passing the guard.
 */
export function phaseFromListName(listName: string | null): Phase | null {
  if (!listName) return null;
  if (isDoneEquivalentListName(listName)) return 'PUBLISHING';
  return LIST_TO_PHASE[listName.toUpperCase()] ?? null;
}

// BLOCKED is a side-flag, not a phase: a card parked on a list whose name
// contains "BLOCK" is stalled regardless of the phase it would otherwise map
// to. `phaseFromListName('BLOCKED')` returns null, so blocked cards are
// counted separately from the phase buckets.
export function isBlocked(listName: string | null): boolean {
  if (!listName) return false;
  return listName.toUpperCase().includes('BLOCK');
}
