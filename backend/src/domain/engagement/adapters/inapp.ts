// src/domain/engagement/adapters/inapp.ts
// E-10: in-app persistent chat channel. Each outbound message is written to
// `inapp_messages` (direction='outbound'); inbound parsing lives in
// channels/inapp.ts. Address is the recipient userId (UUID).
import { db as defaultDb, inappMessages } from '../../../db/client';
import { approvalNotificationText } from '../approval-menu';
import type {
  NotificationChannel,
  ApprovalWithDetails,
  ChannelMessage,
  SendResult,
} from '../notifications';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InAppAdapter implements NotificationChannel {
  name = 'inapp';

  async send(approval: ApprovalWithDetails, recipientAddress: string): Promise<SendResult> {
    if (!isUuid(recipientAddress)) {
      return { success: false, error: 'inapp address must be a user UUID' };
    }
    // The SAME notification every channel sends (approval-menu.ts).
    const text = await approvalNotificationText(approval, 'inapp');
    return this.persistOutbound(recipientAddress, text, null, {
      approvalId: approval.id,
      status: approval.status,
    });
  }

  async sendMessage(address: string, message: ChannelMessage): Promise<SendResult> {
    if (!isUuid(address)) {
      return { success: false, error: 'inapp address must be a user UUID' };
    }
    if (message.kind === 'approval-request') {
      const approvalId = message.meta?.approvalId;
      if (typeof approvalId !== 'string' || approvalId.length === 0) {
        return { success: false, error: 'approval-request kind requires meta.approvalId' };
      }
    }
    const meta: Record<string, unknown> = { kind: message.kind };
    if (message.meta) Object.assign(meta, message.meta);
    return this.persistOutbound(
      address,
      message.text,
      message.correlationId || null,
      meta,
    );
  }

  private async persistOutbound(
    userId: string,
    text: string,
    correlationId: string | null,
    meta: Record<string, unknown> | null,
  ): Promise<SendResult> {
    try {
      const [row] = await defaultDb.insert(inappMessages).values({
        user_id: userId,
        direction: 'outbound',
        text,
        correlation_id: correlationId,
        meta_json: meta,
      }).returning({ id: inappMessages.id });
      return { success: true, metadata: { messageId: row?.id, userId } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

export const inappAdapter = new InAppAdapter();
