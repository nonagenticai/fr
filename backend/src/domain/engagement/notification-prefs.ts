// src/domain/engagement/notification-prefs.ts
//
// WS1 Phase 1A — the WHAT layer of project-execution notifications. This module
// owns notification_prefs (per-user, per-event-type, per-channel on/off) and
// the dispatch-time resolver that composes it with the existing WHERE layer
// (user_channel_prefs, via channel-prefs.ts). channel-prefs.ts is left
// untouched so the approval path (resolveRecipients / fanOutToUser) is
// unaffected.
import { and, eq, sql } from 'drizzle-orm';
import { db, notificationPrefs } from '../../db/client';
import { getPrefsForUser, type ResolvedRecipient } from './channel-prefs';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import {
  EXECUTION_EVENT_TYPES,
  NOTIFICATION_CHANNELS,
  defaultChannelEnabled,
  type ExecutionEventType,
  type NotificationChannelName,
} from './event-types';

export interface NotificationPrefRow {
  event_type: string;
  channel: string;
  enabled: boolean;
}

/** One cell of the (event_type × channel) matrix returned to the UI. */
export interface MatrixCell {
  event_type: ExecutionEventType;
  channel: NotificationChannelName;
  enabled: boolean;
  /** True when this value is the code default (no stored row for the cell). */
  is_default: boolean;
}

/**
 * Build the full (event_type × channel) matrix for a user, merging stored
 * notification_prefs over the event-types.ts defaults so the UI can always
 * render a complete grid — even for a user who has never configured anything.
 */
export async function getNotificationPrefsMatrix(userId: string): Promise<MatrixCell[]> {
  const stored = await db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.user_id, userId));

  // `\0` is a deliberate composite-key separator: it cannot occur in an event
  // type or channel, so `a_b`+`c` can never collide with `a`+`b_c`. The build
  // side and the lookup side below must always use the same separator.
  const storedByKey = new Map<string, boolean>();
  for (const row of stored) {
    storedByKey.set(`${row.event_type}\0${row.channel}`, row.enabled);
  }

  const cells: MatrixCell[] = [];
  for (const eventType of EXECUTION_EVENT_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const key = `${eventType}\0${channel}`;
      const hasStored = storedByKey.has(key);
      cells.push({
        event_type: eventType,
        channel,
        enabled: hasStored
          ? (storedByKey.get(key) as boolean)
          : defaultChannelEnabled(eventType, channel),
        is_default: !hasStored,
      });
    }
  }
  return cells;
}

/**
 * Replace-all upsert of a user's notification prefs. The payload becomes the
 * full set of EXPLICIT rows; cells absent from the payload revert to code
 * defaults (we delete then insert, mirroring channel-prefs.replacePrefs).
 *
 * Only known event types + channels are persisted; unknown keys are dropped
 * (defensive — the route also Zod-validates).
 */
export async function replaceNotificationPrefs(
  userId: string,
  prefs: NotificationPrefRow[],
): Promise<MatrixCell[]> {
  const validEvent = new Set<string>(EXECUTION_EVENT_TYPES);
  const validChannel = new Set<string>(NOTIFICATION_CHANNELS);
  const clean = prefs.filter(
    (p) => validEvent.has(p.event_type) && validChannel.has(p.channel),
  );

  await db.transaction(async (tx) => {
    // Replace-all: two overlapping PUTs for one user would both delete and both
    // insert, and the second insert hits the unique key (a 500). Serialise per
    // user for the length of the transaction.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`notification-prefs:${userId}`}))`);
    await tx.delete(notificationPrefs).where(eq(notificationPrefs.user_id, userId));
    if (clean.length > 0) {
      await tx.insert(notificationPrefs).values(
        clean.map((p) => ({
          user_id: userId,
          event_type: p.event_type,
          channel: p.channel,
          enabled: p.enabled,
        })),
      );
    }
  });

  return getNotificationPrefsMatrix(userId);
}

/**
 * Resolve the EXTERNAL channel recipients for one (user, event) pair.
 *
 * Composition:
 *   1. user_channel_prefs (the WHERE) → enabled channel→address pairs.
 *   2. notification_prefs (the WHAT) for this event_type → per-channel on/off;
 *      a missing row falls back to event-types.ts defaults.
 *   A channel is included only when BOTH the user is reachable on it AND the
 *   event type is enabled for it.
 *
 * The `inapp` inbox row is NOT returned here — fanOutEventToUser always writes
 * it directly. Never throws; on a DB error it logs and returns [].
 */
export async function resolveRecipientsForEvent(
  userId: string,
  eventType: ExecutionEventType,
): Promise<ResolvedRecipient[]> {
  let channelPrefs: Awaited<ReturnType<typeof getPrefsForUser>> = [];
  let typePrefs: { channel: string; enabled: boolean }[] = [];
  try {
    [channelPrefs, typePrefs] = await Promise.all([
      getPrefsForUser(userId),
      db
        .select({ channel: notificationPrefs.channel, enabled: notificationPrefs.enabled })
        .from(notificationPrefs)
        .where(
          and(
            eq(notificationPrefs.user_id, userId),
            eq(notificationPrefs.event_type, eventType),
          ),
        ),
    ]);
  } catch (err) {
    // ⭐ THIS ONE IS A REAL SILENT SWALLOW, and the empty array is not a benign
    // fallback: an empty recipient list means the notification is simply NOT SENT,
    // and no caller can distinguish "nobody opted in to this event" from "the prefs
    // store is unreadable". The behaviour is left exactly as it was (still `[]`,
    // still never throws — see the docstring); what changes is that the cause is now
    // recorded instead of being visible only as an unstructured log line.
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `no recipients resolved for ${eventType}; notification not sent`,
    });
    return [];
  }

  const typeEnabledByChannel = new Map<string, boolean>();
  for (const row of typePrefs) typeEnabledByChannel.set(row.channel, row.enabled);

  const recipients: ResolvedRecipient[] = [];
  for (const pref of channelPrefs) {
    if (!pref.enabled) continue;
    if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(pref.channel)) continue;
    const typeEnabled = typeEnabledByChannel.has(pref.channel)
      ? (typeEnabledByChannel.get(pref.channel) as boolean)
      : defaultChannelEnabled(eventType, pref.channel as NotificationChannelName);
    if (typeEnabled) {
      recipients.push({ channel: pref.channel, address: pref.address });
    }
  }
  return recipients;
}
