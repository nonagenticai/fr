// tests/unit/services/conveyor-start-progress.test.ts
//
// R319 — the start card's progress, read from the project's board exactly as the conveyor's
// Start checks read it: the start card is the `card_type = project_start_request_analysis`
// card (or the one carrying the conveyor's birth line); progress = it is outside TODO; a board
// without a start card is UNKNOWN (null), never "no progress".
import { describe, expect, test } from 'bun:test';

import {
  START_BIRTH_LINE,
  START_CARD_TYPE,
  hasProgressed,
  rememberProgressed,
  startCardProgressed,
  startProgressOf,
  type StartProgressBoard,
} from '../../../src/services/conveyor-start-progress';

const lists = [
  { id: 'l1', name: 'TODO' },
  { id: 'l2', name: 'READY' },
  { id: 'l3', name: 'DOING' },
  { id: 'l4', name: 'QA' },
  { id: 'l5', name: 'DONE' },
  { id: 'l6', name: 'BLOCKED' },
];
const board = (cards: Array<{ id: string; listId: string; description?: string; listChangedAt?: string | null }>, typed: string[] = [], fieldName = 'card_type'): StartProgressBoard => ({
  included: {
    lists,
    cards,
    customFields: [{ id: 'f1', name: fieldName }],
    customFieldValues: typed.map((cardId) => ({ cardId, customFieldId: 'f1', content: START_CARD_TYPE })),
  },
});


const at = (cardId: string, list: string, listChangedAt: string | null = null) => ({ startCardLeftTodo: list !== 'TODO', cardId, list, listChangedAt });

describe('startProgressOf', () => {
  test('a start card (by card_type) in TODO ⇒ no progress; in any other list ⇒ progress, with its id and list', () => {
    expect(startProgressOf(board([{ id: 'a', listId: 'l1' }], ['a']))).toEqual(at('a', 'TODO'));
    expect(startProgressOf(board([{ id: 'a', listId: 'l2' }], ['a']))).toEqual(at('a', 'READY'));
    expect(startProgressOf(board([{ id: 'a', listId: 'l3' }], ['a']))).toEqual(at('a', 'DOING'));
    // A list the board does not name (archive/trash) is not TODO, as the conveyor reads it.
    expect(startProgressOf(board([{ id: 'a', listId: 'l-gone' }], ['a']))).toEqual(at('a', ''));
  });

  test("R320: the card's listChangedAt is passed through; an empty or missing stamp is null", () => {
    const t = '2026-10-21T09:00:00.000Z';
    expect(startProgressOf(board([{ id: 'a', listId: 'l3', listChangedAt: t }], ['a']))).toEqual(at('a', 'DOING', t));
    expect(startProgressOf(board([{ id: 'a', listId: 'l3', listChangedAt: '' }], ['a']))).toEqual(at('a', 'DOING'));
    expect(startProgressOf(board([{ id: 'a', listId: 'l3', listChangedAt: null }], ['a']))).toEqual(at('a', 'DOING'));
  });

  test('the birth line identifies the start card too (trailing spaces ignored)', () => {
    expect(startProgressOf(board([{ id: 'a', listId: 'l1', description: `x\n${START_BIRTH_LINE}  ` }]))).toEqual(at('a', 'TODO'));
    expect(START_BIRTH_LINE).toBe('conveyor-birth: phase:project_start_request_analysis:setup');
  });

  test("R320: more than one start card ⇒ no card id (no stalled read); left-TODO keeps R319's any-card meaning", () => {
    const many = (startCardLeftTodo: boolean) => ({ startCardLeftTodo, cardId: null, list: '', listChangedAt: null });
    // Both in TODO ⇒ no progress, exactly as on main (no_progress is still offered).
    expect(startProgressOf(board([{ id: 'a', listId: 'l1' }, { id: 'b', listId: 'l1', description: START_BIRTH_LINE }], ['a']))).toEqual(many(false));
    // Any one outside TODO ⇒ progress, as on main.
    expect(startProgressOf(board([{ id: 'a', listId: 'l1' }, { id: 'b', listId: 'l3' }], ['a', 'b']))).toEqual(many(true));
    expect(startProgressOf(board([{ id: 'a', listId: 'l3', listChangedAt: '2026-10-21T09:00:00.000Z' }, { id: 'b', listId: 'l2' }], ['a', 'b']))).toEqual(many(true));
  });

  test('no start card, another card type, another field name or no board ⇒ unknown (null)', () => {
    expect(startProgressOf(board([{ id: 'a', listId: 'l1' }]))).toBeNull();
    expect(startProgressOf(board([{ id: 'a', listId: 'l1' }], ['a'], 'stream_slug'))).toBeNull();
    expect(
      startProgressOf({
        included: {
          lists,
          cards: [{ id: 'a', listId: 'l1' }],
          customFields: [{ id: 'f1', name: 'card_type' }],
          customFieldValues: [{ cardId: 'a', customFieldId: 'f1', content: 'project_setup' }],
        },
      }),
    ).toBeNull();
    expect(startProgressOf({})).toBeNull();
    expect(startProgressOf(null)).toBeNull();
  });
});

describe('R320: startCardProgressed (what the memo may remember)', () => {
  test('only QA and DONE; TODO, READY, DOING, BLOCKED and an unknown list may still stall or move back', () => {
    expect(startCardProgressed({ list: 'QA' })).toBe(true);
    expect(startCardProgressed({ list: 'DONE' })).toBe(true);
    for (const list of ['TODO', 'READY', 'DOING', 'BLOCKED', '']) expect(startCardProgressed({ list })).toBe(false);
  });
});

describe('the progressed memo', () => {
  test('remembers a project once it has progressed', () => {
    const id = crypto.randomUUID();
    expect(hasProgressed(id)).toBe(false);
    rememberProgressed(id);
    expect(hasProgressed(id)).toBe(true);
  });
});
