// src/lib/components/kanban/cardMoves.ts
//
// Works out which cards a drag actually moved, so the drop handler issues one
// API call per genuinely-moved card instead of one per card in the list.
//
// The bug this replaces: ListColumn's drop handler tried to identify the moved
// card with
//
//     const priorListId = others.find(() => false)?.listId; // placeholder
//     void priorListId;
//
// `find(() => false)` is always `undefined` — dead code the comment openly
// admitted ("we can't retrieve it here directly"), because the handler had
// already overwritten `board.cards` with the post-drop order one line earlier,
// destroying the very state it needed to diff against. So it fell through to
// calling `moveCard` for EVERY card in the target list on EVERY drop: dropping
// into a 20-card list fired 20 requests, 19 of them no-ops that still race,
// still consume rate budget, and — because each failure was swallowed by a bare
// `catch {}` — could each roll the board back.
//
// The fix is to capture the previous order BEFORE overwriting it and diff.

export interface CardPosition {
  id: string;
  listId: string;
}

export interface CardMove {
  cardId: string;
  toListId: string;
  position: number;
}

/** Planka normalises internally; we only need a stable increasing order. */
export function positionForIndex(index: number): number {
  return (index + 1) * 1000;
}

/**
 * Diff the pre-drop card order against the post-drop order for one list.
 *
 * @param previous  every card on the board, as it was BEFORE the drop
 * @param items     the target list's cards, in their new order
 * @param listId    the list being dropped into
 * @returns one move per card that actually changed list or index — nothing else
 */
export function computeCardMoves(
  previous: readonly CardPosition[],
  items: readonly { id: string }[],
  listId: string,
): CardMove[] {
  // Index within the list as it was before the drop.
  const priorIndex = new Map<string, number>();
  const priorList = new Map<string, string>();
  let seen = 0;
  for (const card of previous) {
    priorList.set(card.id, card.listId);
    if (card.listId === listId) {
      priorIndex.set(card.id, seen);
      seen += 1;
    }
  }

  const moves: CardMove[] = [];
  items.forEach((item, index) => {
    const cameFrom = priorList.get(item.id);
    const wasAt = priorIndex.get(item.id);
    // Changed list, is brand new to the board, or shifted within this list.
    const changedList = cameFrom !== listId;
    const changedIndex = wasAt !== index;
    if (changedList || changedIndex) {
      moves.push({ cardId: item.id, toListId: listId, position: positionForIndex(index) });
    }
  });
  return moves;
}

/**
 * Capture-once snapshot of the board order for one drag gesture.
 *
 * This exists because `handleConsider` mutates `board.cards` DURING the drag so
 * the UI reflects the pending order. By the time `finalize` fires, the board no
 * longer holds the pre-drag order — so snapshotting inside `finalize` yields the
 * post-drag order, the diff comes out empty, and NOTHING is persisted. That is a
 * worse bug than the one being fixed, which is why the lifecycle lives here with
 * tests rather than inline in the component.
 *
 * `begin` is idempotent within a gesture: consider fires many times, only the
 * first capture counts. `end` clears it so the next drag starts clean.
 */
export class DragSnapshot {
  private snapshot: CardPosition[] | null = null;

  /** Call at the TOP of every `consider`, before the board is mutated. */
  begin(cards: readonly CardPosition[]): void {
    if (this.snapshot !== null) return;
    this.snapshot = cards.map((c) => ({ id: c.id, listId: c.listId }));
  }

  /** True once a gesture has captured its snapshot. */
  get active(): boolean {
    return this.snapshot !== null;
  }

  /**
   * Consume the snapshot at `finalize`. Falls back to `current` when no
   * `consider` ever fired (a programmatic or synthetic drop), which degrades to
   * the old behaviour rather than silently persisting nothing.
   */
  end(current: readonly CardPosition[]): CardPosition[] {
    const taken = this.snapshot ?? current.map((c) => ({ id: c.id, listId: c.listId }));
    this.snapshot = null;
    return taken;
  }
}
