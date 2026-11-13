// src/domain/engagement/adapters/teams.ts
// Microsoft Teams notification channel — posts adaptive cards to a Teams
// Incoming Webhook URL. The `recipientAddress` passed to send() IS the
// webhook URL (so a single approval can fan out to multiple channels, each
// with their own webhook URL recorded on the approval recipients list).
//
// Transport-only: no domain state is owned here. All consensus + broadcast
// logic lives in src/services/approval-consensus.ts and the webhook route.
import { approvalNotificationText } from '../approval-menu';
import { config } from '../../../config';
import { createHttpClient } from '../../../integrations/_lib/http-client';
import type {
  NotificationChannel,
  ApprovalWithDetails,
  ChannelMessage,
  SendResult,
} from '../notifications';
import { tryGetRequestContext } from '../../../integrations/_lib/context';

export class TeamsAdapter implements NotificationChannel {
  name = 'teams';

  async send(
    approval: ApprovalWithDetails,
    recipientAddress: string,
  ): Promise<SendResult> {
    if (!config.services.teams.enabled) {
      return { success: false, error: 'channel-disabled' };
    }

    const webhookUrl = recipientAddress || config.services.teams.webhookUrl;
    if (!webhookUrl) {
      return { success: false, error: 'channel-disabled' };
    }

    const card = await this.buildAdaptiveCard(approval);
    return this.postToTeams(webhookUrl, card);
  }

  /**
   * Generic ChannelMessage transport (E-6).
   */
  async sendMessage(address: string, message: ChannelMessage): Promise<SendResult> {
    if (!config.services.teams.enabled) {
      return { success: false, error: 'channel-disabled' };
    }

    const webhookUrl = address || config.services.teams.webhookUrl;
    if (!webhookUrl) {
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

    const payload = buildTeamsPayload(message, correlationId);
    return this.postToTeams(webhookUrl, payload);
  }

  private async postToTeams(webhookUrl: string, payload: Record<string, unknown>): Promise<SendResult> {
    try {
      // Use the shared http-client for consistency with Phase 2/3 adapters.
      // The webhook URL is absolute, so baseUrl is ignored by fetch() when
      // the path starts with http(s)://.
      const client = createHttpClient({
        serviceName: 'teams',
        baseUrl: webhookUrl,
        defaultTimeoutMs: 30_000,
        // NEVER the end user's Keycloak JWT. An Incoming Webhook authenticates
        // by the secret embedded in its own URL and reads no `Authorization`
        // header at all, so forwarding one buys nothing — and the destination
        // here is not fixed infrastructure: `send()` takes the webhook URL as
        // the RECIPIENT ADDRESS (see :30 and :47, and config.ts:179 "multiple
        // Teams channels can be targeted per approval"), so the URL arrives as
        // per-approval data. Sending a live end-user bearer to an address
        // supplied by data, at a third party outside this estate, is a
        // credential-egress path, not a degraded auth mode. Dormant today —
        // TEAMS_ENABLED is unset and defaults false (config.ts:181) — which is
        // exactly when it is cheap to close.
        sendAuthorization: false,
        retry: { attempts: 1, backoffMs: 0 },
      });

      const res = await client.fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        noRetry: true,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Teams webhook ${res.status}: ${text.slice(0, 256)}` };
      }

      // Teams incoming webhooks typically reply "1" with 200 on success.
      const messageId = res.headers.get('request-id') || undefined;
      return {
        success: true,
        metadata: { messageId, webhookUrl: redactWebhook(webhookUrl) },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  }

  /**
   * Build an adaptive-card JSON payload for a Teams Incoming Webhook.
   * Content differs between the initial request (pending) and a decision
   * notification — mirrors the Telegram adapter's dual message shape.
   */
  private async buildAdaptiveCard(approval: ApprovalWithDetails): Promise<Record<string, unknown>> {
    if (approval.status !== 'pending') {
      const verb = approval.status === 'approved' ? 'APPROVED' : 'REJECTED';
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `Approval ${verb}` },
                { type: 'TextBlock', text: approval.description, wrap: true },
                // The machine-readable tag, on the DECIDED card too — see
                // `approvalTagBlock` for why the human-readable `Approval ID:` line was
                // not enough. On this card it buys the ability to answer a late reply
                // with "this approval has already been <status>" instead of silence.
                approvalTagBlock(approval.id),
              ],
            },
          },
        ],
      };
    }

    // The SAME notification every channel sends (approval-menu.ts): description, proposed
    // answer, the numbered menu a typed reply answers, and the `[ApprovalId:…]` tag. The
    // buttons below are the same decisions in clickable form.
    return buildApprovalRequestCard({
      title: 'Approval Required',
      body: await approvalNotificationText(approval, 'teams'),
      approvalId: approval.id,
      tagInBody: true,
    });
  }
}

/**
 * The subtle footer TextBlock that carries the approval's identity on a Teams card.
 *
 * ⛔ WHY THE TEXT CHANGED FROM `Approval ID: <uuid>` TO `[ApprovalId:<uuid>]`.
 * `routes/telegram-webhook.ts :: extractApprovalId` — the ONE function every chat seat
 * uses to work out which approval a typed reply is about — matches
 * `/\[ApprovalId:([0-9a-f-]{36})\]/i`. The Telegram, Email and in-app adapters all
 * emit exactly that token (`adapters/telegram.ts:306`, `email.ts:103`,
 * `inapp.ts:35`). This adapter emitted the uuid in prose instead, so a Teams card was the
 * only outbound approval notification in fr whose quoted text could NEVER be resolved back
 * to its approval: the regex does not match `Approval ID: <uuid>`, and a human quoting the
 * card therefore carried an identifier no code path could read.
 *
 * The prose label is not kept alongside the tag. Printing the same uuid twice on a card
 * that is already footnote-sized reads as a bug, and `[ApprovalId:…]` is itself legible —
 * it is precisely what the other four adapters show their users.
 *
 * ⛔ THE `Action.Http` BUTTONS ARE UNTOUCHED AND MUST STAY. They are the PRIMARY decision
 * path on Teams (the structured `TeamsActionSchema` callback, which carries a `comment`
 * field and is the only Teams path `routes/teams-webhook.ts` accepts). This tag is an
 * ADDITION for the quote-and-reply case, not a replacement for them.
 *
 * ⚠️ WHAT THIS DOES **NOT** DO, stated so nobody reads more into it than is there.
 * Emitting the tag makes a typed Teams reply *resolvable*; it does not make one
 * *decidable*. A free-text Teams message still goes to `channelDispatcher` →
 * `channels/teams.ts`, and with `CHANNEL_DISPATCH_ENABLED=false` it falls into
 * `handleTeamsIncoming`, fails `TeamsActionSchema`, and is answered `400 invalid payload`.
 * Wiring a typed Teams decision would need an approver identity this route does not have
 * (a Bot Framework activity's `from.aadObjectId` is not a verified JWT claim), and
 * inventing one on an unauthenticated route is the bypass wearing the shape of a fix. Left
 * as an open gap on purpose.
 *
 * An empty id yields no tag at all rather than a malformed `[ApprovalId:]` that the regex
 * would never match anyway — `sendMessage` already refuses the `approval-request` kind
 * without `meta.approvalId`, so this is belt-and-braces for the direct `buildTeamsPayload`
 * path.
 */
function approvalTagBlock(approvalId: string): Record<string, unknown> {
  return {
    type: 'TextBlock',
    text: approvalId ? `[ApprovalId:${approvalId}]` : '',
    isSubtle: true,
    size: 'Small',
    wrap: true,
  };
}

/**
 * Build a Teams adaptive card for an approval-request message.
 * Shared between the legacy `send(approval)` path and the new
 * `sendMessage({kind: 'approval-request'})` path.
 */
function buildApprovalRequestCard(args: {
  title: string;
  body: string;
  approvalId: string;
  /** The body already carries the `[ApprovalId:…]` tag (the shared notification text). */
  tagInBody?: boolean;
}): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: args.title },
            { type: 'TextBlock', text: args.body, wrap: true },
            ...(args.tagInBody ? [] : [approvalTagBlock(args.approvalId)]),
          ],
          actions: [
            {
              type: 'Action.Http',
              title: 'Approve',
              method: 'POST',
              url: teamsCallbackUrl(),
              body: JSON.stringify({ approvalId: args.approvalId, decision: 'approved' }),
              headers: [{ name: 'Content-Type', value: 'application/json' }],
            },
            {
              type: 'Action.Http',
              title: 'Reject',
              method: 'POST',
              url: teamsCallbackUrl(),
              body: JSON.stringify({ approvalId: args.approvalId, decision: 'rejected' }),
              headers: [{ name: 'Content-Type', value: 'application/json' }],
            },
            {
              type: 'Action.Http',
              title: 'Abstain',
              method: 'POST',
              url: teamsCallbackUrl(),
              body: JSON.stringify({ approvalId: args.approvalId, decision: 'abstain' }),
              headers: [{ name: 'Content-Type', value: 'application/json' }],
            },
          ],
        },
      },
    ],
  };
}

/**
 * Build a simple adaptive card with just text (used for text/action-result/action-error).
 * `emphasis` applies a subtle color styling on action-error.
 */
function buildSimpleCard(args: {
  title?: string;
  body: string;
  variant: 'neutral' | 'success' | 'error';
}): Record<string, unknown> {
  const titleColor =
    args.variant === 'error' ? 'attention'
    : args.variant === 'success' ? 'good'
    : 'default';

  const body: Record<string, unknown>[] = [];
  if (args.title) {
    body.push({ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: args.title, color: titleColor });
  }
  body.push({ type: 'TextBlock', text: args.body, wrap: true });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}

/**
 * Render a ChannelMessage as a Teams webhook payload.
 * correlationId is attached as a top-level property on the POST body —
 * Teams ignores unknown fields but it's available to any intermediate proxy
 * / log sink for correlation.
 */
function buildTeamsPayload(message: ChannelMessage, correlationId: string): Record<string, unknown> {
  let card: Record<string, unknown>;

  switch (message.kind) {
    case 'approval-request': {
      const approvalId = typeof message.meta?.approvalId === 'string'
        ? message.meta.approvalId as string
        : '';
      const projectName = typeof message.meta?.projectName === 'string'
        ? message.meta.projectName as string
        : undefined;
      card = buildApprovalRequestCard({
        title: projectName ? `Approval Required: ${projectName}` : 'Approval Required',
        body: message.text,
        approvalId,
      });
      break;
    }
    case 'action-result':
      card = buildSimpleCard({ title: 'Action Completed', body: message.text, variant: 'success' });
      break;
    case 'action-error':
      card = buildSimpleCard({ title: 'Action Failed', body: message.text, variant: 'error' });
      break;
    case 'text':
    default:
      card = buildSimpleCard({ body: message.text, variant: 'neutral' });
      break;
  }

  if (correlationId) {
    return { ...card, correlationId };
  }
  return card;
}

function teamsCallbackUrl(): string {
  // No hardcoded fallback per config-externalization-policy.md;
  // `validateProductionConfig` enforces TEAMS_CALLBACK_URL is set in
  // production. In dev/test, returns '' and the adaptive-card action
  // simply links to an empty target — adapters handle the empty case
  // upstream (the teams channel is gated by `services.teams.enabled`).
  return process.env.TEAMS_CALLBACK_URL || '';
}

/** Redact the token portion of a Teams webhook URL for logging. */
function redactWebhook(url: string): string {
  return url.replace(/\/[^/]{40,}$/, '/<redacted>');
}

export const teamsAdapter = new TeamsAdapter();
