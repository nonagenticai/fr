// E-10: in-app inbound channel.
//
// `parseWebhook` parses JSON `{userId, text, threadId?, correlationId?}`
// posted by the FR web client. Each parsed message also writes an
// `inapp_messages` row with direction='inbound' so chat history stays
// authoritative on the server.
import { z } from 'zod';
import type { ChannelInbound, InboundMessage } from './index';
import type { ChannelMessage } from '../domain/engagement/notifications';
import { db, inappMessages } from '../db/client';
import { inappAdapter } from '../domain/engagement/adapters/inapp';

const InAppEnvelopeSchema = z.object({
  userId: z.string().uuid(),
  text: z.string().min(1),
  threadId: z.string().optional(),
  correlationId: z.string().optional(),
});

export const inappChannel: ChannelInbound = {
  name: 'inapp',

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }
    const parsed = InAppEnvelopeSchema.safeParse(body);
    if (!parsed.success) return null;

    const { userId, text, threadId } = parsed.data;
    const correlationId = parsed.data.correlationId || crypto.randomUUID();

    // Persist the inbound message — best-effort. Even if the insert fails
    // we still hand the message to the dispatcher so the user gets a reply;
    // history loss is preferable to dropped commands.
    try {
      await db.insert(inappMessages).values({
        user_id: userId,
        direction: 'inbound',
        text,
        correlation_id: correlationId,
        meta_json: threadId ? { threadId } : null,
      });
    } catch (err) {
      console.error(
        '[channels.inapp] failed to persist inbound message:',
        err instanceof Error ? err.message : err,
      );
    }

    return {
      channel: 'inapp',
      userId,
      address: userId,
      text,
      correlationId,
      threadId,
      raw: body,
    };
  },

  async postReply(_threadId: string | undefined, message: ChannelMessage): Promise<void> {
    // The dispatcher passes the recipient userId via meta.address (the
    // telegram/teams convention). Without it we have nowhere to deliver.
    const address = typeof message.meta?.address === 'string' ? message.meta.address : '';
    if (!address) return;
    await inappAdapter.sendMessage(address, message);
  },
};
