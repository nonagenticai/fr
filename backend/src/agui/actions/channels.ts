/**
 * Plan 3 follow-up — channels actions (preview + send).
 *
 * Two sibling actions ship together because the read/write split is
 * mandatory at registration time:
 *   - channels.preview_message — read; renders body without dispatching.
 *   - channels.send_message    — write; dispatches via NotificationService.
 *
 * The send path uses the same primitive `notifyOriginator` uses
 * (action-approvals.ts:508): resolveRecipients(userId) → match channel_id
 * → notificationService.getChannel(name).sendMessage(address, message).
 * No template engine in v1 — body is passed through verbatim with
 * `kind: 'text'`. Templating is a Plan 5 concern.
 *
 * Routing (which physical adapter answers a logical channel_id) is the
 * user's channel-prefs mapping; the agent passes the logical name only.
 */

import { z } from 'zod';
import { clientSafeCaughtErrorText } from '../../integrations/_lib/errors';

/**
 * This action's output is STORED: an approved `channels.send_message` runs in
 * `executeApprovedAction`, which writes the handler's return value to
 * `engagement_deliveries.metadata_json` — a row the recipient and tenant admins
 * read back. The adapters' failure text is their caught `err.message` (email,
 * telegram, teams, inapp), which names relay hosts and internal paths.
 * So every adapter-derived string is redacted regardless of the current caller
 * (`forStorage`), and the raw text goes to the log line instead.
 */
const DELIVERY_FAILED = 'delivery failed';
function clientSafeDeliveryError(raw: unknown, where: string): string {
  console.warn(`[channels.send_message] ${where}:`, raw);
  return clientSafeCaughtErrorText(raw, DELIVERY_FAILED, { forStorage: true });
}

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import * as notificationsClient from '../../domain/engagement/notifications';
import * as channelPrefsClient from '../../domain/engagement/channel-prefs';
import { createHash } from 'node:crypto';

// D3 — idempotency keys hash the FULL content. A 64-char prefix made two
// distinct writes sharing a prefix collide onto one cached result.
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const previewInput = z.object({
  channel_id: z.string().min(1),
  body: z.string().min(1).max(8000),
});

const previewOutput = z.object({
  rendered: z.string(),
});

const sendInput = previewInput.extend({
  /** Optional override of the resolved address (useful when the user has multiple). */
  address: z.string().optional(),
});

const sendOutput = z.object({
  delivered_to: z.array(z.string()),
  errors: z.array(z.string()),
});

const previewAction: AgentCallableAction<
  z.infer<typeof previewInput>,
  z.infer<typeof previewOutput>
> = {
  name: 'channels.preview_message',
  kind: 'read',
  description:
    'Render a draft channel message without sending. Use to show the user what would be dispatched before they confirm.',
  input: previewInput,
  output: previewOutput,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (i) => `channels.preview:${i.channel_id}:${sha256Hex(i.body)}`,
  rbac: { type: 'public' },
  handler: async (input): Promise<z.infer<typeof previewOutput>> => {
    return { rendered: `[preview ${input.channel_id}]\n${input.body}` };
  },
};

const sendAction: AgentCallableAction<
  z.infer<typeof sendInput>,
  z.infer<typeof sendOutput>
> = {
  name: 'channels.send_message',
  kind: 'write',
  description:
    "Send a message to a channel via the user's preferred adapter. Returns the addresses the message was delivered to and any per-recipient errors.",
  input: sendInput,
  output: sendOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: false,
  idempotencyKey: (i) =>
    `channels.send:${i.channel_id}:${i.address ?? 'default'}:${sha256Hex(i.body)}`,
  rbac: { type: 'project-member' },
  handler: async (input, ctx: ActionContext) => {
    const channel = notificationsClient.notificationService.getChannel(input.channel_id);
    if (!channel) {
      return {
        delivered_to: [],
        errors: [`channel '${input.channel_id}' not registered`],
      };
    }

    const addresses: string[] = [];
    if (input.address) {
      addresses.push(input.address);
    } else {
      try {
        const recipients = await channelPrefsClient.resolveRecipients(ctx.userId);
        for (const r of recipients) {
          if (r.channel === input.channel_id) addresses.push(r.address);
        }
      } catch (err) {
        return {
          delivered_to: [],
          errors: [
            `resolveRecipients failed: ${clientSafeCaughtErrorText(err, 'recipient lookup failed', { forStorage: true })}`,
          ],
        };
      }
    }

    if (addresses.length === 0) {
      return {
        delivered_to: [],
        errors: [`no address for user ${ctx.userId} on channel ${input.channel_id}`],
      };
    }

    const delivered: string[] = [];
    const errors: string[] = [];
    for (const address of addresses) {
      try {
        const res = await channel.sendMessage(address, {
          kind: 'text',
          correlationId: ctx.correlationId,
          text: input.body,
        });
        if (res.success) {
          delivered.push(`${input.channel_id}:${address}`);
        } else {
          errors.push(
            `${input.channel_id}:${address}: ${clientSafeDeliveryError(res.error ?? 'unknown', input.channel_id)}`,
          );
        }
      } catch (err) {
        errors.push(
          `${input.channel_id}:${address}: ${clientSafeDeliveryError(err, input.channel_id)}`,
        );
      }
    }

    return { delivered_to: delivered, errors };
  },
};

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerChannelsActions(): void {
  safeRegister(previewAction);
  safeRegister(sendAction);
}

registerChannelsActions();

export const channelsSendAction = sendAction;
