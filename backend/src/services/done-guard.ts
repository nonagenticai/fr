// src/services/done-guard.ts
//
// THE DONE-MOVE GUARD (design row #7, ncn#2087). Liveness never counts toward DONE: a
// PROOF-SUBSET card (domain/engagement/proof-subset.ts PROOF_SUBSET_CARD_TYPES) may be moved
// into a DONE-family list only when it holds a COMPUTED pass (card_computed_checks,
// services/computed-checks.ts hasComputedPass) OF A KIND ALLOWED FOR ITS TYPE
// (lib/computed-kind-table.ts — a kind not allowed for the type neither satisfies nor shadows;
// among the allowed kinds each kind is judged by its OWN latest verdict, and a pass of ANY
// allowed kind counts — services/computed-checks.ts latestComputedChecksPerKind). Otherwise 409
// `{ error: 'done_without_computed_check', card_id, card_type }`.
//
// Called BEFORE the Planka write by every fr route that can put an EXISTING card on a
// caller-chosen list:
//   - POST  /api/kanban/cards/:cardId/move          (routes/kanban/cards.ts handleMoveCard)
//   - POST  /api/assets/kanban/cards/:cardId/move   (routes/assets/kanban.ts handleMoveKanbanCard)
//   - PATCH /api/assets/kanban/cards/:cardId + listId (routes/assets/kanban.ts handleUpdateKanbanCard)
// and, for a NEW card created straight into DONE with a proof-subset type:
//   - POST  /api/cards/improvement target_list=DONE  (routes/cards/improvement.ts)
//     — a new card can hold no computed pass, so that is refused outright.
// and the two NON-move ways into DONE (validator NO-3, 2026-10-05):
//   - POST  /api/kanban/cards/:cardId/duplicate  (checkDoneDuplicate — the copy carries card_type)
//   - PATCH /api/assets/kanban/lists/:listId
//     (checkDoneListRename — no rename INTO a done-equivalent name, for any caller)
// "DONE" is ONE predicate everywhere: lib/done-equivalent.ts isDoneEquivalentListName.
//
// The ONLY sanctioned exception is the super-admin break-glass route
// (POST /api/kanban/cards/:cardId/break-glass-done), which writes an audit row and is scored
// NON-DONE by every fr DONE consumer.
//
// COST AND FAILURE MODES (validator NO-1, 2026-10-05). The guard must not add a failure mode to
// ORDINARY moves:
//   - destination list READ OK, name NOT done-equivalent ⇒ allowed, nothing else is read;
//   - destination list READ OK, name done-equivalent ⇒ the card's type is read, and the DB only
//     when the type IS in the proof subset; a failure of those reads propagates (a DONE-target
//     move fails closed);
//   - destination list read FAILED ⇒ the destination might be DONE, so the card's TYPE is read
//     (one card GET). A non-proof card is ALLOWED exactly as on main (the route's post-move list
//     read stays best-effort). A proof-subset card is allowed only with a computed pass (it could
//     go to DONE legitimately then); otherwise 503 `done_guard_destination_unresolved`. If the
//     card type cannot be read EITHER, nothing is known and the same 503 is returned.
//
// ⚠️ A card with NO card_type value is not a proof-subset card and is not refused. The type is
// read from the card's custom fields, the same place the n8n router reads it.

import { isDoneEquivalentListName } from '../lib/done-equivalent';
import { isProofSubsetCardType } from '../domain/engagement/proof-subset';
import { hasComputedPass } from './computed-checks';
import { boardMetadataCache, type RawBoardDetail } from './planka/board-metadata-cache';
import { plankaAsAgent } from './planka/with-auth';

const DONE_WITHOUT_COMPUTED_CHECK = 'done_without_computed_check' as const;
/** 503: the destination list could not be read, and the card may not reach DONE unverified. */
const DONE_GUARD_DESTINATION_UNRESOLVED = 'done_guard_destination_unresolved' as const;

interface RawCardWithValues {
  item: { id: string; boardId: string; listId: string };
  included?: {
    customFieldValues?: { customFieldId: string; content: string | null }[];
    customFields?: { id: string; name: string | null }[];
  };
}

/** Read `card_type` off a card's own custom field values (field named exactly `card_type`). */
export async function readCardTypeFromPlanka(
  cardId: string,
): Promise<{ boardId: string; listId: string; cardType: string | null }> {
  const planka = plankaAsAgent();
  const card = (await planka.http.request(
    'GET',
    `/api/cards/${encodeURIComponent(cardId)}`,
    {},
  )) as RawCardWithValues;
  const values = card.included?.customFieldValues ?? [];
  const fieldNames = new Map<string, string>();
  for (const f of card.included?.customFields ?? []) if (f.name) fieldNames.set(f.id, f.name);
  if (values.some((v) => !fieldNames.has(v.customFieldId))) {
    const meta = await boardMetadataCache.get({
      boardId: card.item.boardId,
      fetchBoard: () =>
        planka.http.request(
          'GET',
          `/api/boards/${encodeURIComponent(card.item.boardId)}`,
          {},
        ) as Promise<RawBoardDetail>,
      probeListId: card.item.listId,
      probeFieldIds: values.map((v) => v.customFieldId),
    });
    for (const f of meta.customFields) if (f.name && !fieldNames.has(f.id)) fieldNames.set(f.id, f.name);
  }
  for (const v of values) {
    if (fieldNames.get(v.customFieldId) === 'card_type' && v.content && v.content.trim()) {
      return { boardId: card.item.boardId, listId: card.item.listId, cardType: v.content.trim() };
    }
  }
  return { boardId: card.item.boardId, listId: card.item.listId, cardType: null };
}

async function getListName(listId: string): Promise<string | null> {
  const list = await plankaAsAgent().lists.get(listId);
  return list?.name ?? null;
}

export type DoneGuardRefusal =
  | {
      error: typeof DONE_WITHOUT_COMPUTED_CHECK;
      card_id: string;
      card_type: string;
      message: string;
    }
  | {
      error: typeof DONE_GUARD_DESTINATION_UNRESOLVED;
      card_id: string;
      card_type: string | null;
      list_id: string;
      message: string;
    };

/** HTTP status for a refusal: 409 for the rule, 503 for an unverifiable (transient) destination. */
export function doneRefusalStatus(r: DoneGuardRefusal): 409 | 503 {
  return r.error === DONE_GUARD_DESTINATION_UNRESOLVED ? 503 : 409;
}

/**
 * null = the move is allowed; otherwise the refusal body (status via {@link doneRefusalStatus}).
 *
 * `knownListName` saves the list read when the route already holds the destination's name.
 * `listReadFailed: true` tells the guard the ROUTE's own read of the destination failed (it
 * then does not retry the read, and takes the unresolved-destination branch).
 */
export async function checkDoneMove(input: {
  cardId: string;
  destListId: string | null | undefined;
  knownListName?: string | null;
  listReadFailed?: boolean;
}): Promise<DoneGuardRefusal | null> {
  if (!input.destListId) return null;
  let name: string | null = null;
  let resolved = !input.listReadFailed;
  if (resolved) {
    if (input.knownListName !== undefined) {
      name = input.knownListName;
    } else {
      try {
        name = await getListName(input.destListId);
      } catch (err) {
        resolved = false;
        console.warn(
          `[done-guard] destination list ${input.destListId} unreadable for card ${input.cardId}; ` +
            'resolving the card type to decide',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  if (resolved) {
    if (!isDoneEquivalentListName(name)) return null;
    const { cardType } = await readCardTypeFromPlanka(input.cardId);
    if (!isProofSubsetCardType(cardType)) return null;
    if (await hasComputedPass(input.cardId, cardType)) return null;
    return doneWithoutComputedCheckBody(input.cardId, cardType!);
  }
  // Destination UNKNOWN: only a proof-subset card is held back.
  let cardType: string | null;
  try {
    ({ cardType } = await readCardTypeFromPlanka(input.cardId));
  } catch (err) {
    console.warn(
      `[done-guard] card ${input.cardId}: destination AND card type unreadable; refusing`,
      err instanceof Error ? err.message : String(err),
    );
    return destinationUnresolvedBody(input.cardId, input.destListId, null);
  }
  if (!isProofSubsetCardType(cardType)) return null;
  if (await hasComputedPass(input.cardId, cardType)) return null;
  return destinationUnresolvedBody(input.cardId, input.destListId, cardType);
}

function destinationUnresolvedBody(cardId: string, listId: string, cardType: string | null): DoneGuardRefusal {
  return {
    error: DONE_GUARD_DESTINATION_UNRESOLVED,
    card_id: cardId,
    card_type: cardType,
    list_id: listId,
    message:
      'The destination list could not be read, so fr cannot tell whether this move puts the ' +
      'card in DONE. ' +
      (cardType
        ? `A ${cardType} card reaches DONE only with a computed-check pass, so the move was not made. `
        : 'The card type could not be read either, so the move was not made. ') +
      'Retry; nothing was written.',
  };
}

const DONE_DUPLICATE_REFUSED = 'done_duplicate_refused' as const;
const DONE_LIST_RENAME_REFUSED = 'done_list_rename_refused' as const;

/**
 * POST /api/kanban/cards/:cardId/duplicate (validator NO-3a). Planka's duplicate copies the
 * card's custom fields (planka-private server/api/helpers/cards/duplicate-one.js →
 * cards.copyCustomFields), so the copy CARRIES card_type, and fr's route lands it in the
 * SOURCE card's list. The copy is a new card id with NO computed pass (and no override row), so
 * a proof-subset card sitting in a done-equivalent list may not be duplicated at all — a
 * source's pass never transfers. 409 `done_duplicate_refused`.
 *
 * Cost: one card GET (type + list); the list is read only for a proof-subset card. A failed
 * list read for a proof card ⇒ 503 `done_guard_destination_unresolved`. A failed CARD read
 * propagates (the route maps it).
 */
export async function checkDoneDuplicate(cardId: string): Promise<
  | DoneGuardRefusal
  | { error: typeof DONE_DUPLICATE_REFUSED; card_id: string; card_type: string; message: string }
  | null
> {
  const { cardType, listId } = await readCardTypeFromPlanka(cardId);
  if (!isProofSubsetCardType(cardType)) return null;
  if (!listId) return destinationUnresolvedBody(cardId, '', cardType);
  let name: string | null;
  try {
    name = await getListName(listId);
  } catch (err) {
    console.warn(
      `[done-guard] duplicate of ${cardId}: source list ${listId} unreadable; refusing`,
      err instanceof Error ? err.message : String(err),
    );
    return destinationUnresolvedBody(cardId, listId, cardType);
  }
  if (!isDoneEquivalentListName(name)) return null;
  return {
    error: DONE_DUPLICATE_REFUSED,
    card_id: cardId,
    card_type: cardType!,
    message:
      `This ${cardType} card is in "${name}", a DONE list. Its duplicate would land in DONE with ` +
      'no computed-check pass of its own, so duplicating it is refused. Duplicate it from a ' +
      'non-DONE list, or create a new card.',
  };
}

/**
 * PATCH /api/assets/kanban/lists/:listId (validator
 * NO-3b). Renaming a list to a done-equivalent name would put every card in it "in DONE"
 * without a move. Refused for EVERY caller, super-admin included: 409 `done_list_rename_refused`.
 * Pure on the requested name — no Planka read, so an ordinary rename gains no failure mode.
 * Returns null when the body renames nothing or to a non-done-equivalent name.
 */
export function checkDoneListRename(listId: string, newName: unknown): {
  error: typeof DONE_LIST_RENAME_REFUSED;
  list_id: string;
  name: string;
  message: string;
} | null {
  if (typeof newName !== 'string' || !isDoneEquivalentListName(newName)) return null;
  return {
    error: DONE_LIST_RENAME_REFUSED,
    list_id: listId,
    name: newName,
    message:
      `"${newName}" is a DONE-equivalent list name. Renaming a list into DONE would put every ` +
      'card on it in DONE without the computed-check guard, so fr refuses it for every caller. ' +
      'Boards get their DONE list from the board template.',
  };
}

export function doneWithoutComputedCheckBody(
  cardId: string,
  cardType: string,
): Extract<DoneGuardRefusal, { error: typeof DONE_WITHOUT_COMPUTED_CHECK }> {
  return {
    error: DONE_WITHOUT_COMPUTED_CHECK,
    card_id: cardId,
    card_type: cardType,
    message:
      `A ${cardType} card reaches DONE only with a computed-check pass (liveness, a judge and a ` +
      'human sign-off never count). No passing computed verdict is recorded for this card. A ' +
      'super-admin may use POST /api/kanban/cards/:cardId/break-glass-done with a reason; that ' +
      'is recorded and scored NON-DONE.',
  };
}
