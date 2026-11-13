// src/lib/components/kanban/cardMoves.test.ts

import { describe, it, expect } from 'vitest';
import { computeCardMoves, positionForIndex, type CardPosition } from './cardMoves';

const board = (...spec: [string, string][]): CardPosition[] =>
  spec.map(([id, listId]) => ({ id, listId }));

const ids = (items: string[]) => items.map((id) => ({ id }));

describe('computeCardMoves', () => {
  it('emits NOTHING when the order is unchanged', () => {
    // The whole point: dropping a card back where it came from, or a drop that
    // ends in the same order, must not fire a single request. The old handler
    // fired one per card in the list every time.
    const prev = board(['a', 'L1'], ['b', 'L1'], ['c', 'L1']);
    expect(computeCardMoves(prev, ids(['a', 'b', 'c']), 'L1')).toEqual([]);
  });

  it('emits ONLY the cards whose index actually changed', () => {
    // Move 'c' to the front: c moves 2->0, a moves 0->1, b moves 1->2.
    // All three genuinely shifted, so all three are reported — but a reorder
    // that only displaces one card must not report the untouched ones.
    const prev = board(['a', 'L1'], ['b', 'L1'], ['c', 'L1'], ['z', 'L2']);
    const moves = computeCardMoves(prev, ids(['c', 'a', 'b']), 'L1');
    expect(moves.map((m) => m.cardId)).toEqual(['c', 'a', 'b']);
    // 'z' lives in another list and was never in `items` — never reported.
    expect(moves.some((m) => m.cardId === 'z')).toBe(false);
  });

  it('reports a card that moved in from another list, and only the cards it displaced', () => {
    const prev = board(['a', 'L1'], ['b', 'L1'], ['x', 'L2']);
    // x dropped between a and b.
    const moves = computeCardMoves(prev, ids(['a', 'x', 'b']), 'L1');
    // 'a' did not move (index 0 -> 0) so it must NOT be reported.
    expect(moves.map((m) => m.cardId)).toEqual(['x', 'b']);
    expect(moves[0]).toEqual({ cardId: 'x', toListId: 'L1', position: positionForIndex(1) });
  });

  it('appending to the end of a list reports only the appended card', () => {
    const prev = board(['a', 'L1'], ['b', 'L1'], ['x', 'L2']);
    const moves = computeCardMoves(prev, ids(['a', 'b', 'x']), 'L1');
    expect(moves.map((m) => m.cardId)).toEqual(['x']);
    expect(moves[0]?.position).toBe(positionForIndex(2));
  });

  it('treats a card unknown to the previous board as a move (safe default)', () => {
    const prev = board(['a', 'L1']);
    const moves = computeCardMoves(prev, ids(['a', 'brand-new']), 'L1');
    expect(moves.map((m) => m.cardId)).toEqual(['brand-new']);
  });

  it('indexes within the target list only — cards in other lists do not shift it', () => {
    // Regression guard for computing the prior index over the whole board
    // instead of per-list: with L2 cards interleaved, 'b' is still at index 1
    // of L1, so an unchanged drop reports nothing.
    const prev = board(['a', 'L1'], ['x', 'L2'], ['b', 'L1'], ['y', 'L2'], ['c', 'L1']);
    expect(computeCardMoves(prev, ids(['a', 'b', 'c']), 'L1')).toEqual([]);
  });

  it('moving the only card out and back reports nothing', () => {
    const prev = board(['a', 'L1']);
    expect(computeCardMoves(prev, ids(['a']), 'L1')).toEqual([]);
  });

  it('handles an empty target list', () => {
    const prev = board(['x', 'L2']);
    expect(computeCardMoves(prev, ids([]), 'L1')).toEqual([]);
    expect(computeCardMoves(prev, ids(['x']), 'L1')).toEqual([
      { cardId: 'x', toListId: 'L1', position: positionForIndex(0) },
    ]);
  });
});

describe('positionForIndex', () => {
  it('is strictly increasing and never zero', () => {
    // Zero/negative positions sort unpredictably in Planka.
    const positions = [0, 1, 2, 3].map(positionForIndex);
    expect(positions).toEqual([1000, 2000, 3000, 4000]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  });
});

describe('DragSnapshot — the consider-mutates-state lifecycle', () => {
  it('captures the PRE-drag order even though consider mutates the board', async () => {
    const { DragSnapshot } = await import('./cardMoves');
    const snap = new DragSnapshot();
    let boardCards = board(['a', 'L1'], ['b', 'L1'], ['c', 'L1']);

    // consider #1: snapshot first, then the component mutates for the visual.
    snap.begin(boardCards);
    boardCards = board(['c', 'L1'], ['a', 'L1'], ['b', 'L1']);
    // consider #2 (drag keeps firing): must NOT overwrite the snapshot.
    snap.begin(boardCards);

    const previous = snap.end(boardCards);
    // If begin() were not capture-once, `previous` would equal the post-drag
    // order and this diff would be empty — nothing would ever persist.
    const moves = computeCardMoves(previous, ids(['c', 'a', 'b']), 'L1');
    expect(moves.map((m) => m.cardId)).toEqual(['c', 'a', 'b']);
  });

  it('resets between gestures', async () => {
    const { DragSnapshot } = await import('./cardMoves');
    const snap = new DragSnapshot();
    const first = board(['a', 'L1'], ['b', 'L1']);
    snap.begin(first);
    expect(snap.active).toBe(true);
    snap.end(first);
    expect(snap.active).toBe(false);

    // A second drag must capture ITS own starting order, not the first one's.
    const second = board(['b', 'L1'], ['a', 'L1']);
    snap.begin(second);
    expect(snap.end(second)).toEqual([
      { id: 'b', listId: 'L1' },
      { id: 'a', listId: 'L1' },
    ]);
  });

  it('falls back to the current order when no consider ever fired', async () => {
    const { DragSnapshot } = await import('./cardMoves');
    const snap = new DragSnapshot();
    const cards = board(['a', 'L1']);
    expect(snap.end(cards)).toEqual([{ id: 'a', listId: 'L1' }]);
  });
});
