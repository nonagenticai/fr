// src/routes/telegram-webhook.ts
// A TRANSPORT ADAPTER, and nothing else (owner ruling 2026-10-31: "all channels SAME flow!
// adapters only do the minimal work"). It authenticates the delivery, parses the Telegram
// Bot-API envelope, answers `/start` + `/register`, offers agent-addressable text to the
// channel dispatcher, and hands everything else to `domain/engagement/channel-reply.ts`
// (`runChannelTurn`) — the ONE reply→decision implementation, which no channel owns.
//
// Transport: Telegram posts DIRECTLY to this route (per the bot's getWebhookInfo); the old
// n8n `telegram-incoming` relay is not in the path. The bot's webhook `secret_token` is
// echoed in the `X-Telegram-Bot-Api-Secret-Token` header and validated below when set.
//
// Always returns 200 (Telegram retries non-2xx and disables a webhook that errors
// repeatedly).
import { jsonResponse } from '../utils/response';
import { config } from '../config';
import { DEFAULT_FR_PUBLIC_URL } from '../services/github-app-config';
import { isAuthorizedBySharedSecret } from '../utils/webhook-secret';
import { runChannelTurn, type Say } from '../domain/engagement/channel-reply';
import { telegramAdapter } from '../domain/engagement/adapters/telegram';
import {
  extractTelegramInbound,
  extractTelegramUpdateId,
  type ExtractedTelegramInbound,
} from '../channels/telegram-envelope';
import { channelDispatcher } from '../channels';

/**
 * POST /api/webhooks/telegram/incoming
 * Receives Telegram updates (directly or forwarded by n8n). Always returns 200.
 */
export async function handleTelegramIncoming(req: Request): Promise<Response> {
  // Validate the bot's secret token. Telegram sets this header on every webhook
  // delivery; an n8n forwarder passes it through verbatim.
  //
  // Two things changed here. The compare was a plain `!==`, which short-circuits
  // on the first mismatching byte and leaks the matching-prefix length to a
  // timing attacker. And an UNSET secret skipped the check entirely, so blanking
  // or rotating TELEGRAM_WEBHOOK_SECRET would silently open this receiver to
  // anyone who can reach it rather than breaking loudly. Both are now handled by
  // the shared helper, which fails closed in production.
  //
  // The 200 stays: Telegram retries non-2xx and disables a webhook that errors
  // repeatedly. Rejecting means "do not process this payload", not "answer 401".
  if (
    !isAuthorizedBySharedSecret({
      secret: config.services.telegram.webhookSecret,
      provided: req.headers.get('X-Telegram-Bot-Api-Secret-Token'),
      envVarName: 'TELEGRAM_WEBHOOK_SECRET',
      receiver: 'telegram-webhook',
    })
  ) {
    console.warn('[telegram-webhook] unauthenticated delivery — rejecting');
    return jsonResponse({ received: true }, 200);
  }

  // The E-7 dispatcher needs an unread body of its own (`Request.json()` consumes it), so
  // the copy is taken BEFORE this handler reads the body once for itself.
  const dispatchReq = req.clone() as unknown as Request;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ received: true });
  }

  // ── A TELEGRAM RETRY IS PROCESSED AGAIN — AND CAN NEVER DECIDE TWICE ─────────────────
  // Telegram re-delivers an update whenever it did not see a 2xx in time, and fr processes
  // it again from the top (as origin/main always did). There is deliberately NO update_id
  // dedup ledger: a claim-before-process ledger LOSES messages (a retryable 503 is retried
  // and found already claimed; a pod killed mid-request on every deploy — SIGTERM ->
  // process.exit — leaves a claim for an update never processed). What must be exactly-once
  // is the DECISION, and that is guaranteed by the UNIQUE (approval_id, approver_id) index
  // (migration 157) plus the FOR UPDATE re-check in the shared decide path. A retry may
  // repeat a chat reply; it cannot record a second decision. update_id is read only for the log.
  const updateId = extractTelegramUpdateId(body);

  // ── NO 5xx, EVER — AND NEVER A SILENT FAILURE EITHER ──────────────────────────────────
  // A throw past this point used to escape as a 500. Telegram then retried the update
  // (processing it again), and eventually disables a webhook that keeps erroring — while
  // the human heard nothing. So every throw is logged with the approval it concerned (when
  // one was resolved) and the sender is told, best effort, that the outcome is unknown; the
  // 200 keeps the webhook alive.
  const failure: FailureContext = { approvalId: null, say: null };
  try {
    return await processTelegramUpdate(body, dispatchReq, failure);
  } catch (err) {
    console.error(
      `[telegram-webhook] processing failed` +
        `${failure.approvalId ? ` for approval ${failure.approvalId}` : ''}` +
        `${updateId !== undefined ? ` (update_id ${updateId})` : ''}:`,
      err,
    );
    if (failure.say) {
      try {
        await failure.say(processingFailedMessage(failure.approvalId));
      } catch (sendErr) {
        console.error('[telegram-webhook] could not tell the sender about the failure:', sendErr);
      }
    }
    return jsonResponse({ received: true, failed: true });
  }
}

/** What the top-level catch knows about the update it is reporting on. */
type FailureContext = { approvalId: string | null; say: Say | null };

/** Told to the sender when processing threw: the outcome is UNKNOWN, so say exactly that. */
const PROCESSING_FAILED_MESSAGE = 'Something failed; nothing may have been recorded — check fr.';

/** The same, naming the approval once one was resolved (an untagged bind the human may not
 * know was made). Never "not recorded": a throw can come AFTER the decision committed (the
 * callback, a reply), so the outcome is unknown and the human is sent to fr to see it. */
function processingFailedMessage(approvalId: string | null): string {
  if (!approvalId) return PROCESSING_FAILED_MESSAGE;
  return `Something failed for #${approvalId.slice(0, 8)}; it may not have been recorded — ` +
    `check it in fr: ${frApprovalLink(approvalId)}`;
}

function frApprovalLink(approvalId: string): string {
  return `${(config.publicBaseUrl || DEFAULT_FR_PUBLIC_URL).replace(/\/+$/, '')}/approvals/${approvalId}`;
}

async function processTelegramUpdate(
  body: unknown,
  dispatchReq: Request,
  failure: FailureContext,
): Promise<Response> {
  const extracted = extractTelegramInbound(body);
  if (!extracted) {
    return jsonResponse({ received: true });
  }
  if (extracted.isBot || !extracted.senderTelegramId || !extracted.messageText) {
    return jsonResponse({ received: true });
  }

  const envelope = telegramTurnEnvelope(extracted, failure);

  // Registration helper: a user DMs the bot `/start` or `/register` to learn
  // their numeric id, which an admin (or the user) stores via PUT/POST
  // /api/me/channels as channel='telegram', address=<id>. Phase-1 admin-set seam.
  // (`/start` and `/register` are never approval traffic, so the turn is not involved.)
  if (/^\/(start|register)\b/i.test(extracted.messageText.trim())) {
    await envelope.say(
      `Your Telegram id is ${extracted.senderTelegramId}.\n` +
      `Register it on your fr profile (channel "telegram", address ${extracted.senderTelegramId}) ` +
      `to receive and approve requests here.`,
    );
    return jsonResponse({ received: true, registration: true });
  }

  // The dispatcher's own Response is returned verbatim when the agent takes the text; the
  // shared flow decides WHEN that may happen (never before laya has read the message).
  const dispatched: { response?: Response } = {};
  const result = await runChannelTurn({
    ...envelope,
    dispatch: async () => {
      const response = await channelDispatcher.handleWebhook('telegram', dispatchReq, { replyTurnDone: true });
      if (response === null) return false;
      dispatched.response = response;
      return true;
    },
    onApprovalResolved: (approvalId) => { failure.approvalId = approvalId; },
  });
  if (dispatched.response !== undefined) return dispatched.response;
  return jsonResponse({
    received: true,
    ...(result.approvalId !== null ? { processed: true } : {}),
  });
}

/**
 * The transport half of {@link runChannelTurn}: everything Telegram-specific about WHERE
 * the message is and HOW a reply goes back. The flow itself reads only these fields.
 */
function telegramTurnEnvelope(
  extracted: ExtractedTelegramInbound,
  failure: FailureContext,
): Parameters<typeof runChannelTurn>[0] {
  const { senderTelegramId, messageText, quotedText, chatId, threadId, isForum, isEdited, messageDate } = extracted;
  // Non-null: `processTelegramUpdate` refused a body without them above.
  const sender = senderTelegramId!;
  // Reply destination: the chat the message arrived in (group or DM), falling back
  // to the sender's own id.
  const replyTo = chatId || sender;
  // Every reply goes back into the forum topic the human wrote in (only a real forum
  // topic — in an ordinary group `message_thread_id` marks a reply chain, not a topic).
  // Before 2026-10-01 these went to the group's General, away from the conversation.
  const replyThread = isForum && typeof threadId === 'number' ? threadId : undefined;
  const say: Say = (text: string): Promise<unknown> => telegramAdapter.sendText(replyTo, text, replyThread);
  failure.say = say;
  return {
    channel: 'telegram',
    senderAddress: sender,
    // ⛔ A MISSING chat id is UNKNOWN, not a DM: `''` makes the flow refuse every
    // chat-scoped path rather than treat an empty field as a private chat.
    chatKey: chatId ?? '',
    // The delivery location's topic: a real forum topic only (an ordinary group's reply
    // chain id would read as a different place from the one deliveries recorded).
    threadKey: replyThread !== undefined ? String(replyThread) : '',
    // Only a chat id EQUAL to the sender proves a private chat.
    isDirectChat: chatId !== undefined && chatId === sender,
    isReplyToOther: extracted.isReplyToOther,
    isEdited,
    ...(messageDate !== undefined ? { messageDate } : {}),
    text: messageText!,
    ...(quotedText !== undefined ? { quotedText } : {}),
    isForwarded: extracted.isForwarded,
    ...(extracted.replyTo !== undefined ? { quotedReply: extracted.replyTo } : {}),
    say,
  };
}
