// E-7: Teams inbound channel.
//
// `parseWebhook` recognises *agent-addressable* Teams messages (free-text
// payloads that don't satisfy the legacy `TeamsActionSchema`). Approval-
// callback payloads — every shape the legacy `routes/teams-webhook.ts`
// handler knows about — are passed through by returning `null`, so the
// route falls through to the existing approval handler unchanged.
//
// Stays in `routes/teams-webhook.ts` (per spec): the webhook secret check,
// the JWT verification gate, every approval-flow side effect.
//
// Moves here: only the body parse + free-text extraction needed to decide
// whether to materialise an `InboundMessage`.

import { z } from 'zod';
import type { ChannelInbound, InboundMessage } from './index';
import type { ChannelMessage } from '../domain/engagement/notifications';
import { teamsAdapter } from '../domain/engagement/adapters/teams';

const TeamsActionSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected', 'abstain', 'approve', 'reject']),
  approverId: z.string().uuid().optional(),
  comment: z.string().optional(),
});

// Forward-compatible free-text envelope. The exact shape will firm up when
// the Teams bot gains conversational features; for now we accept either a
// `text` field at the top level (most basic Bot Framework activity shape)
// or a nested `value.text` (adaptive-card free-text input).
const TeamsFreeTextSchema = z
  .object({
    text: z.string().min(1).optional(),
    value: z
      .object({
        text: z.string().min(1).optional(),
      })
      .optional(),
    from: z
      .object({
        id: z.string().optional(),
        aadObjectId: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
    conversation: z
      .object({
        id: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (v) => Boolean(v.text || v.value?.text),
    { message: 'free-text envelope requires text or value.text' },
  );

export const teamsChannel: ChannelInbound = {
  name: 'teams',

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }

    // If it satisfies the legacy approval-callback schema, defer to the
    // existing route handler.
    if (TeamsActionSchema.safeParse(body).success) {
      return null;
    }

    const parsed = TeamsFreeTextSchema.safeParse(body);
    if (!parsed.success) return null;

    const text = parsed.data.text ?? parsed.data.value?.text ?? '';
    if (!text) return null;

    const fromId =
      parsed.data.from?.aadObjectId ||
      parsed.data.from?.id ||
      parsed.data.from?.name ||
      'unknown';
    const conversationId = parsed.data.conversation?.id;

    return {
      channel: 'teams',
      userId: fromId,
      address: fromId,
      text,
      correlationId: crypto.randomUUID(),
      threadId: conversationId,
      raw: body,
    };
  },

  async postReply(threadId: string | undefined, message: ChannelMessage): Promise<void> {
    // Teams replies need a webhook URL to post to. Wave 1: pull it from the
    // adapter's configured channel webhook if no per-thread routing is
    // available yet. The dispatcher can override by setting meta.address.
    const address =
      (typeof message.meta?.address === 'string' && message.meta.address) ||
      threadId ||
      '';
    if (!address) return;
    await teamsAdapter.sendMessage(address, message);
  },
};
