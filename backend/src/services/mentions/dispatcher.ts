// src/services/mentions/dispatcher.ts
// Fan out a resolved list of mentions:
//   - publish a single `comment_mentioned` WebSocket event with all
//     mentioned Planka user ids (so the frontend can highlight)
//   - tell each mentioned fr user out of band, through THE ONE multicast
//     (`notificationService.fanOutMessageToUser`), on whatever channels THEIR
//     preferences enable
//
// ⛔ WHY THE SECOND LEG IS THE SHARED FAN-OUT AND NOT A CHANNEL CALL. It used to be
// `signalAdapter.sendText(phone, …)` — a hard-wired SMS to one channel, which died with the
// Signal removal (2026-10-31) and would have taken the whole out-of-band mention
// notification with it: a mentioned user would have been highlighted in an already-open UI
// and told nothing otherwise. Owner ruling the same day: every channel runs the ONE multicast
// implementation, so a mention is addressed exactly like every other notification — the
// user's own channel prefs decide where it lands. Do NOT reintroduce a per-channel send here.
//
// Identity resolution deliberately lives in resolver.ts; this module only dispatches what it
// resolved. Uses the real WS server and notification-service singletons.
import { wsManager } from '../../domain/engagement/adapters/websocket';
import { notificationService } from '../../domain/engagement/notifications';
import type { ResolvedMention } from './resolver';

export interface MentionContext {
  commenterName: string;
  commentId: string;
  cardId: string;
  cardName: string;
  boardId: string;
  text: string;
}

const BODY_MAX = 140;

function buildMentionMessage(ctx: MentionContext): string {
  const snippet = ctx.text.length > BODY_MAX ? `${ctx.text.slice(0, BODY_MAX)}…` : ctx.text;
  return `${ctx.commenterName} mentioned you on "${ctx.cardName}": ${snippet}`;
}

export async function dispatchMentions(
  mentions: ResolvedMention[],
  ctx: MentionContext,
): Promise<void> {
  if (mentions.length === 0) return;

  const mentionedUserIds: string[] = [];
  for (const m of mentions) {
    if (m.plankaUserId) mentionedUserIds.push(m.plankaUserId);
  }

  if (mentionedUserIds.length > 0) {
    wsManager.publishKanbanEvent({
      kind: 'comment_mentioned',
      cardId: ctx.cardId,
      commentId: ctx.commentId,
      mentionedUserIds,
    });
  }

  // Out-of-band leg: one fan-out per distinct mentioned fr user, so the user's own channel
  // prefs are read once (a second account for the same person is not told twice). A mention
  // has no engagement row of its own, so the correlation id names THIS comment.
  // Concurrent, and never throws: the comment is already written and the WS highlight has
  // already gone out, so a delivery failure is a warn, not a failed comment.
  const recipients = [...new Set(mentions.map((m) => m.keycloakSub).filter((s): s is string => Boolean(s)))];
  if (recipients.length === 0) return;
  const text = buildMentionMessage(ctx);
  const results = await Promise.allSettled(
    recipients.map((sub) =>
      notificationService.fanOutMessageToUser(sub, { kind: 'text', correlationId: `mention:${ctx.commentId}`, text }, 'mention'),
    ),
  );
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.warn(
        `[mentions] out-of-band fan-out for ${recipients[i]} failed:`,
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }
}
