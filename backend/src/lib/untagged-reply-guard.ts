// src/lib/untagged-reply-guard.ts
//
// ONE rule for every inbound reply binder that can bind a message carrying NO
// `[ApprovalId:…]` / `[AnswerFor:…]` tag to an approval (George 2026-10-10).
//
// Why
// ---
// A tenant licence may send notifications on every channel
// (`POST /api/notifications/dispatch`, stored as engagement_type
// 'licence_notification'). A licence cannot put a reply tag in its text (refused at
// dispatch), but the UNTAGGED binders never read a tag: they infer the target from
// "what was recently sent to this person" (Telegram: the one pending approval
// delivered in this chat). So a licence message saying "reply OK" / "send 1" could steer a human's
// fresh, untagged reply onto an approval the licence never named — the licence
// becomes the TRIGGER of a binding without ever being its target.
//
// The rule, as a class (not per tag, not per channel): an untagged message may bind
// to an approval only if the MOST RECENT outbound delivery fr made on that channel to
// that address (chat / phone) was an approval ask. If the newest thing fr put in front
// of the human there is anything else — a licence notification, an ops alert, an
// execution event — the human's untagged reply is not unambiguously about an approval,
// and it binds to nothing. The ask that ENABLES the bind must be addressed to the SENDER
// (validator 5: in a shared group, another user's ask is not "what fr last asked you");
// anything newer that is not an approval ask BLOCKS, whoever it was for. Tagged replies are unaffected: the tag names the approval
// and only fr's own approval messages carry one.
//
// Data source: `engagement_deliveries` records channel, recipient_address, status,
// engagement_type and created_at for every send through fanOut (approval asks via
// fanOutToUser, licence/system notifications via fanOutMessageToUser) and for the
// bot's own confirm ask (telegram-webhook askToConfirm). The location is the place the
// message was actually POSTED — `metadata_json` chatId + messageThreadId when the transport
// records one (Telegram; recorded on failed sends too), else the recipient address (see
// ChannelLocation). The SAME rule on every channel. Non-approval rows
// block at ANY status, approval asks enable only when 'sent'.
//
// ⛔ AS OF THE INBOUND MESSAGE (validator 6). The state is read as it stood when the human
// TYPED, not when fr processed the update: a Telegram retry / slow webhook can be processed
// after a NEWER ask was posted, and that ask cannot have prompted a message typed before it.
//   * an ask ENABLES only if it was delivered STRICTLY BEFORE the inbound time (floored to
//     the inbound clock's resolution — Telegram `message.date` is whole seconds). A tie refuses.
//   * a blocker (any non-approval row at the location, any status) newer than that enabling
//     ask COUNTS WHATEVER ITS TIME — there is NO upper bound against the inbound time, on any
//     channel (validator 7, George 2026-10-11 FAIL CLOSED). The inbound clock is not fr's (a
//     chat platform sets it), so a licence row delivered before the human typed can look
//     "after the message" and the older ask would enable the bind. Accepted cost: a genuine
//     reply typed just before a later licence message arrives is refused, and the human
//     re-sends it (or replies tagged).
// ⛔ A CLIENT-SUPPLIED CLOCK NEVER WIDENS ANYTHING (validator 8). The enabling-ask bound compares
// a delivery time with the inbound time, so whenever the two come from DIFFERENT clocks the
// comparison carries a skew allowance that can only NARROW:
//   * Telegram, row WITH `metadata_json.date`: Telegram's clock on both sides (the binder,
//     `findEligibleUnquotedApprovals`, compares the same pair) — `date*1000 < message.date*1000`.
//   * row WITHOUT `date` against a transport clock: `created_at` is fr's clock vs e.g.
//     Telegram's `message.date`; an fr clock running BEHIND would make a later ask look
//     earlier, so the ask enables only if `created_at + UNDATED_ASK_SKEW_MS < message.date`.
//   * a channel whose inbound time IS fr's receive time (mcp, email, teams, inapp): one clock,
//     no allowance (`inboundTime(…, receivedAtMs)`).
//
// ⛔ FAIL CLOSED. No row, a failed read, or NO inbound time refuses the untagged bind; the
// human is told to reply to the approval message (the tagged path), which still works.
//
// Licence rows are written BEFORE the send ('pending', with the location) and updated after
// (notifications.ts fanOutMessageToUser); a failed pre-write sends nothing. A pre-written row
// is "newer than an ask" until it records when its send settled (`metadata_json.settledAtMs`):
// a 'pending' row that never settled stays newer than every ask (fail closed).

import { and, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';

import { db, engagementDeliveries } from '../db/client';
import { findUserIdsByChannelAddress } from '../domain/engagement/channel-prefs';

/**
 * Engagement types that ARE an approval ask the untagged binders legitimately serve.
 * 'approval' — every per-approval fan-out (fanOutToUser's default; also action
 * approvals). 'approval-backlog-digest' — the redelivery worker's digest of pending
 * approvals (workers/approval-redelivery.ts DIGEST_ENGAGEMENT_TYPE).
 *
 * ⛔ 'approval-chat-ask' was REMOVED with the Telegram answer/confirm asks it existed for
 * (owner ruling 2026-10-31: every channel runs the same flow, and no channel keeps reply
 * state — migration 223 drops the table). No seat records a follow-up question any more, so
 * nothing needs the untagged binder to see one. Historical `engagement_deliveries` rows of
 * that type stay in place; they simply no longer match an ask.
 *
 * ⛔ Never add 'licence_notification' or any caller-chosen type here.
 */
export const APPROVAL_ASK_ENGAGEMENT_TYPES: readonly string[] = [
  'approval',
  'approval-backlog-digest',
];

/**
 * fr's own notice that an approval CLOSED (`approval.closed`, workers/mcp-approval-closed.ts).
 * It is approval traffic about a named approval, not a message that could steer a reply, so it
 * neither enables nor blocks an untagged bind — otherwise a close notice landing after an ask
 * would make the transport that receives close notices refuse a `1` every other transport
 * accepts.
 */
export const APPROVAL_LIFECYCLE_ENGAGEMENT_TYPES: readonly string[] = ['approval-closed'];

export function isApprovalAskEngagementType(type: string | null | undefined): boolean {
  return typeof type === 'string' && APPROVAL_ASK_ENGAGEMENT_TYPES.includes(type);
}

/**
 * WHERE a delivery was put in front of a human — the ONE location key shared by this guard and
 * the untagged binder (`channel-reply.ts findEligibleUnquotedApprovals`), on EVERY channel, so
 * "the newest thing fr sent HERE" and "the approval delivered HERE" can never mean two places.
 *
 * The key is the delivery's REAL location as the adapter recorded it: `metadata_json.chatId`
 * (+ `messageThreadId`, the forum topic) when the transport posts somewhere other than the
 * recipient's own address (Telegram group topics), else the `recipient_address` it was sent to
 * (a 1:1 conversation with that address — mcp, email, teams, inapp, a Telegram DM).
 * ⛔ With TELEGRAM_USE_TOPICS a project approval addressed to a user (recipient_address = their
 * Telegram id) is POSTED into the group's project topic; the recorded chat wins, so that post
 * never counts as "in the DM" (validator 4, item 1).
 *
 * `threadId` is the inbound message's thread exactly as the binder receives it (null for none).
 * A row that recorded its topic must match it exactly; a row with no `messageThreadId` key is
 * at this location only in the sender's own 1:1 conversation with no topic.
 */
export type ChannelLocation = {
  chatId: string;
  threadId: number | null;
  senderAddress: string;
};

/** The chat a delivery row went to: its recorded `chatId`, else the address it was sent to. */
export function deliveredChatSql(): SQL {
  const md = engagementDeliveries.metadata_json;
  return sql`coalesce(nullif(${md}->>'chatId', ''), ${engagementDeliveries.recipient_address})`;
}

export function deliveredAtLocationSql(loc: ChannelLocation): SQL {
  // A transport that records no metadata leaves the column NULL; `NULL ? key` is NULL, not false.
  const md = sql`coalesce(${engagementDeliveries.metadata_json}, '{}'::jsonb)`;
  const thread = loc.threadId === null ? '' : String(loc.threadId);
  return sql`(
    ${deliveredChatSql()} = ${loc.chatId}
    AND (
      (${md} ? 'messageThreadId'
        AND coalesce(${md}->>'messageThreadId', '') = ${thread})
      OR (NOT (${md} ? 'messageThreadId')
        AND ${deliveredChatSql()} = ${loc.senderAddress}
        AND ${thread} = '')
    )
  )`;
}

/**
 * When the human TYPED the inbound message, on the inbound channel's clock: `epochMs` is the
 * value FLOORED to `resolutionMs` (Telegram: `message.date * 1000`, resolution 1000). The
 * actual instant lies in `[epochMs, epochMs + resolutionMs)`.
 */
export type InboundTime = {
  epochMs: number;
  resolutionMs: number;
  /** How far fr's `created_at` must precede `epochMs` for an undated ask to enable: the
   * cross-clock allowance. 0 when the inbound time IS fr's clock (no skew to allow for). */
  undatedAskSkewMs: number;
};

/** An ask recorded only by fr's `created_at` must precede a transport-clock inbound time by this
 * much to enable (fr clock vs the chat platform's clock — see the header). */
export const UNDATED_ASK_SKEW_MS = 5_000;

/**
 * The inbound message's time. `receivedAtMs` (fr's own clock, the moment fr received a message
 * whose transport carries no send time) needs no skew allowance; a transport clock in whole
 * seconds (`messageDate`, Telegram's `message.date`) gets one.
 */
export function inboundTime(messageDate: number | null | undefined, receivedAtMs?: number): InboundTime | null {
  if (typeof receivedAtMs === 'number' && Number.isFinite(receivedAtMs) && receivedAtMs > 0) {
    return { epochMs: Math.floor(receivedAtMs), resolutionMs: 1, undatedAskSkewMs: 0 };
  }
  return typeof messageDate === 'number' && Number.isFinite(messageDate) && messageDate > 0
    ? { epochMs: Math.floor(messageDate) * 1000, resolutionMs: 1000, undatedAskSkewMs: UNDATED_ASK_SKEW_MS }
    : null;
}

export type OutboundScope = {
  channel: string;
  location: ChannelLocation;
  /** The inbound message's own time; null ⇒ refuse (`no_inbound_time`). */
  inboundAt: InboundTime | null;
};

export type UntaggedBindVerdict =
  | { allowed: true; latestType: string }
  | {
      allowed: false;
      reason: 'latest_outbound_not_approval' | 'no_outbound' | 'lookup_failed' | 'no_inbound_time';
      latestType: string | null;
    };

/** Epoch ms (numeric, microseconds kept) of a zone-less `now()` timestamp, read in the session zone. */
function epochMsSql(ts: SQL | typeof engagementDeliveries.created_at): SQL {
  return sql`(extract(epoch from (${ts} AT TIME ZONE current_setting('TimeZone'))) * 1000)`;
}

/** The ENABLING-ask condition: the ask reached the human strictly before the inbound time,
 * with a skew allowance whenever the two sides are on different clocks (see the header).
 *   * `metadata_json.date` (Telegram's clock, same as `message.date`) when recorded,
 *     else `created_at + at.undatedAskSkewMs` (fr's clock; padded only against a transport
 *     clock, 0 when the inbound time is fr's own). */
function askDeliveredBeforeInboundSql(scope: OutboundScope, at: InboundTime): SQL {
  const created = epochMsSql(engagementDeliveries.created_at);
  const md = engagementDeliveries.metadata_json;
  return sql`coalesce(
    (CASE WHEN jsonb_typeof(${md}->'date') = 'number' THEN (${md}->>'date')::numeric * 1000 END),
    ${created} + ${at.undatedAskSkewMs}::numeric
  ) < ${at.epochMs}::numeric`;
}

/** The LATEST instant the row's send could have reached the human, on fr's clock: the recorded
 * settle time of a pre-written row, +infinity for a 'pending' row that never settled, else
 * `created_at` (rows written after their send). */
function latestPossibleMsSql(): SQL {
  const md = engagementDeliveries.metadata_json;
  return sql`(CASE
    WHEN jsonb_typeof(${md}->'settledAtMs') = 'number' THEN (${md}->>'settledAtMs')::numeric
    WHEN ${engagementDeliveries.status} = 'pending' THEN 'Infinity'::numeric
    ELSE ${epochMsSql(engagementDeliveries.created_at)}
  END)`;
}

const askTypesSql = sql.join(APPROVAL_ASK_ENGAGEMENT_TYPES.map((t) => sql`${t}`), sql`, `);

/** Every row fr recorded at this scope's location (any status, any type). */
function atLocationSql(scope: OutboundScope): SQL {
  const loc = scope.location;
  const md = engagementDeliveries.metadata_json;
  return and(
    eq(engagementDeliveries.channel, scope.channel),
    or(
      deliveredAtLocationSql(loc),
      // A NON-approval row that recorded no chat (written before failed sends recorded
      // their location, or a transport that threw): it went where the adapter resolves a
      // numeric address — that chat, no topic. Widens only the BLOCKING side.
      sql`(
        ${engagementDeliveries.engagement_type} NOT IN (${askTypesSql})
        AND coalesce(${md}->>'chatId', '') = ''
        AND ${engagementDeliveries.recipient_address} = ${loc.chatId}
        AND ${loc.threadId === null ? '' : String(loc.threadId)} = ''
      )`,
    ),
  )!;
}

/**
 * Which approval asks may ENABLE an untagged bind for this sender (validator 5): only asks
 * ADDRESSED TO THE SENDER. In a multi-user Telegram group the newest approval ask in the
 * chat may be for someone else (X's approval, X's digest, the bot's question to X) — it
 * says nothing about what the sender was last shown about THEIR approvals, so it must not
 * vouch for the sender's untagged `1` (Y's approval asked in G → licence "reply 1 now" to Y
 * in G → X's approval asked in G → Y's `1` must NOT bind Y's approval).
 *
 *   * `recipient_user_id` ∈ the sender's linked users, resolved EXACTLY as the untagged
 *     binder resolves the sender (`findUserIdsByChannelAddress(channel, senderAddress)`,
 *     channel-reply `findEligibleUnquotedApprovals`). No linked user
 *     ⇒ null ⇒ no enabling ask (fail closed).
 *
 * ⛔ BLOCKERS stay location-wide (any recipient): a licence message posted into the group
 * for anyone is in front of everyone reading it.
 */
async function senderAskSql(scope: OutboundScope): Promise<SQL | null> {
  const userIds = await findUserIdsByChannelAddress(scope.channel, scope.location.senderAddress);
  if (userIds.length === 0) return null;
  return inArray(engagementDeliveries.recipient_user_id, userIds);
}

/**
 * The engagement type that DECIDES the verdict at this location:
 *   * the newest NON-approval row at ANY status (sent / failed / pending …) that is not
 *     older than the newest SENT approval ask — a Telegram timeout or 5xx that actually
 *     delivered records 'failed', and must still block (validator 4, item 2);
 *   * else that newest SENT approval ask ADDRESSED TO THE SENDER (`senderAskSql`; a FAILED
 *     ask, or another recipient's ask, never enables a bind);
 *   * else null (nothing sent here).
 */
async function latestOutboundEngagementType(scope: OutboundScope): Promise<string | null> {
  const at = scope.inboundAt;
  if (at === null) return null; // untaggedBindAllowed refuses first; never widen here.
  const here = atLocationSql(scope);
  const addressedToSender = await senderAskSql(scope);
  const [ask] = addressedToSender === null ? [] : await db
    .select({ type: engagementDeliveries.engagement_type, id: engagementDeliveries.id })
    .from(engagementDeliveries)
    .where(and(
      here,
      eq(engagementDeliveries.status, 'sent'),
      inArray(engagementDeliveries.engagement_type, [...APPROVAL_ASK_ENGAGEMENT_TYPES]),
      addressedToSender,
      // ⛔ AS OF THE INBOUND MESSAGE (validator 6): an ask posted after the human typed cannot
      // have prompted the message. STRICTLY before the floored inbound time; a tie refuses;
      // cross-clock comparisons carry a narrowing skew allowance (validator 8).
      askDeliveredBeforeInboundSql(scope, at),
    ))
    .orderBy(desc(engagementDeliveries.created_at), desc(engagementDeliveries.id))
    .limit(1);
  const [blocker] = await db
    .select({ type: engagementDeliveries.engagement_type })
    .from(engagementDeliveries)
    .where(and(
      here,
      notInArray(engagementDeliveries.engagement_type, [
        ...APPROVAL_ASK_ENGAGEMENT_TYPES,
        ...APPROVAL_LIFECYCLE_ENGAGEMENT_TYPES,
      ]),
      // ⛔ NO upper bound against the inbound time (validator 7): the inbound clock is the
      // chat platform's, not fr's, so "delivered after the message" is not provable from it.
      // Any blocker newer than the enabling ask refuses (fail closed).
      // Not older than the ask. Ties refuse: same instant as the ask is not "older than" it.
      // ⛔ Compared IN SQL against the ask's own row (a JS Date round-trip truncates
      // created_at's microseconds). The blocker side is its LATEST possible send time: a
      // licence row is pre-written before its send, so its created_at can precede an ask
      // whose send finished before the licence's did.
      ...(ask
        ? [sql`${latestPossibleMsSql()} >= (SELECT ${epochMsSql(sql`d2.created_at`)} FROM engagement_deliveries d2 WHERE d2.id = ${ask.id})`]
        : []),
    ))
    .orderBy(desc(engagementDeliveries.created_at), desc(engagementDeliveries.id))
    .limit(1);
  return blocker?.type ?? ask?.type ?? null;
}


/**
 * May an UNTAGGED inbound message on `scope` be bound to an approval? See the header.
 * Never throws.
 */
export async function untaggedBindAllowed(scope: OutboundScope): Promise<UntaggedBindVerdict> {
  // No inbound time ⇒ nothing can be ordered against the message: refuse.
  if (scope.inboundAt === null) return { allowed: false, reason: 'no_inbound_time', latestType: null };
  let latestType: string | null;
  try {
    latestType = await latestOutboundEngagementType(scope);
  } catch (err) {
    console.error(
      `[untagged-reply-guard] latest-outbound read failed (${scope.channel}); refusing the untagged bind:`,
      err instanceof Error ? err.message : err,
    );
    return { allowed: false, reason: 'lookup_failed', latestType: null };
  }
  if (latestType === null) return { allowed: false, reason: 'no_outbound', latestType: null };
  if (!isApprovalAskEngagementType(latestType)) {
    return { allowed: false, reason: 'latest_outbound_not_approval', latestType };
  }
  return { allowed: true, latestType };
}

/**
 * The reply when an untagged message was refused by this guard. Contains no
 * `[<word>:` tag of its own beyond naming the gesture.
 */
export function untaggedBindRefusedMessage(gesture: 'reply' | 'quote'): string {
  const how =
    gesture === 'reply'
      ? "tap Reply on the approval's own notification (so its approval tag comes with your reply)"
      : "quote the approval's own message (so its approval tag comes with your reply)";
  return (
    "Nothing was recorded: the last message I sent you here was not an approval request, so a reply " +
    `without an approval tag can't be matched to one. To decide, ${how}, or decide it in fr.`
  );
}
