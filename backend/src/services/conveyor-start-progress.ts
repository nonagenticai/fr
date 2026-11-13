// src/services/conveyor-start-progress.ts
//
// R319 (Claude, 2026-10-21; program/v4-alignment/U1-brief.md) — has a DELIVERED conveyor
// start made any progress? Read from the project's own board, the same board the conveyor
// reads in its Start checks (conveyor wfgen START_CHECKS_JS):
//
//   * the START CARD is the card whose Metadata `card_type` is
//     `project_start_request_analysis`, or whose description carries the conveyor's birth
//     line `conveyor-birth: phase:project_start_request_analysis:setup`;
//   * progress = the start card is in any list other than TODO (the conveyor answers a
//     retry of such a project 409 psra_exists);
//   * no progress = there IS a start card and every start card is still in TODO (the
//     conveyor answers a retry 200 resumed: it re-pulls the card).
//
// Anything else — no start card on the board, an unreadable board — is UNKNOWN (`null`):
// fr offers nothing new from an unknown fact.
//
// R320 (Claude, 2026-10-21; program/v4-alignment/R320-start-again-stalled.md): the read also
// returns the start card's id, its list and its `listChangedAt` (Planka's stamp of the last
// list move), so a start card sitting in READY or DOING with no progress can be offered
// "Start again" (`stalled`). MORE THAN ONE start card ⇒ UNKNOWN: fr cannot tell which one
// the conveyor is working, so it offers nothing new.
//
// Pure, apart from a small in-process memo of the monotone fact "the start card has reached
// QA or DONE" (a project that far along never needs its board read for this again). READY,
// DOING and BLOCKED are NOT remembered: a card there may still stall or move back.

export const START_CARD_TYPE = 'project_start_request_analysis';
export const START_BIRTH_LINE = `conveyor-birth: phase:${START_CARD_TYPE}:setup`;
const TODO = 'TODO';
/** R320: the lists a start card can stall in (the conveyor restarts it there). */
export const STALLABLE_LISTS: ReadonlySet<string> = new Set(['READY', 'DOING']);
/** R320: lists past which the start card never needs reading again (the memo, flag on). */
const PROGRESSED_LISTS: ReadonlySet<string> = new Set(['QA', 'DONE']);

/** The board detail fields this read needs (Planka `GET /boards/:id`, passed through). */
export interface StartProgressBoard {
  included?: {
    lists?: Array<{ id: string; name?: string | null }>;
    cards?: Array<{ id: string; listId: string; description?: string | null; listChangedAt?: string | null }>;
    customFields?: Array<{ id: string; name?: string | null }>;
    customFieldValues?: Array<{ cardId: string; customFieldId: string; content?: unknown }>;
  };
}

export interface StartProgress {
  /** true: a start card is outside TODO. false: start card(s) on the board, all in TODO (R319). */
  startCardLeftTodo: boolean;
  /** R320: the start card's Planka id; null when the board shows more than one start card. */
  cardId: string | null;
  /** R320: the name of the list it is in ('' when the list is not on the board, or cardId is null). */
  list: string;
  /** R320: Planka's stamp of its last list move (ISO), when the board carries one (null when cardId is null). */
  listChangedAt: string | null;
}

/** R320: true once the start card is in QA or DONE (remembered; never read again). */
export function startCardProgressed(p: Pick<StartProgress, 'list'>): boolean {
  return PROGRESSED_LISTS.has(p.list);
}

/**
 * Pure: the start card's progress on this board, or null (unknown) when the board shows no
 * start card. More than one start card ⇒ `cardId` null (no `stalled` read), `startCardLeftTodo`
 * as R319 read it.
 */
export function startProgressOf(board: StartProgressBoard | null | undefined): StartProgress | null {
  const inc = board?.included;
  if (!inc) return null;
  const cardTypeFields = new Set((inc.customFields ?? []).filter((f) => f.name === 'card_type').map((f) => f.id));
  const typed = new Set(
    (inc.customFieldValues ?? [])
      .filter((v) => cardTypeFields.has(v.customFieldId) && String(v.content ?? '').trim() === START_CARD_TYPE)
      .map((v) => String(v.cardId)),
  );
  const listName = new Map((inc.lists ?? []).map((l) => [String(l.id), (l.name ?? '').trim()]));
  const starts = (inc.cards ?? []).filter(
    (c) =>
      typed.has(String(c.id)) ||
      String(c.description ?? '')
        .split('\n')
        .some((l) => l.replace(/\s+$/, '') === START_BIRTH_LINE),
  );
  if (starts.length === 0) return null;
  if (starts.length > 1) {
    return {
      startCardLeftTodo: starts.some((c) => listName.get(String(c.listId)) !== TODO),
      cardId: null,
      list: '',
      listChangedAt: null,
    };
  }
  const card = starts[0]!;
  const list = listName.get(String(card.listId)) ?? '';
  const changed = typeof card.listChangedAt === 'string' && card.listChangedAt ? card.listChangedAt : null;
  return { startCardLeftTodo: list !== TODO, cardId: String(card.id), list, listChangedAt: changed };
}

// ── the memo of "has progressed" (monotone; bounded) ─────────────────────────
const MEMO_MAX = 2_000;
const progressed = new Set<string>();

export function rememberProgressed(projectId: string): void {
  if (progressed.size >= MEMO_MAX) progressed.clear();
  progressed.add(projectId);
}
/** A project or phase RESTART (George 2026-10-31) re-runs the start card: its progress is read afresh. */
export function forgetProgressed(projectId: string): void {
  progressed.delete(projectId);
}

export function hasProgressed(projectId: string): boolean {
  return progressed.has(projectId);
}
