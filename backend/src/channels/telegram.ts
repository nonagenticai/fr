// E-7: Telegram inbound channel.
//
// `parseWebhook` recognises *agent-addressable* Telegram messages (free-text
// the user types to the bot, e.g. "project status"). Three shapes are passed
// through by returning `null` so the transport adapter `routes/telegram-webhook.ts`
// can run the shared reply→decision flow (`domain/engagement/channel-reply.ts`):
//   1. Approval traffic — whatever `looksLikeApprovalTraffic` (domain/engagement/
//      channel-reply.ts, the ONE definition) says the approval flow reads: a quoted/inline
//      `[ApprovalId:…]` tag, or any decision attempt.
//   2. `/start` / `/register` — the registration helper that DMs the user
//      their numeric id (lives in the adapter).
//   3. Bot senders (`is_bot`) — never materialised into an agent turn.
//
// The structural difference from every other channel is only the envelope parser
// (`extractTelegramInbound`) and that a numeric Telegram id — not an email or an AAD
// object id — is the `user_channel_prefs` address keyed on by
// `KeycloakIdentityResolver.resolveIdentity` (agent-core/identity.ts).

import type { ChannelInbound, InboundMessage } from './index';
import type { ChannelMessage } from '../domain/engagement/notifications';
import { telegramAdapter } from '../domain/engagement/adapters/telegram';
import { extractTelegramInbound } from './telegram-envelope';
import { looksLikeApprovalTraffic } from '../domain/engagement/channel-reply';

const REGISTRATION_RE = /^\/(start|register)\b/i;

/**
 * ⛔ ONE DEFINITION. This used to carry its own keyword list (`1/2/3/approve/…` as the
 * whole message or followed by a space or delimiter), which drifted from the grammar the
 * approval flow actually reads: `1.`, `Approve!`, `Approve 👍`, `1 #abcd1234` and
 * `#abcd1234 1` all fell through to the agent dispatcher and never reached approvals
 * (measured with CHANNEL_DISPATCH_ENABLED=true).
 * It now delegates to the shared flow's own predicate, so the two cannot disagree again.
 * `runChannelTurn` consults it first, BEFORE dispatch; this copy keeps `parseWebhook`
 * honest for any other caller.
 */
function looksLikeApprovalReply(quotedText: string | undefined, messageText: string): boolean {
  return looksLikeApprovalTraffic({ quotedText, messageText });
}

export const telegramChannel: ChannelInbound = {
  name: 'telegram',

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }

    const extracted = extractTelegramInbound(body);
    if (!extracted) return null;

    const { senderTelegramId, isBot, messageText, quotedText } = extracted;
    if (isBot || !senderTelegramId || !messageText) return null;

    // `/start` / `/register` belong to the legacy registration helper, which
    // replies the sender their numeric id so they can link it on their profile.
    if (REGISTRATION_RE.test(messageText.trim())) return null;

    if (looksLikeApprovalReply(quotedText, messageText)) {
      // Legacy approval-callback shape — let routes/telegram-webhook.ts handle it.
      return null;
    }

    return {
      channel: 'telegram',
      // Telegram envelopes have no Keycloak userId. Identity resolution is
      // performed downstream by `KeycloakIdentityResolver.resolveIdentity`
      // (agent-core/identity.ts), which calls `findUserIdsByChannelAddress`
      // on `msg.address` (the numeric Telegram id stored under channel
      // 'telegram') and returns `{ userId, tenantRoles }`. We carry the id in
      // both `userId` and `address` so the dispatcher has a stable log key if
      // the lookup misses.
      userId: senderTelegramId,
      address: senderTelegramId,
      text: messageText,
      correlationId: crypto.randomUUID(),
      raw: body,
    };
  },

  async postReply(_threadId: string | undefined, message: ChannelMessage): Promise<void> {
    // The dispatcher copies the inbound `address` (the sender's numeric id)
    // into `message.meta.address`; for v1 the conversational reply goes back
    // as a DM to that sender. No address → no recipient → skip with a warn.
    const address = typeof message.meta?.address === 'string' ? message.meta.address : '';
    if (!address) {
      console.warn(
        `[channels/telegram] postReply skipped: no address in message.meta cid=${message.correlationId} kind=${message.kind}`,
      );
      return;
    }
    // sendMessage returns a SendResult instead of throwing on transport
    // failure — surface it loudly so a Bot-API rejection (e.g. unset token,
    // user hasn't started the bot) is visible in the pod logs without
    // cross-service correlation.
    const result = await telegramAdapter.sendMessage(address, message);
    if (!result.success) {
      console.error(
        `[channels/telegram] postReply failed cid=${message.correlationId} kind=${message.kind} address=${address}: ${result.error}`,
      );
    }
  },
};
