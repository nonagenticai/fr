// Unit tests for E-7 Telegram channel.parseWebhook.
//
// Asserts the back-compat hinge: legacy approval-callback shapes, `/start`
// registration, and bot senders all return null (so routes/telegram-webhook.ts
// still owns them), while free-text non-approval messages return a populated
// InboundMessage for the conversational agent path.

import { test, expect, describe } from 'bun:test';

import { telegramChannel } from '../../../src/channels/telegram';

const APPROVAL_ID = '123e4567-e89b-12d3-a456-426614174000';

/** Build a Telegram Bot-API `Update` request. */
function updateReq(message: Record<string, unknown>): Request {
  return new Request('https://fr.test/api/webhooks/telegram/incoming', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message }),
  });
}

const FROM = { id: 7619636015, is_bot: false, first_name: 'George', username: 'georgejersey' };
const CHAT = { id: 7619636015, type: 'private' };

describe('telegramChannel.parseWebhook', () => {
  test('returns null when message body contains [ApprovalId:...]', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({ from: FROM, chat: CHAT, text: `approve [ApprovalId:${APPROVAL_ID}]` }),
    );
    expect(result).toBeNull();
  });

  test('returns null when the QUOTED (reply_to) text contains [ApprovalId:...]', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({
        from: FROM,
        chat: CHAT,
        text: '1',
        reply_to_message: { text: `Please approve [ApprovalId:${APPROVAL_ID}]` },
      }),
    );
    expect(result).toBeNull();
  });

  test('returns null for bare decision keywords (legacy approval path)', async () => {
    for (const text of ['1', 'approve', 'yes', 'ok', '2 not now', 'reject because']) {
      const result = await telegramChannel.parseWebhook(
        updateReq({ from: FROM, chat: CHAT, text }),
      );
      expect(result).toBeNull();
    }
  });

  // Round 5 (2026-10-02): with CHANNEL_DISPATCH_ENABLED=true these reached the agent,
  // because this file kept its own keyword list. It now delegates to the approval handler's
  // `looksLikeApprovalTraffic`, so every form the handler reads stays with the handler.
  test('returns null for every decision form the approval handler reads (one predicate)', async () => {
    for (const text of ['1.', 'Approve!', 'Approve 👍', '1 #abcd1234', '#abcd1234 1', '2 - Reject?']) {
      const result = await telegramChannel.parseWebhook(updateReq({ from: FROM, chat: CHAT, text }));
      expect(result).toBeNull();
    }
  });

  // 2026-10-31: the `[AnswerFor:…]` tag lived ONLY on the answer/confirm question the
  // Telegram seat used to ask, and that whole state machine is deleted (owner ruling: every
  // channel runs the same flow and no channel keeps reply state — migration 223 drops the
  // table, `channel-reply.ts` no longer reads the tag). Nothing emits it any more, so a
  // Reply to one of those old messages is ordinary text and is offered to the agent
  // dispatcher like any other — it is NOT claimed by the approval flow.
  test('a Reply to a deleted-question ([AnswerFor:…]) message is ordinary text, not approval traffic', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({
        from: FROM,
        chat: CHAT,
        text: 'ship it on Monday',
        reply_to_message: { text: `Nothing recorded yet…\n\n[AnswerFor:${APPROVAL_ID}]` },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.text).toBe('ship it on Monday');
  });

  test('control: ordinary chatter is still the agent\'s', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({ from: FROM, chat: CHAT, text: "hello bot, what's the status?" }),
    );
    expect(result).not.toBeNull();
  });

  test('returns null for /start and /register (legacy registration helper)', async () => {
    for (const text of ['/start', '/register', '/start@frn8n_bot']) {
      const result = await telegramChannel.parseWebhook(
        updateReq({ from: FROM, chat: CHAT, text }),
      );
      expect(result).toBeNull();
    }
  });

  test('returns null for a bot sender', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({ from: { ...FROM, is_bot: true }, chat: CHAT, text: 'project status' }),
    );
    expect(result).toBeNull();
  });

  test('returns an InboundMessage for a free-text conversational message', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({ from: FROM, chat: CHAT, text: 'project status' }),
    );

    expect(result).not.toBeNull();
    expect(result!.channel).toBe('telegram');
    expect(result!.address).toBe('7619636015');
    expect(result!.userId).toBe('7619636015');
    expect(result!.text).toBe('project status');
    expect(typeof result!.correlationId).toBe('string');
    expect(result!.correlationId.length).toBeGreaterThan(0);
  });

  test('returns an InboundMessage from an edited_message', async () => {
    const req = new Request('https://fr.test/api/webhooks/telegram/incoming', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 2,
        edited_message: { from: FROM, chat: CHAT, text: 'what is the project status' },
      }),
    });
    const result = await telegramChannel.parseWebhook(req);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('what is the project status');
  });

  test('returns null for a non-text update (e.g. channel_post / service message)', async () => {
    const result = await telegramChannel.parseWebhook(
      updateReq({ from: FROM, chat: CHAT }), // no text
    );
    expect(result).toBeNull();
  });

  test('returns null for malformed JSON', async () => {
    const req = new Request('https://fr.test/api/webhooks/telegram/incoming', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const result = await telegramChannel.parseWebhook(req);
    expect(result).toBeNull();
  });
});
