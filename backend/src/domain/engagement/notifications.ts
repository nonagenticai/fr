// src/domain/engagement/notifications.ts
// Channel adapter pattern — fan-out notifications to all registered channels
import { eq, sql } from 'drizzle-orm';
import { db, notificationLog, engagementDeliveries, notifications } from '../../db/client';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { resolveRecipients } from './channel-prefs';
import { resolveRecipientsForEvent } from './notification-prefs';
import type { ExecutionEventType, Severity } from './event-types';

export type ChannelMessageKind =
  | 'text'
  | 'approval-request'
  | 'action-result'
  | 'action-error';

export interface ApprovalWithDetails {
  id: string;
  project_id: string | null;
  description: string;
  card_id: string | null;
  callback_path: string | null;
  source: string | null;
  metadata: Record<string, any> | null;
  status: string;
  /** NULL = no deadline, ever (migration 105). Never compare it bare: `new Date(null)` is epoch 0. */
  expires_at: Date | null;
  requester_id: string | null;
  /** `approvals.kind`. Optional: most callers spread the DB row, which carries it; the
   * Telegram footer reads it to withhold the chat menu from web-only kinds. */
  kind?: string | null;
  /**
   * `approvals.tenant_id`. Optional in the type because most callers spread
   * the DB row (which carries it). fr row 14d-2: the WebSocket channel
   * publishes ONLY to this tenant's channel and drops an approval without it.
   */
  tenant_id?: string | null;
  /** `approvals.action_id`: set ⇒ an ACTION approval (fr executes a write as its decider). */
  action_id?: string | null;
}

/** The approval-row columns a channel notification reads. */
export interface NotifiableApprovalRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  description: string;
  card_id: string | null;
  callback_path: string | null;
  source: string | null;
  metadata: Record<string, any> | null;
  status: string;
  expires_at: Date | null;
  requester_id: string | null;
  kind: string | null;
  action_id: string | null;
}

/**
 * THE copy of an approval row a notification is sent from — the first send of an action
 * approval and every re-delivery build it here, so neither can drop a field the adapters read
 * (`kind` picks the menu; `action_id` withholds a typed `1` where it is refused; `tenant_id`
 * scopes the bug-report lookup). Two hand-listed copies dropped `kind`, then `action_id`.
 */
export function approvalNotificationCopy(row: NotifiableApprovalRow): ApprovalWithDetails & { tenant_id: string } {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    description: row.description,
    card_id: row.card_id,
    callback_path: row.callback_path,
    source: row.source,
    metadata: row.metadata,
    status: row.status,
    expires_at: row.expires_at,
    requester_id: row.requester_id,
    kind: row.kind ?? null,
    action_id: row.action_id ?? null,
  };
}

export type SendResult = { success: boolean; error?: string; metadata?: Record<string, any> };

/**
 * WS1 Phase 1A — a non-approval project-execution event (card lifecycle, PR
 * activity, outcome signal). Dispatched by {@link NotificationService.fanOutEventToUser}:
 * a durable `notifications` inbox row is always written, then external channels
 * are fanned out per the (event_type × channel) matrix.
 */
export interface ExecutionEvent {
  event_type: ExecutionEventType;
  tenant_id: string;
  severity: Severity;
  title: string;
  body?: string | null;
  link?: string | null;
  project_id?: string | null;
  card_id?: string | null;
  execution_id?: string | null;
  source?: string;
  correlation_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Kind-specific notes for the discriminated `ChannelMessage` union (E-6):
 *
 * - `text`: no required meta keys.
 * - `approval-request`: `meta.approvalId` (string, required) — used to build
 *   callback payloads on rich channels and to stamp `[ApprovalId:...]` tags
 *   on plain-text channels. `meta.projectName` (string, optional) — used for
 *   card titles on Teams.
 * - `action-result`: `meta.actionId` (string, required); optional
 *   `meta.outcome` ('approved' | 'rejected') and `meta.result`.
 * - `action-error`: `meta.actionId` (string, required); optional
 *   `meta.errorCode`.
 *
 * Each variant allows additional string-keyed metadata so call sites can
 * forward extra context (e.g. actionName, errorMessage) without losing
 * type-checking on the required fields.
 */
export interface ChannelMessageBase {
  /**
   * Correlation id for the outbound message. Propagated into rendered bodies
   * (e.g. Teams top-level `correlationId` field).
   * Adapters may fall back to tryGetRequestContext()?.correlationId if this
   * is the empty string.
   */
  correlationId: string;
  text: string;
}

export type ChannelMessage =
  | (ChannelMessageBase & {
      kind: 'text';
      meta?: Record<string, unknown>;
    })
  | (ChannelMessageBase & {
      kind: 'approval-request';
      meta: { approvalId: string; projectName?: string; [key: string]: unknown };
    })
  | (ChannelMessageBase & {
      kind: 'action-result';
      meta: {
        actionId: string;
        outcome?: 'approved' | 'rejected';
        result?: unknown;
        [key: string]: unknown;
      };
    })
  | (ChannelMessageBase & {
      kind: 'action-error';
      meta: { actionId: string; errorCode?: string; [key: string]: unknown };
    });

export interface NotificationChannel {
  name: string;
  send(
    approval: ApprovalWithDetails,
    recipientAddress: string,
  ): Promise<SendResult>;
  /**
   * Generic per-channel message transport (E-6). Implementations must not
   * throw on transport failure — return `{ success: false, error }` instead.
   */
  sendMessage(address: string, message: ChannelMessage): Promise<SendResult>;
  /**
   * WHERE `sendMessage(address, …)` will post, as the `metadata_json` location keys the
   * adapter records after a send (Telegram: chatId + messageThreadId).
   * Used to PRE-WRITE a delivery row before the send (RECORD_BEFORE_SEND_ENGAGEMENT_TYPES), so
   * the untagged-reply guard sees the message even if the post-send write is lost.
   * Pure; never throws. Absent ⇒ the pre-written row carries no location metadata.
   */
  locate?(address: string): Record<string, unknown> | null;
}

/**
 * Engagement types whose delivery row is written BEFORE the send (status 'pending', with the
 * location) and updated after — and whose send is SKIPPED when that pre-write fails. A licence
 * notification must never be in front of a human without a row the untagged-reply guard
 * (lib/untagged-reply-guard.ts) can see: a lost after-send write used to let the next untagged
 * reply bind as if the licence message had never been sent (validator 6). Equals
 * routes/notifications/dispatch LICENCE_NOTIFICATION_ENGAGEMENT_TYPE (pinned by a test; not
 * imported, the route imports this module).
 */
export const RECORD_BEFORE_SEND_ENGAGEMENT_TYPES: ReadonlySet<string> = new Set(['licence_notification']);

/** Per-channel outcome of `fanOutMessageToUser`. `not_sent`: the pre-send delivery record
 * could not be written, so nothing was sent on that channel. */
export type MessageFanOutOutcome = {
  channel: string;
  status: 'sent' | 'failed' | 'skipped_disabled' | 'not_sent';
  error?: string;
};

/** The pre-send delivery-record write and its settle. */
async function insertPendingDelivery(values: typeof engagementDeliveries.$inferInsert): Promise<string> {
  const [row] = await db.insert(engagementDeliveries).values(values).returning({ id: engagementDeliveries.id });
  if (!row) throw new Error('engagement_deliveries pre-send insert returned no row');
  return row.id;
}

/** Settle a pre-written row: status, error, the adapter's metadata (Telegram's `date`), and
 * WHEN the send settled on fr's clock (`settledAtMs`, the guard's "latest possible" time). */
async function settleDelivery(id: string, status: 'sent' | 'failed', result: SendResult): Promise<void> {
  const md = engagementDeliveries.metadata_json;
  await db.update(engagementDeliveries).set({
    status,
    error: result.error ?? null,
    metadata_json: sql`coalesce(${md}, '{}'::jsonb) || ${JSON.stringify(result.metadata ?? {})}::jsonb
      || jsonb_build_object('settledAtMs', extract(epoch from clock_timestamp()) * 1000)`,
  }).where(eq(engagementDeliveries.id, id));
}

export class NotificationService {
  private channels: Map<string, NotificationChannel> = new Map();

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
    console.log(`[notifications] Registered channel: ${channel.name}`);
  }

  /**
   * Fan-out a new approval notification to all channels.
   * For each channel, determine recipients and send.
   * Logs every attempt to notification_log.
   *
   * @deprecated Use {@link fanOutToUser} which resolves per-user channel preferences
   * and writes to engagement_deliveries. Retained only for broadcast websocket events
   * and test harnesses that assert on the raw recipients array.
   */
  async fanOut(
    approval: ApprovalWithDetails,
    recipients: { channel: string; address: string }[],
  ): Promise<void> {
    const promises = recipients.map(async ({ channel: channelName, address }) => {
      const channel = this.channels.get(channelName);
      if (!channel) {
        console.warn(`[notifications] Channel ${channelName} not registered, skipping`);
        return;
      }

      try {
        const result = await channel.send(approval, address);

        await db.insert(notificationLog).values({
          approval_id: approval.id,
          channel: channelName,
          recipient: address,
          status: result.success ? 'sent' : 'failed',
          sent_at: result.success ? new Date() : undefined,
          error_message: result.error,
          metadata: result.metadata,
        });

        if (result.success) {
          console.log(`[notifications] Sent ${channelName} notification for approval ${approval.id} to ${address}`);
        } else {
          console.warn(`[notifications] Failed ${channelName} notification for approval ${approval.id}: ${result.error}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[notifications] Error sending ${channelName} notification:`, msg);

        await db.insert(notificationLog).values({
          approval_id: approval.id,
          channel: channelName,
          recipient: address,
          status: 'failed',
          error_message: msg,
        }).catch((err) => {
          // ⚠️ INSTRUMENTED DELIBERATELY, by the SAME rule that put the two
          // `channel:'*'` sites in: the console.error above covers the SEND,
          // not this insert. Lose the row and `notification_log` holds no
          // record that this channel was attempted for this approval at all.
          // `fanOut` being @deprecated is not a reason to exempt it — it is
          // still on the live path (routes/webhooks.ts, approvals.ts,
          // execution-approvals.ts, improvement-approvals.ts).
          reportSwallowedFailure(err, {
            service: 'fr-db',
            degradedTo: `no notification_log row for approval ${approval.id} on ${channelName}, so the attempt reads as never made in the per-approval notification audit (the send error itself is on stderr immediately above, and the analytics send-count in routes/tools/analytics.ts reads only 'sent'/'delivered', so neither of those is affected)`,
          });
        });
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Broadcast a decision event to all channels that support it.
   * Used to notify all parties when an approval is complete.
   */
  async notifyDecision(
    approval: ApprovalWithDetails,
    decision: { status: string; decided_by: string; comment?: string },
    recipients: { channel: string; address: string }[],
  ): Promise<void> {
    // Reuse fanOut — the channel adapters check approval.status to format accordingly
    await this.fanOut(
      { ...approval, status: decision.status },
      recipients,
    );
  }

  getChannel(name: string): NotificationChannel | undefined {
    return this.channels.get(name);
  }

  /**
   * Fan-out to a single user using their stored channel preferences.
   *
   * Reads user_channel_prefs via resolveRecipients, dispatches to every
   * enabled channel, and writes an engagement_deliveries row for every attempt
   * — success, failure, or skipped_disabled. Never throws.
   *
   * If the user has no enabled prefs, one `skipped_disabled` audit row is
   * written (channel='*', address='') so the lack of notification is visible.
   */
  async fanOutToUser(
    approval: ApprovalWithDetails,
    userId: string,
    engagementType: string = 'approval',
    actionId: string | null = null,
  ): Promise<void> {
    // E-8 — when this approval is bound to an action invocation, every audit
    // row carries action_id so the Analytics slice can join action telemetry
    // and channel delivery without doing a second hop through `approvals`.
    // ⚠️ A throw here used to leave `recipients` empty and fall into the
    // `skipped_disabled` write below — a status the deliveries audit API exposes
    // as a distinct, filterable fact meaning "the user turned this channel off".
    // So an outage of the preference lookup was recorded as a deliberate opt-out,
    // and an operator asking "why was this person not notified?" got a confident
    // wrong answer from the audit trail itself.
    let recipients: { channel: string; address: string }[] = [];
    let resolveFailed: string | null = null;
    try {
      recipients = await resolveRecipients(userId, approval.tenant_id);
    } catch (err) {
      resolveFailed = err instanceof Error ? err.message : String(err);
      console.error(`[notifications] resolveRecipients(${userId}) failed:`, err);
    }

    if (recipients.length === 0) {
      await db.insert(engagementDeliveries).values({
        engagement_id: approval.id,
        engagement_type: engagementType,
        channel: '*',
        recipient_user_id: userId,
        recipient_address: '',
        // 'failed' when we could not read the preferences at all; only a
        // SUCCESSFUL read returning nothing is an opt-out.
        status: resolveFailed ? 'failed' : 'skipped_disabled',
        error: resolveFailed
          ? `recipient preference lookup failed: ${resolveFailed}`
          : null,
        action_id: actionId,
      }).catch((err) => {
        // ⚠️ The console.error above covers the resolveRecipients failure, NOT
        // this insert. This row IS the visibility mechanism: fanOutToUser's own
        // doc says the skipped_disabled row is written "so the lack of
        // notification is visible".
        // ⛔ The consequence is NOT "an outage reads as a deliberate opt-out" —
        // that mis-read needs a `skipped_disabled` row to EXIST, and when this
        // insert fails there is no row carrying either status. So both branches
        // collapse to ONE true consequence: the attempt (or the deliberate
        // non-attempt) is invisible to the deliveries audit.
        // workers/approval-redelivery.ts:26-31 classifies exactly that
        // population — no `engagement_deliveries` row at all — as minted,
        // addressed to nobody, never attempted (241 of 274 prod rows).
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `no engagement_deliveries row at all for ${engagementType} ${approval.id} / user ${userId} (it would have carried '${resolveFailed ? 'failed' : 'skipped_disabled'}'), so the ${resolveFailed ? 'preference-lookup outage' : 'deliberate opt-out'} is invisible to the deliveries audit: the engagement reads as minted, addressed to nobody, never attempted`,
        });
      });
      return;
    }

    const promises = recipients.map(async ({ channel: channelName, address }) => {
      const channel = this.channels.get(channelName);
      if (!channel) {
        await db.insert(engagementDeliveries).values({
          engagement_id: approval.id,
          engagement_type: engagementType,
          channel: channelName,
          recipient_user_id: userId,
          recipient_address: address,
          status: 'failed',
          error: `channel '${channelName}' not registered`,
          action_id: actionId,
        }).catch((err) => {
          // ⚠️ A swallowed WRITE on a branch with no console.error of its own:
          // this row is the ONLY signal that a channel the user has enabled is
          // not registered in the process, so losing it makes the
          // misconfiguration completely silent.
          reportSwallowedFailure(err, {
            service: 'fr-db',
            degradedTo: `misconfigured channel '${channelName}' for user ${userId} is fully silent; ${engagementType} ${approval.id} reads as never routed to that channel`,
          });
        });
        return;
      }

      // Mirror notifyOriginator's symmetry — adapter throws and adapter
      // returning `{success:false, error}` both flow through a single audit
      // path so every send attempt produces exactly one engagement_deliveries
      // row regardless of whether the transport raised or returned cleanly.
      let result: SendResult;
      try {
        result = await channel.send(approval, address);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[notifications] Error sending ${channelName} to ${userId}:`, msg);
        result = { success: false, error: msg };
      }

      await db.insert(engagementDeliveries).values({
        engagement_id: approval.id,
        engagement_type: engagementType,
        channel: channelName,
        recipient_user_id: userId,
        recipient_address: address,
        status: result.success ? 'sent' : 'failed',
        error: result.error,
        // Failed sends keep their metadata too (Telegram: where it was aimed), so a send
        // that timed out after delivering is still locatable (lib/untagged-reply-guard.ts).
        metadata_json: result.metadata ?? null,
        action_id: actionId,
      }).catch((err) => {
        // ⚠️ A swallowed WRITE, not a swallowed read. `engagement_deliveries`
        // IS the record that the delivery happened, so losing it makes a
        // DELIVERED approval read as never-delivered — which is exactly the
        // predicate approval-redelivery's NO_CONFIRMED_DELIVERY arm re-pushes
        // on, while `notified_at` never stamps.
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `${engagementType} ${approval.id} reads as never delivered to ${userId} on ${channelName}, although it was ${result.success ? 'sent' : 'attempted and failed'}; approval-redelivery will re-push it`,
        });
      });
    });

    await Promise.allSettled(promises);
  }

  /**
   * Fan-out a generic ChannelMessage (text / action-result / etc.) to a single
   * user across their enabled channel prefs. The message-shaped sibling of
   * {@link fanOutToUser} (which is approval-shaped). Used by the decoupled hub
   * endpoint `POST /api/notifications/dispatch` so external callers (n8n) emit
   * notifications through fr instead of owning a messaging channel. Writes one
   * engagement_deliveries row per attempt, keyed on the message correlationId.
   * Never throws.
   */
  async fanOutMessageToUser(
    userId: string,
    message: ChannelMessage,
    engagementType: string = 'notification',
  ): Promise<MessageFanOutOutcome[]> {
    const engagementId = message.correlationId || '';
    // `engagementId` is '' when the message carries no correlationId, which
    // renders `notification  reads as…` (double space) in the reports below.
    // Name the absence instead so the line stays readable in an incident.
    const engagementRef = engagementId || '(no correlation id)';
    // Same defect as fanOutToUser above: a failed preference lookup was recorded
    // as a deliberate opt-out. See the comment there.
    let recipients: { channel: string; address: string }[] = [];
    let resolveFailed: string | null = null;
    try {
      recipients = await resolveRecipients(userId);
    } catch (err) {
      resolveFailed = err instanceof Error ? err.message : String(err);
      console.error(`[notifications] resolveRecipients(${userId}) failed:`, err);
    }

    if (recipients.length === 0) {
      await db.insert(engagementDeliveries).values({
        engagement_id: engagementId,
        engagement_type: engagementType,
        channel: '*',
        recipient_user_id: userId,
        recipient_address: '',
        status: resolveFailed ? 'failed' : 'skipped_disabled',
        error: resolveFailed
          ? `recipient preference lookup failed: ${resolveFailed}`
          : null,
      }).catch((err) => {
        // Same class as the fanOutToUser site above — see the note there,
        // including why BOTH branches carry the same consequence.
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `no engagement_deliveries row at all for ${engagementType} ${engagementRef} / user ${userId} (it would have carried '${resolveFailed ? 'failed' : 'skipped_disabled'}'), so the ${resolveFailed ? 'preference-lookup outage' : 'deliberate opt-out'} is invisible to the deliveries audit: the engagement reads as minted, addressed to nobody, never attempted`,
        });
      });
      return [{ channel: '*', status: resolveFailed ? 'failed' : 'skipped_disabled', ...(resolveFailed ? { error: resolveFailed } : {}) }];
    }
    const recordBeforeSend = RECORD_BEFORE_SEND_ENGAGEMENT_TYPES.has(engagementType);

    const promises = recipients.map(async ({ channel: channelName, address }): Promise<MessageFanOutOutcome> => {
      const channel = this.channels.get(channelName);
      if (!channel) {
        await db.insert(engagementDeliveries).values({
          engagement_id: engagementId,
          engagement_type: engagementType,
          channel: channelName,
          recipient_user_id: userId,
          recipient_address: address,
          status: 'failed',
          error: `channel '${channelName}' not registered`,
        }).catch((err) => {
          // ⚠️ A swallowed WRITE on a branch with no console.error of its own —
          // a channel misconfiguration would otherwise be entirely silent.
          reportSwallowedFailure(err, {
            service: 'fr-db',
            degradedTo: `misconfigured channel '${channelName}' for user ${userId} is fully silent; ${engagementType} ${engagementRef} reads as never routed to that channel`,
          });
        });
        return { channel: channelName, status: 'failed', error: `channel '${channelName}' not registered` };
      }

      // ⛔ RECORD BEFORE SEND (RECORD_BEFORE_SEND_ENGAGEMENT_TYPES, validator 6): the row
      // exists — 'pending', at the location the adapter will post to — before the message can
      // reach anyone. No row ⇒ no send: the untagged-reply guard must never miss it.
      let preRowId: string | null = null;
      if (recordBeforeSend) {
        try {
          preRowId = await insertPendingDelivery({
            engagement_id: engagementId,
            engagement_type: engagementType,
            channel: channelName,
            recipient_user_id: userId,
            recipient_address: address,
            status: 'pending',
            error: null,
            metadata_json: channel.locate?.(address) ?? null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[notifications] ${engagementType} ${engagementRef} NOT sent to ${userId} on ${channelName}: the pre-send delivery record failed (${msg})`,
          );
          return { channel: channelName, status: 'not_sent', error: 'delivery_record_failed' };
        }
      }

      let result: SendResult;
      try {
        result = await channel.sendMessage(address, message);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[notifications] Error sending message ${channelName} to ${userId}:`, msg);
        result = { success: false, error: msg };
      }

      const outcome: MessageFanOutOutcome = {
        channel: channelName,
        status: result.success ? 'sent' : 'failed',
        ...(result.error ? { error: result.error } : {}),
      };
      if (preRowId !== null) {
        // Settle the pre-written row. Until it records `settledAtMs` the guard treats it as
        // newer than every ask; a failed update is swallowed and the row stays 'pending',
        // which still blocks (fail closed).
        await settleDelivery(preRowId, result.success ? 'sent' : 'failed', result).catch((err) => {
          reportSwallowedFailure(err, {
            service: 'fr-db',
            degradedTo: `${engagementType} ${engagementRef} to ${userId} on ${channelName} stays 'pending' although it was ${result.success ? 'sent' : 'attempted and failed'} (it still blocks untagged reply binds there)`,
          });
        });
        return outcome;
      }

      await db.insert(engagementDeliveries).values({
        engagement_id: engagementId,
        engagement_type: engagementType,
        channel: channelName,
        recipient_user_id: userId,
        recipient_address: address,
        status: result.success ? 'sent' : 'failed',
        error: result.error,
        // Failed sends keep their metadata too (Telegram: where it was aimed), so a send
        // that timed out after delivering is still locatable (lib/untagged-reply-guard.ts).
        metadata_json: result.metadata ?? null,
      }).catch((err) => {
        // ⚠️ A swallowed WRITE. Without this row a delivered notification
        // reads as never delivered to this user on this channel.
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `${engagementType} ${engagementRef} reads as never delivered to ${userId} on ${channelName}, although it was ${result.success ? 'sent' : 'attempted and failed'}`,
        });
      });
      return outcome;
    });

    const settled = await Promise.allSettled(promises);
    return settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { channel: recipients[i]!.channel, status: 'failed' as const, error: String(r.reason) },
    );
  }

  /**
   * WS1 Phase 1A — dispatch a non-approval execution event to a single user.
   *
   * Order of operations:
   *   1. Write the durable `notifications` inbox row (the baseline surface).
   *      This is ALWAYS written, independent of external-channel success, and
   *      is not governed by the prefs matrix.
   *   2. Resolve external channels for (user, event_type) via the composed
   *      matrix (notification-prefs.resolveRecipientsForEvent) and send a
   *      `text` message on each, writing one engagement_deliveries audit row
   *      per attempt (engagement_type='execution-event', engagement_id =
   *      the notification row id).
   *
   * Never throws — notification delivery is telemetry and must not fail the
   * caller. Returns the created notification id (null only if the inbox write
   * itself failed).
   */
  async fanOutEventToUser(event: ExecutionEvent, userId: string): Promise<string | null> {
    let notificationId: string | null = null;
    try {
      notificationId = await this.writeEventInboxRow(db, event, userId);
    } catch (err) {
      console.error(`[notifications] inbox insert failed for ${userId}/${event.event_type}:`, err);
      // Continue — still attempt external delivery so a transient inbox write
      // failure doesn't also silence email/telegram/teams.
    }

    await this.deliverEventExternally(event, userId, notificationId);
    return notificationId;
  }

  /**
   * U2 — write the durable `notifications` inbox row for an event THROUGH THE
   * CALLER'S EXECUTOR (a transaction), and THROW on failure.
   *
   * This is the transactional half of `fanOutEventToUser`, for a caller whose
   * domain write and notification must commit or roll back together (the
   * bug_report artifact: a report nobody was told about, or a notification
   * pointing at a report that does not exist, are both refused). Unlike
   * `fanOutEventToUser` it deliberately does NOT swallow: a swallowed insert
   * here would commit the domain row without its notification, which is the
   * exact half-state the transaction exists to prevent.
   *
   * External channels are NOT sent from here — a send cannot be rolled back.
   * The caller calls `deliverEventExternally` AFTER its transaction commits.
   */
  async writeEventInboxRow(
    executor: Pick<typeof db, 'insert'>,
    event: ExecutionEvent,
    userId: string,
  ): Promise<string> {
    const [row] = await executor.insert(notifications).values({
      tenant_id: event.tenant_id,
      user_id: userId,
      event_type: event.event_type,
      severity: event.severity,
      title: event.title,
      body: event.body ?? null,
      link: event.link ?? null,
      project_id: event.project_id ?? null,
      card_id: event.card_id ?? null,
      execution_id: event.execution_id ?? null,
      source: event.source ?? 'n8n',
      correlation_id: event.correlation_id ?? null,
      metadata: event.metadata ?? null,
    }).returning({ id: notifications.id });
    if (!row?.id) {
      throw new Error(`[notifications] inbox insert returned no row for ${userId}/${event.event_type}`);
    }
    return row.id;
  }

  /**
   * The external-channel half of `fanOutEventToUser`: resolve the user's
   * channels for this event type and send, writing one engagement_deliveries
   * row per attempt. Never throws. `notificationId` is the inbox row the sends
   * belong to (null when the inbox write failed).
   */
  async deliverEventExternally(
    event: ExecutionEvent,
    userId: string,
    notificationId: string | null,
  ): Promise<void> {
    // `notificationId` is null when the inbox insert above failed (we
    // deliberately continue). Interpolated raw it renders `execution-event null
    // reads as…`; name the absence so the line is still useful in an incident.
    const eventRef = notificationId
      ? `execution-event ${notificationId}`
      : 'execution-event (no inbox row)';

    const recipients = await resolveRecipientsForEvent(userId, event.event_type);
    if (recipients.length === 0) return;

    const text = event.body ? `${event.title}\n${event.body}` : event.title;
    const correlationId = event.correlation_id || notificationId || event.event_type;

    const promises = recipients.map(async ({ channel: channelName, address }) => {
      const channel = this.channels.get(channelName);
      if (!channel) {
        await db.insert(engagementDeliveries).values({
          engagement_id: notificationId,
          engagement_type: 'execution-event',
          channel: channelName,
          recipient_user_id: userId,
          recipient_address: address,
          status: 'failed',
          error: `channel '${channelName}' not registered`,
        }).catch((err) => {
          // ⚠️ A swallowed WRITE on a branch with no console.error of its own:
          // if this insert fails, a channel the user has enabled but the process
          // never registered leaves no trace at all.
          reportSwallowedFailure(err, {
            service: 'fr-db',
            degradedTo: `misconfigured channel '${channelName}' for user ${userId} is fully silent; ${eventRef} reads as never routed to that channel`,
          });
        });
        return;
      }

      let result: SendResult;
      try {
        result = await channel.sendMessage(address, {
          kind: 'text',
          correlationId,
          text,
          meta: {
            event_type: event.event_type,
            severity: event.severity,
            link: event.link ?? undefined,
            project_id: event.project_id ?? undefined,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[notifications] event send ${channelName} to ${userId} failed:`, msg);
        result = { success: false, error: msg };
      }

      await db.insert(engagementDeliveries).values({
        engagement_id: notificationId,
        engagement_type: 'execution-event',
        channel: channelName,
        recipient_user_id: userId,
        recipient_address: address,
        status: result.success ? 'sent' : 'failed',
        error: result.error,
        // Failed sends keep their metadata too (Telegram: where it was aimed), so a send
        // that timed out after delivering is still locatable (lib/untagged-reply-guard.ts).
        metadata_json: result.metadata ?? null,
      }).catch((err) => {
        // ⚠️ A swallowed WRITE, not a swallowed read. This row IS the record
        // that the event was pushed; without it a delivered execution-event
        // reads as one that was never attempted.
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `${eventRef} reads as never attempted for ${userId} on ${channelName}, although it was ${result.success ? 'sent' : 'attempted and failed'}`,
        });
      });
    });

    await Promise.allSettled(promises);
  }
}

export const notificationService = new NotificationService();

// E-10: register email + voice + in-app adapters at module load. Each
// adapter self-gates on its own env / capability, mirroring how
// teams self-gates today (teams needs config.services.teams.enabled). The
// actual server.ts call site for teams happens there because that adapter
// predates the auto-registration pattern; new E-10 adapters register
// themselves here so server.ts stays untouched.
//
// Email: only registers when both URL + key are set, so a misconfigured
// dev environment doesn't accidentally claim the 'email' channel name and
// then bounce every send with channel-disabled.
//
// Voice: always registers (the stub returns voice-not-implemented for
// every send). Registering unconditionally means user_channel_prefs rows
// targeting 'voice' surface a meaningful error rather than "channel not
// registered".
//
// In-app: always registers. Persistence backs onto the regular DB pool
// that's already required for the service to start at all.
import { emailAdapter } from './adapters/email';
import { voiceAdapter } from './adapters/voice';
import { inappAdapter } from './adapters/inapp';

if (emailAdapter.isEnabled()) {
  notificationService.registerChannel(emailAdapter);
}
notificationService.registerChannel(voiceAdapter);
notificationService.registerChannel(inappAdapter);
