// Unit tests for the Telegram Bot-API `Update` envelope parser.
//
// Covers: message vs edited_message, reply_to quoted-text extraction (the
// primary [ApprovalId:…] anchor), bot-sender flagging, group vs DM chat ids,
// forum thread ids, and negative cases (no text / wrong shape).

import { test, expect, describe } from 'bun:test';

import { extractTelegramInbound, extractTelegramUpdateId, telegramBotIdFromToken } from '../../../src/channels/telegram-envelope';

describe('extractTelegramInbound', () => {
  test('parses a plain message with reply_to quoted text', () => {
    const out = extractTelegramInbound({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 12345, is_bot: false, username: 'george' },
        chat: { id: -1001234567890, type: 'supergroup', is_forum: true },
        date: 1700000000,
        text: '1',
        reply_to_message: { text: '🔔 Approval Required [ApprovalId:abc]' },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.senderTelegramId).toBe('12345');
    expect(out!.isBot).toBe(false);
    expect(out!.messageText).toBe('1');
    expect(out!.quotedText).toBe('🔔 Approval Required [ApprovalId:abc]');
    expect(out!.chatId).toBe('-1001234567890');
    expect(out!.username).toBe('george');
  });

  test('parses edited_message the same way', () => {
    const out = extractTelegramInbound({
      update_id: 2,
      edited_message: {
        from: { id: 999, is_bot: false },
        chat: { id: 999, type: 'private' },
        text: '2 changed my mind',
      },
    });
    expect(out).not.toBeNull();
    expect(out!.senderTelegramId).toBe('999');
    expect(out!.messageText).toBe('2 changed my mind');
    expect(out!.chatId).toBe('999');
  });

  test('captures forum thread id', () => {
    const out = extractTelegramInbound({
      message: {
        from: { id: 7, is_bot: false },
        chat: { id: -100777, type: 'supergroup' },
        message_thread_id: 42,
        text: 'hi',
      },
    });
    expect(out!.threadId).toBe(42);
  });

  test('flags bot senders', () => {
    const out = extractTelegramInbound({
      message: {
        from: { id: 8842098689, is_bot: true, username: 'frn8n_bot' },
        chat: { id: -100777, type: 'supergroup' },
        text: 'echo',
      },
    });
    expect(out!.isBot).toBe(true);
  });

  test('returns null when message has no text', () => {
    expect(
      extractTelegramInbound({
        message: { from: { id: 1, is_bot: false }, chat: { id: 1, type: 'private' } },
      }),
    ).toBeNull();
  });

  test('returns null for a non-message update (e.g. channel_post)', () => {
    expect(extractTelegramInbound({ update_id: 5, channel_post: { text: 'x' } })).toBeNull();
  });

  test('returns null for a malformed body', () => {
    expect(extractTelegramInbound({ foo: 'bar' })).toBeNull();
    expect(extractTelegramInbound(null)).toBeNull();
    expect(extractTelegramInbound('not an object')).toBeNull();
  });
});

describe('extractTelegramUpdateId', () => {
  test('reads update_id from any update body, including one with no text', () => {
    expect(extractTelegramUpdateId({ update_id: 42, message: { photo: [] } })).toBe(42);
    expect(extractTelegramUpdateId({ update_id: 0 })).toBe(0);
  });
  test('absent or malformed → undefined (nothing to dedup on)', () => {
    for (const body of [null, 'x', {}, { update_id: '42' }, { update_id: -1 }, { update_id: 1.5 }]) {
      expect(extractTelegramUpdateId(body)).toBeUndefined();
    }
  });
});

describe('extractTelegramInbound — forwards (never laya-read)', () => {
  const base = { from: { id: 1, is_bot: false }, chat: { id: 1, type: 'private' }, text: 'approved' };
  test('a plain message is not a forward', () => {
    expect(extractTelegramInbound({ message: base })!.isForwarded).toBe(false);
  });
  for (const field of [
    { forward_origin: { type: 'user', date: 1 } },
    { forward_from: { id: 2 } },
    { forward_from_chat: { id: -3 } },
    { forward_sender_name: 'x' },
    { forward_date: 1_700_000_000 },
  ]) {
    test(`${Object.keys(field)[0]} marks a forward`, () => {
      expect(extractTelegramInbound({ message: { ...base, ...field } })!.isForwarded).toBe(true);
    });
  }
});

describe('extractTelegramInbound — the replied-to message (laya allowlist input)', () => {
  const base = { from: { id: 1, is_bot: false }, chat: { id: -100, type: 'supergroup' }, text: 'agreed' };
  test('no reply ⇒ replyTo undefined', () => {
    expect(extractTelegramInbound({ message: base })!.replyTo).toBeUndefined();
  });
  test('carries the quoted sender, its bot flag and message id', () => {
    const r = extractTelegramInbound({
      message: { ...base, reply_to_message: { message_id: 505, from: { id: 42, is_bot: true }, text: 'x' } },
    })!.replyTo;
    expect(r).toEqual({ messageId: 505, fromId: 42, fromIsBot: true, isForwarded: false });
  });
  test('a quoted message without `from` is not a bot message', () => {
    const r = extractTelegramInbound({ message: { ...base, reply_to_message: { message_id: 7, text: 'x' } } })!.replyTo;
    expect(r).toEqual({ messageId: 7, fromId: undefined, fromIsBot: false, isForwarded: false });
  });
  for (const field of [
    { forward_origin: { type: 'user', date: 1 } },
    { forward_from: { id: 2 } },
    { forward_from_chat: { id: -3 } },
    { forward_sender_name: 'x' },
    { forward_date: 1_700_000_000 },
  ]) {
    test(`a quoted message carrying ${Object.keys(field)[0]} is a forward`, () => {
      const r = extractTelegramInbound({
        message: { ...base, reply_to_message: { message_id: 9, from: { id: 42, is_bot: true }, text: 'x', ...field } },
      })!.replyTo;
      expect(r?.isForwarded).toBe(true);
    });
  }
});

describe('telegramBotIdFromToken', () => {
  test('the numeric prefix of a Bot-API token', () => {
    expect(telegramBotIdFromToken('7100200300:AAtest_token-x')).toBe(7100200300);
  });
  for (const bad of ['', '   ', 'nocolon', ':abc', 'abc:def', '12:', '0:abc', undefined, null]) {
    test(`${JSON.stringify(bad)} ⇒ null (not proven)`, () => {
      expect(telegramBotIdFromToken(bad as string | null | undefined)).toBeNull();
    });
  }
});
