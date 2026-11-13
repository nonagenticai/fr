// boardField — a missing field is `null` + a `board_custom_field_missing`
// warning, so the caller SKIPS the write (v4 ruling 12, George 2026-10-13).
// The board-read/write counting cases needed a stub PlankaClient and were
// removed under the no-test-doubles ruling.

import { describe, expect, test } from 'bun:test';
import { spyOn } from 'bun:test';
import { BOARD_FIELD_MISSING_TELEMETRY, boardField } from './custom-fields';

const BOARD = 'board-1';

describe('boardField — a missing field is skipped with a warning', () => {
  test('absent field ⇒ null + one board_custom_field_missing warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = boardField(
        { Metadata: { groupId: 'g', fieldIds: { card_type: 'f1' } } },
        { boardId: BOARD, cardId: 'c1', group: 'Metadata', field: 'priority', context: 'test' },
      );
      expect(got).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(warn.mock.calls[0]![0]));
      expect(line).toMatchObject({
        telemetry: BOARD_FIELD_MISSING_TELEMETRY,
        board_id: BOARD,
        card_id: 'c1',
        group: 'Metadata',
        field: 'priority',
        context: 'test',
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('present field ⇒ ids, no warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        boardField(
          { Metadata: { groupId: 'g', fieldIds: { priority: 'f1' } } },
          { boardId: BOARD, group: 'Metadata', field: 'priority', context: 'test' },
        ),
      ).toEqual({ groupId: 'g', fieldId: 'f1' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
