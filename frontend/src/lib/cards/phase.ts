// Planka list-name → AA phase mapping for the card page (display only). The Planka boards every
// system stream provisions carry the canonical list names; the AA phases are the doctrine layer.
// Mapping is many-to-one (TODO + READY both reflect READYING) so the UI can show a single pill
// regardless of where in the upstream list ordering the card sits.
//
// ⛔ PUBLISHING (DONE) is NOT a key in the map below: it is decided by ./done-equivalent.ts, a
// byte-identical copy of the backend's ONE DONE predicate (backend/src/lib/done-equivalent.ts),
// so this page (and ProgressPulse) counts EXACTLY what the DONE-move guard guards — not narrower,
// not broader (validator V4 NO-B). Equality pinned by ./done-equivalent.test.ts.
//
// `null` means the card is on a list outside the AA pipeline
// (e.g. a project task board) — the strip renders all four pills
// dimmed in that case.

import { isDoneEquivalentListName } from './done-equivalent';
import type { Phase } from './types';

const LIST_TO_PHASE: Record<string, Phase> = {
  TODO: 'READYING',
  READY: 'READYING',
  READYING: 'READYING',
  DOING: 'DOING',
  QA: 'INSPECTING',
  INSPECTING: 'INSPECTING',
};

export function phaseFromListName(listName: string | null): Phase | null {
  if (!listName) return null;
  if (isDoneEquivalentListName(listName)) return 'PUBLISHING';
  return LIST_TO_PHASE[listName.toUpperCase()] ?? null;
}

// BLOCKED is a side-flag, not a phase — the card retains its underlying
// phase but the strip renders a danger flag. Surfaced today via
// list_name = 'BLOCKED' until the card-level andon_engaged flag lands.
export function isBlocked(listName: string | null): boolean {
  if (!listName) return false;
  return listName.toUpperCase().includes('BLOCK');
}
