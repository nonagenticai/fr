// src/domain/engagement/adapters/telegram.ts
// Telegram Bot-API adapter — sends approval notifications + generic channel
// messages via a dedicated bot (frn8n_bot). It replaced the signal-cli adapter
// in the Telegram cutover: a bot token never needs the linked-device resync that
// made Signal fragile. It mirrors the old SignalAdapter contract 1:1 so the
// channel-agnostic `[ApprovalId:…]` tag + `1/2/3` decision keywords are
// preserved end-to-end.
import { config } from '../../../config';
import type {
  NotificationChannel,
  ApprovalWithDetails,
  ChannelMessage,
  SendResult,
} from '../notifications';
import { tryGetRequestContext } from '../../../integrations/_lib/context';
import { db, projects, telegramForumTopics } from '../../../db/client';
import { eq, and } from 'drizzle-orm';
import {
  APPROVAL_NOTIFICATION_MARK,
  approvalNotificationParts,
  approveAllContentLines,
  clip,
  containsApprovalNotificationText,
  isApprovalNotificationText,
  moreItemsLine,
  renderApprovalParts,
  type ApprovalMessageParts,
  FOOTER_ANSWER_ANNOTATIONS,
  FOOTER_ANSWER_PLACEHOLDER,
  FOOTER_APPROVE_ANNOTATIONS,
  FOOTER_NOTE_ACCEPTS_BLOCKED,
  FOOTER_NOTE_ACCEPTS_PROPOSED,
  FOOTER_NOTE_ANSWER_IN_ONE_GO,
  FOOTER_NOTE_ANSWER_OTHER,
  frApprovalUrl,
} from '../approval-menu';
import { isUuidShape } from '../../../lib/uuid-shape';
import { isPlatformTenant } from '../../../middleware/internal-tenant-only';

// The answer PLACEHOLDER and the annotation lists live with the menu that writes them
// (domain/engagement/approval-menu.ts) and are re-exported here for the seats that import
// them from this adapter. ⛔ They are NOT declared here: the shared reply flow strips a
// pasted-back menu echo using them, so the strings and the menu that writes them must be one
// definition — an adapter is a transport, not the owner of the menu's vocabulary.
export {
  APPROVAL_NOTIFICATION_MARK,
  containsApprovalNotificationText,
  isApprovalNotificationText,
  moreItemsLine,
  FOOTER_ANSWER_ANNOTATIONS,
  FOOTER_ANSWER_PLACEHOLDER,
  FOOTER_APPROVE_ANNOTATIONS,
  FOOTER_NOTE_ACCEPTS_BLOCKED,
  FOOTER_NOTE_ANSWER_IN_ONE_GO,
  FOOTER_NOTE_ACCEPTS_PROPOSED,
  FOOTER_NOTE_ANSWER_OTHER,
  frApprovalUrl,
};

// DB reads/writes for the forum-topics feature.
// The cached forum topic id for a (chat, project), or null if not yet created.
async function getProjectTopic(chatId: string, projectKey: string): Promise<number | null> {
  const rows = await db
    .select({ message_thread_id: telegramForumTopics.message_thread_id })
    .from(telegramForumTopics)
    .where(and(eq(telegramForumTopics.chat_id, chatId), eq(telegramForumTopics.project_key, projectKey)));
  return rows[0]?.message_thread_id ?? null;
}

// Persist a newly-created topic; idempotent under the (chat, project) unique
// constraint so a concurrent creator doesn't error.
async function saveProjectTopic(chatId: string, projectKey: string, threadId: number, topicName: string): Promise<void> {
  await db
    .insert(telegramForumTopics)
    .values({ chat_id: chatId, project_key: projectKey, message_thread_id: threadId, topic_name: topicName })
    .onConflictDoNothing();
}

// Project display name → the forum topic name. Null if the project is gone.
async function getProjectName(projectId: string): Promise<string | null> {
  const rows = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
  return rows[0]?.name ?? null;
}

/** Telegram's Bot-API cap on one `sendMessage` text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** The notification blocks (domain/engagement/approval-menu.ts), rendered under Telegram's cap. */
export type TelegramMessageParts = ApprovalMessageParts;

/**
 * Render a Telegram message that never exceeds `limit` (Telegram REJECTS a longer text,
 * so an over-long approval would simply never arrive). Order of sacrifice: content items
 * from the end (replaced by an exact `… +N more (see fr)`), then the description (cut with
 * "…"). The footer — reply instructions, fr link, `[ApprovalId:…]` tag — is never cut: a
 * message without its tag cannot be decided by reply at all.
 */
export function capTelegramMessage(parts: TelegramMessageParts, limit: number = TELEGRAM_MAX_MESSAGE_LENGTH): string {
  const n = parts.items?.lines.length ?? 0;
  for (let shown = n; shown >= 0; shown--) {
    const text = renderApprovalParts(parts, parts.description, shown);
    if (text.length <= limit) return text;
  }
  const without = renderApprovalParts(parts, '', 0);
  const room = limit - without.length - 2; // the "\n\n" that joins the description block
  if (room >= 2) {
    const text = renderApprovalParts(parts, clip(parts.description, room), 0);
    if (text.length <= limit) return text;
  }
  if (without.length <= limit) return without;
  const footer = parts.footer.join('\n');
  // Pathological (a footer alone over the cap): keep the END, which holds the tag.
  return footer.length <= limit ? footer : footer.slice(footer.length - limit);
}

/** A Telegram chat/user id is an integer (DM user ids are positive, supergroup
 * ids are negative `-100…`). When a per-user pref `address` matches this, it is
 * itself a valid `chat_id`; otherwise we fall back to the configured group. */
function isTelegramChatId(address: string): boolean {
  return /^-?\d+$/.test(address.trim());
}

export class TelegramAdapter implements NotificationChannel {
  name = 'telegram';

  private apiUrl: string;
  private botToken: string;
  private defaultChatId: string;

  constructor() {
    this.apiUrl = config.services.telegram.apiUrl;
    this.botToken = config.services.telegram.botToken;
    this.defaultChatId = config.services.telegram.chatId;
  }

  /** Resolve the outbound `chat_id`: a numeric per-user address is a DM/chat
   * target the user registered; anything else routes to the group default. */
  private resolveChatId(address: string): string {
    if (address && isTelegramChatId(address)) return address;
    return this.defaultChatId;
  }

  async send(
    approval: ApprovalWithDetails,
    recipientAddress: string,
  ): Promise<SendResult> {
    if (!this.botToken) {
      return { success: false, error: 'channel-disabled' };
    }
    // ⛔ STRICT TENANT SEPARATION. The default chat and its per-project forum
    // topics are the OPERATOR's seat. Only a platform tenant's approval may go
    // there; a customer approval (or one with no tenant — fail closed) goes ONLY
    // to the recipient's own numeric DM address, and is not sent otherwise.
    const operatorSeatAllowed = isPlatformTenant(approval.tenant_id);
    let chatId = operatorSeatAllowed
      ? this.resolveChatId(recipientAddress)
      : isTelegramChatId(recipientAddress ?? '')
        ? recipientAddress.trim()
        : '';
    if (!chatId) {
      return { success: false, error: 'channel-disabled' };
    }
    // Topic-per-project: when enabled and this approval belongs to a project,
    // post into the forum supergroup's per-project topic instead of the
    // recipient's DM, so approvals are organized by project. Falls back to the
    // resolved chat (no thread) if topic resolution fails — never blocks a send.
    let threadId: number | undefined;
    if (
      operatorSeatAllowed &&
      config.services.telegram.useTopics &&
      approval.project_id &&
      this.defaultChatId
    ) {
      const resolved = await this.resolveProjectTopic(approval.project_id, this.defaultChatId);
      if (resolved !== null) {
        chatId = this.defaultChatId;
        threadId = resolved;
      }
    }
    const content = await this.approveAllContent(approval);
    const message = this.formatMessage(approval, content);
    // ⛔ NO force_reply, deliberately (tried and removed after review, 2026-10-01). In a
    // group it opens a reply to the notification on EVERY member's client, so their next
    // unrelated message quotes the tag and reads as a decision; in a DM with two pending
    // notifications it pre-targets the NEWEST, so a `1` meant for the older one decides
    // the newer one and skips the untagged path's refuse-when-ambiguous rule.
    return this.postToTelegram(chatId, message, threadId);
  }

  /**
   * Resolve the forum topic id for a project in `chatId`, creating it (named
   * after the project) on first use and caching the mapping. Returns null if
   * the project name can't be resolved or topic creation fails (caller then
   * posts to the chat root). Re-reads after insert so a concurrent creator's
   * topic wins deterministically.
   */
  private async resolveProjectTopic(projectId: string, chatId: string): Promise<number | null> {
    try {
      const cached = await getProjectTopic(chatId, projectId);
      if (cached !== null) return cached;

      const name = await getProjectName(projectId);
      if (!name) return null;

      const threadId = await this.createForumTopic(chatId, name);
      if (threadId === null) return null;

      await saveProjectTopic(chatId, projectId, threadId, name);
      // Re-read: if a concurrent send created+cached one first, prefer it.
      const persisted = await getProjectTopic(chatId, projectId);
      return persisted ?? threadId;
    } catch (err) {
      console.error(
        `[telegram] resolveProjectTopic failed project=${projectId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** Create a Telegram forum topic; returns its message_thread_id or null. */
  private async createForumTopic(chatId: string, name: string): Promise<number | null> {
    if (!this.botToken) return null;
    try {
      const response = await fetch(`${this.apiUrl}/bot${this.botToken}/createForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Telegram caps forum topic names at 128 chars.
        body: JSON.stringify({ chat_id: chatId, name: name.slice(0, 128) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        console.error(`[telegram] createForumTopic ${response.status}: ${(await response.text()).slice(0, 200)}`);
        return null;
      }
      const out = (await response.json()) as { result?: { message_thread_id?: number } };
      const id = out?.result?.message_thread_id;
      return typeof id === 'number' ? id : null;
    } catch (err) {
      console.error(`[telegram] createForumTopic threw: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Send a plain text message to a chat. Legacy-style boolean-ish helper used
   * by the Telegram webhook handler for decision confirmations. Mirrors
   * SignalAdapter.sendText.
   */
  /**
   * `sendText`, returning Telegram's send result (its `metadata.date` is Telegram's clock
   * for when the message was posted). Used where the caller must order a later inbound
   * message against this one on the SAME clock.
   */
  async sendTextDetailed(recipientAddress: string, message: string, messageThreadId?: number): Promise<SendResult> {
    if (!this.botToken) return { success: false, error: 'channel-disabled' };
    const chatId = this.resolveChatId(recipientAddress);
    if (!chatId) return { success: false, error: 'channel-disabled' };
    return this.postToTelegram(chatId, message, messageThreadId);
  }

  async sendText(recipientAddress: string, message: string, messageThreadId?: number): Promise<boolean> {
    if (!this.botToken) return false;
    const chatId = this.resolveChatId(recipientAddress);
    if (!chatId) return false;
    // `messageThreadId`: the forum topic the human wrote in, so a reply to a decision
    // typed in a project topic lands in that topic and not in the group's General.
    const result = await this.postToTelegram(chatId, message, messageThreadId);
    return result.success;
  }

  /**
   * Generic ChannelMessage transport (E-6). Renders a plain-text body per kind
   * and forwards through the Bot API. Same kind-validation contract as Signal.
   */
  /** Where `sendMessage(address, …)` posts (NotificationChannel.locate): the resolved chat,
   * never a forum topic — the same `chatId` / `messageThreadId` keys postToTelegram records. */
  locate(address: string): Record<string, unknown> | null {
    const chatId = this.resolveChatId(address);
    return chatId ? { chatId, messageThreadId: null } : null;
  }

  async sendMessage(address: string, message: ChannelMessage): Promise<SendResult> {
    if (!this.botToken) {
      return { success: false, error: 'channel-disabled' };
    }
    const chatId = this.resolveChatId(address);
    if (!chatId) {
      return { success: false, error: 'channel-disabled' };
    }

    switch (message.kind) {
      case 'approval-request': {
        const approvalId = message.meta?.approvalId;
        if (typeof approvalId !== 'string' || approvalId.length === 0) {
          return { success: false, error: 'approval-request kind requires meta.approvalId' };
        }
        break;
      }
      case 'action-result':
      case 'action-error': {
        const actionId = message.meta?.actionId;
        if (typeof actionId !== 'string' || actionId.length === 0) {
          return { success: false, error: `${message.kind} kind requires meta.actionId` };
        }
        break;
      }
      case 'text':
        break;
    }

    const correlationId = message.correlationId
      || tryGetRequestContext()?.correlationId
      || '';

    const body = formatChannelMessageForTelegram(message, correlationId);
    return this.postToTelegram(chatId, body);
  }

  /**
   * POST to the Bot API `sendMessage`, retrying on 429 (`retry_after`) and 5xx
   * with bounded backoff — Telegram rate-limits per chat (~1 msg/s). Never
   * throws: transport failures return `{ success: false, error }`.
   */
  private async postToTelegram(chatId: string, text: string, messageThreadId?: number): Promise<SendResult> {
    const url = `${this.apiUrl}/bot${this.botToken}/sendMessage`;
    const maxAttempts = 4;
    // WHERE the message was aimed, recorded on FAILED sends too: a timeout / 5xx after
    // Telegram accepted the message still put it in front of the human, and the
    // untagged-reply guard (lib/untagged-reply-guard.ts) must see it at that location.
    const aimedAt = { chatId, messageThreadId: typeof messageThreadId === 'number' ? messageThreadId : null };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(typeof messageThreadId === 'number' ? { message_thread_id: messageThreadId } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const result = await response.json() as {
            ok?: boolean;
            result?: { message_id?: number; date?: number };
          };
          return {
            success: true,
            metadata: {
              messageId: result?.result?.message_id,
              date: result?.result?.date,
              chatId,
              // ALWAYS recorded (null when there is no topic) so an untagged reply can be
              // matched to the forum topic the approval was posted in. The KEY's presence
              // is what marks a row as written by this code: rows from before it carry no
              // thread information and are never eligible for an untagged bind
              // (telegram-webhook findEligibleUnquotedApprovals).
              messageThreadId: typeof messageThreadId === 'number' ? messageThreadId : null,
            },
          };
        }

        // Retry on rate-limit / transient server errors; surface 4xx otherwise.
        if (response.status === 429 || response.status >= 500) {
          const errorText = await response.text();
          if (attempt < maxAttempts - 1) {
            const retryAfter = parseRetryAfter(errorText);
            const backoffMs = retryAfter ?? Math.min(400 * (attempt + 1), 3000);
            await Bun.sleep(backoffMs);
            continue;
          }
          return { success: false, error: `Telegram API ${response.status}: ${errorText.slice(0, 256)}`, metadata: aimedAt };
        }

        const errorText = await response.text();
        return { success: false, error: `Telegram API ${response.status}: ${errorText.slice(0, 256)}`, metadata: aimedAt };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts - 1) {
          await Bun.sleep(Math.min(400 * (attempt + 1), 3000));
          continue;
        }
        return { success: false, error: msg, metadata: aimedAt };
      }
    }

    return { success: false, error: 'Telegram API: exhausted retries', metadata: aimedAt };
  }

  /**
   * The content a human judges before approving ALL from chat (ruling 2026-10-02) — rendered
   * by the SHARED module so every channel that offers `Reply 1 to approve ALL` shows the
   * same items (domain/engagement/approval-menu.ts).
   */
  private async approveAllContent(approval: ApprovalWithDetails): Promise<TelegramMessageParts['items'] | null> {
    if (approval.status !== 'pending') return null;
    return approveAllContentLines(approval);
  }

  private formatMessage(approval: ApprovalWithDetails, content: TelegramMessageParts['items'] | null = null): string {
    // The SAME notification every channel sends (domain/engagement/approval-menu.ts), under
    // Telegram's 4096-character cap.
    return capTelegramMessage(approvalNotificationParts(approval, content, 'telegram'));
  }
}

/** Parse Telegram's `parameters.retry_after` (seconds) out of an error body. */
function parseRetryAfter(errorText: string): number | null {
  try {
    const parsed = JSON.parse(errorText) as { parameters?: { retry_after?: number } };
    const seconds = parsed?.parameters?.retry_after;
    if (typeof seconds === 'number' && seconds > 0) {
      return Math.min(seconds * 1000, 10000);
    }
  } catch {
    // not JSON — fall back to default backoff
  }
  return null;
}

/**
 * Render a ChannelMessage as a Telegram plain-text body. Always ends with a
 * `[cid:<correlationId>]` tag so inbound replies can be matched back to the
 * originating action/approval. Mirrors formatChannelMessageForSignal.
 */
function formatChannelMessageForTelegram(message: ChannelMessage, correlationId: string): string {
  const cidTag = correlationId ? `\n\n[cid:${correlationId}]` : '';

  switch (message.kind) {
    case 'text':
      return `${message.text}${cidTag}`;
    case 'action-result':
      return `✓ ${message.text}${cidTag}`;
    case 'action-error':
      return `✗ ${message.text}${cidTag}`;
    case 'approval-request': {
      const approvalId = typeof message.meta?.approvalId === 'string'
        ? message.meta.approvalId as string
        : '';
      const tag = approvalId ? `\n\n[ApprovalId:${approvalId}]` : '';
      return `${APPROVAL_NOTIFICATION_MARK} ${message.text}${tag}${cidTag}`;
    }
    default: {
      const _never: never = message;
      void _never;
      return cidTag;
    }
  }
}

export const telegramAdapter = new TelegramAdapter();
