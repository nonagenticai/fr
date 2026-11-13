// tests/unit/services/planka-custom-field-length.test.ts
//
// Issue #904. Planka caps a customFieldValue at 512 chars —
// `server/api/controllers/custom-field-values/create-or-update.js` declares
// `content: { type: 'string', maxLength: 512, required: true }`, confirmed
// against the live endpoint: 513 chars -> HTTP 400 "Value was -1 characters
// longer than the configured maximum length (512)", 512 -> HTTP 200.
//
// `setCardCustomFieldValue` PATCHed `content` with no guard, and it is the live
// producer of the `criterion_*` fields the n8n router and its consumers
// (`todo_pickup`, `blocked_handler`) read. One over-long criterion 400'd the
// whole PATCH, leaving the card with NO metadata.
//
// fr#1494: the guard REFUSES by default (typed 422, nothing sent) — a value cut
// to fit looks complete and is not, and for a JSON-valued field it is corrupt.
// Only an explicitly opted-in HUMAN-TEXT field (`truncateHumanText`, the
// criterion_* slots and block_reason) is truncated, and never silently.

import { test, expect, describe } from 'bun:test';

import {
  boundCustomFieldContent,
  CUSTOM_FIELD_CONTENT_TOO_LONG,
  CustomFieldContentTooLongError,
  PLANKA_CUSTOM_FIELD_MAX_CHARS,
} from '../../../src/services/planka/custom-fields';

const CARD = 'card-1';
const FIELD = 'field-1';

/** An opted-in human-text field (criterion_* / block_reason). */
const bound = (content: string): string =>
  boundCustomFieldContent({ cardId: CARD, customFieldId: FIELD, content, truncateHumanText: true });

/** The default: every other field. */
const strict = (content: string): string =>
  boundCustomFieldContent({ cardId: CARD, customFieldId: FIELD, content });

function refusal(fn: () => unknown): CustomFieldContentTooLongError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CustomFieldContentTooLongError);
    return e as CustomFieldContentTooLongError;
  }
  throw new Error('expected a CustomFieldContentTooLongError');
}

describe('fr#1494 — the DEFAULT refuses an over-long value; it never truncates', () => {
  test('512 is written untouched', () => {
    const at = 'a'.repeat(512);
    expect(strict(at)).toBe(at);
  });

  test('513 is REFUSED with a typed 422 naming the field and the size', () => {
    const e = refusal(() => strict('a'.repeat(513)));
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe(CUSTOM_FIELD_CONTENT_TOO_LONG);
    expect(e.cardId).toBe(CARD);
    expect(e.customFieldId).toBe(FIELD);
    expect(e.attemptedChars).toBe(513);
  });

  test('a JSON-valued field is refused, never cut into unparseable JSON', () => {
    const json = JSON.stringify({ ref: 'x'.repeat(600) });
    refusal(() => strict(json));
  });

  test('truncateHumanText: false is the default, not an opt-in', () => {
    refusal(() =>
      boundCustomFieldContent({ cardId: CARD, customFieldId: FIELD, content: 'a'.repeat(513), truncateHumanText: false }),
    );
  });

});

describe('opted-in human text: nothing is written that Planka would reject', () => {
  test('the cap matches the one Planka actually enforces', () => {
    expect(PLANKA_CUSTOM_FIELD_MAX_CHARS).toBe(512);
  });

  test('exactly 512 is passed through untouched — 512 returns HTTP 200', () => {
    const at = 'a'.repeat(512);
    expect(bound(at)).toBe(at);
  });

  test('513 — the measured 400 — is brought within the cap', () => {
    // The exact boundary from the issue. Off-by-one here IS the bug.
    expect(bound('a'.repeat(513)).length).toBeLessThanOrEqual(512);
  });

  test('a grossly over-length value is still within the cap', () => {
    expect(bound('a'.repeat(50_000)).length).toBeLessThanOrEqual(512);
  });
});

describe('opted-in human text: a truncation is never silent', () => {
  test('the written value says it was truncated', () => {
    expect(bound('a'.repeat(600))).toContain('truncated');
  });

  test('an untruncated value is NOT marked', () => {
    // The negative control: marking everything would be as misleading as
    // marking nothing.
    expect(bound('short value')).toBe('short value');
  });
});

describe('opted-in human text: truncation does not corrupt the text', () => {
  test('it does not sever a surrogate pair', () => {
    // 🙂 is non-BMP: .length 2. A naive slice can cut between the halves and
    // write a lone surrogate — half an emoji, valid length, mojibake content.
    // Build a string whose cut lands mid-pair for a range of budgets.
    for (let pad = 0; pad < 8; pad++) {
      const content = 'a'.repeat(495 + pad) + '🙂'.repeat(40);
      const out = bound(content);
      expect(out.length).toBeLessThanOrEqual(512);
      // No unpaired surrogate anywhere in the result.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
    }
  });

  test('the surviving prefix is a real prefix of the original', () => {
    const content = 'x'.repeat(400) + 'y'.repeat(400);
    const out = bound(content);
    const body = out.slice(0, out.indexOf('…'));
    expect(content.startsWith(body)).toBe(true);
  });
});
