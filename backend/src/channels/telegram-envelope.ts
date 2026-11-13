// Shared parser for inbound Telegram webhook bodies (Bot API `Update`).
//
// The frn8n bot reaches fr either directly or (default) forwarded verbatim by
// an n8n `telegram-incoming` webhook → fr `POST /api/webhooks/telegram/incoming`.
// Either way the body is a standard Telegram `Update`:
//
//   { update_id, message: { message_id, from: { id, is_bot, username? },
//     chat: { id, type }, text?, message_thread_id?,
//     reply_to_message?: { text? } } }
//
// We accept `message` and `edited_message` (a user editing their `1/2/3` reply
// should still register). `channel_post` and non-text updates are ignored
// (return null) so the route acks 200 without acting.
//
// `extractTelegramInbound` returns a flat shape the webhook handler can use
// without knowing the Bot-API envelope details — the Telegram analog of
// channel-envelope parsers.

import { z } from 'zod';

const FromSchema = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});

const MessageSchema = z.object({
  message_id: z.number().optional(),
  from: FromSchema.optional(),
  chat: z
    .object({
      id: z.number(),
      type: z.string().optional(),
      is_forum: z.boolean().optional(),
    })
    .optional(),
  date: z.number().optional(),
  text: z.string().optional(),
  message_thread_id: z.number().optional(),
  // The replied-to message: its sender and forward fields are what prove (or refute) that
  // a Reply quotes the bot's OWN notification (`ReplyToMessage`).
  reply_to_message: z
    .object({
      text: z.string().optional(),
      message_id: z.number().optional(),
      from: FromSchema.optional(),
      forward_origin: z.unknown().optional(),
      forward_from: z.unknown().optional(),
      forward_from_chat: z.unknown().optional(),
      forward_sender_name: z.unknown().optional(),
      forward_date: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
  // Bot API 7.0: a reply to a message in ANOTHER chat/topic, and a partial quote.
  external_reply: z.unknown().optional(),
  quote: z.unknown().optional(),
  // A FORWARDED message: Bot API 7.0 `forward_origin`, and the legacy fields older
  // forwarders still send. Any one of them marks the text as someone else's words.
  forward_origin: z.unknown().optional(),
  forward_from: z.unknown().optional(),
  forward_from_chat: z.unknown().optional(),
  forward_sender_name: z.unknown().optional(),
  forward_date: z.unknown().optional(),
});

type ForwardFields = {
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: unknown;
  forward_date?: unknown;
};

/** Any Bot-API forward field (7.0 `forward_origin`, or a legacy one) marks a forward. */
function hasForwardField(m: ForwardFields): boolean {
  return (
    m.forward_origin !== undefined ||
    m.forward_from !== undefined ||
    m.forward_from_chat !== undefined ||
    m.forward_sender_name !== undefined ||
    m.forward_date !== undefined
  );
}

/**
 * The message a Reply quotes, as far as fr needs it to decide whether that message is the
 * bot's OWN approval notification: who sent it, whether it was itself a forward, and its id
 * in the chat (which fr recorded at send time in `engagement_deliveries.metadata_json`).
 */
export interface ReplyToMessage {
  messageId: number | undefined;
  /** `from.id` of the quoted message's sender, when present. */
  fromId: number | undefined;
  fromIsBot: boolean;
  /** The quoted message is itself a forward (a bot's message forwarded is not its send). */
  isForwarded: boolean;
}

/**
 * The numeric bot id is the part of a Bot-API token before the `:` (`<bot_id>:<secret>`,
 * Telegram's documented token format). null when the token is empty or not in that format:
 * fr then cannot prove a quoted message is its own, and nothing relies on it (fail closed).
 */
export function telegramBotIdFromToken(token: string | null | undefined): number | null {
  const m = typeof token === 'string' ? /^(\d{1,20}):[A-Za-z0-9_-]+$/.exec(token.trim()) : null;
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const UpdateSchema = z.object({
  update_id: z.number().optional(),
  message: MessageSchema.optional(),
  edited_message: MessageSchema.optional(),
});

export interface ExtractedTelegramInbound {
  /** Numeric Telegram user id of the sender, as a string (used as the
   * `user_channel_prefs.address` key for identity resolution). */
  senderTelegramId: string | undefined;
  /** `true` when the sender is itself a bot (the frn8n bot does not receive
   * its own sends, but n8n forwarders or other bots might appear here). */
  isBot: boolean;
  /** Message body text. */
  messageText: string | undefined;
  /** Quoted/replied-to text — the primary place an `[ApprovalId:…]` tag is
   * carried when a user taps "Reply" on the approval message. */
  quotedText: string | undefined;
  /** Chat the message arrived in (a `-100…` for the supergroup, or a positive
   * user id for a DM). */
  chatId: string | undefined;
  /** Forum-topic id, when the message was posted inside a topic. */
  threadId: number | undefined;
  /**
   * `true` when the chat is a forum supergroup (`chat.is_forum`). Only then is `threadId`
   * a TOPIC a reply may be posted into; in an ordinary group Telegram also sets
   * `message_thread_id` on reply chains, and sending into that is not a topic.
   */
  isForum: boolean;
  /** `@username` if the sender has one. */
  username: string | undefined;
  /**
   * `true` when the message replies to ANY other message — including a photo, sticker
   * or voice note that carries no `text` (so `quotedText` is undefined), an external
   * reply, or a quote. The forum-topic root (every topic message's implicit
   * `reply_to_message`, whose `message_id` equals `message_thread_id`) does NOT count.
   */
  isReplyToOther: boolean;
  /** `true` when this update is an `edited_message`, not a new message. */
  isEdited: boolean;
  /** Telegram's `date` (unix seconds) of the message, when present. */
  messageDate: number | undefined;
  /**
   * `true` when the message is a Telegram FORWARD (`forward_origin`, or any legacy
   * `forward_from` / `forward_from_chat` / `forward_sender_name` / `forward_date`): the text
   * is someone else's (often fr's own notification), never this sender's own answer.
   */
  isForwarded: boolean;
  /** The replied-to message (`reply_to_message`), when there is one. */
  replyTo: ReplyToMessage | undefined;
}

/**
 * The Bot-API `update_id` of ANY update body — including one `extractTelegramInbound`
 * returns null for (a photo, a service message). Used ONLY to label the webhook's failure
 * log, so a Telegram retry of the same update can be correlated — it is NOT a dedup key
 * (there is deliberately no update_id ledger; the decision is exactly-once via the UNIQUE
 * (approval_id, approver_id) index). `undefined` when absent or not a non-negative safe
 * integer (an n8n forwarder may strip it).
 */
export function extractTelegramUpdateId(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const id = (body as { update_id?: unknown }).update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/**
 * Parse a Telegram Bot-API `Update`. Returns `null` if the body has no usable
 * text message (e.g. a `channel_post`, a service message, or a malformed body).
 */
export function extractTelegramInbound(body: unknown): ExtractedTelegramInbound | null {
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return null;

  const msg = parsed.data.message ?? parsed.data.edited_message;
  if (!msg) return null;

  // A usable inbound message must carry text we can parse a decision from.
  if (typeof msg.text !== 'string' || msg.text.length === 0) return null;

  return {
    senderTelegramId: msg.from ? String(msg.from.id) : undefined,
    isBot: msg.from?.is_bot ?? false,
    messageText: msg.text,
    quotedText: msg.reply_to_message?.text,
    chatId: msg.chat ? String(msg.chat.id) : undefined,
    threadId: msg.message_thread_id,
    isForum: msg.chat?.is_forum === true,
    username: msg.from?.username,
    isReplyToOther:
      (msg.reply_to_message !== undefined &&
        !(msg.message_thread_id !== undefined && msg.reply_to_message.message_id === msg.message_thread_id)) ||
      msg.external_reply !== undefined ||
      msg.quote !== undefined,
    isEdited: !parsed.data.message && Boolean(parsed.data.edited_message),
    messageDate: msg.date,
    isForwarded: hasForwardField(msg),
    replyTo: msg.reply_to_message
      ? {
          messageId: msg.reply_to_message.message_id,
          fromId: msg.reply_to_message.from?.id,
          fromIsBot: msg.reply_to_message.from?.is_bot === true,
          isForwarded: hasForwardField(msg.reply_to_message),
        }
      : undefined,
  };
}
