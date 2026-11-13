// src/domain/engagement/adapters/mcp.ts
//
// Outbound `mcp` channel: the MCP server is one more engagement channel, like
// Telegram. A user links an `mcp` address (a client-scoped id such as
// `care-bus:<tenant>:<staff id>`) on Communication settings; from then on the
// normal fan-out reaches that address here, and this adapter POSTs a signed JSON
// event to MCP_EVENTS_URL. The MCP server turns an approval into a task
// `input_required`; the human's answer comes back through the inbound channel
// (channels/mcp.ts) as the same reply a Telegram user types (`1`, `2 <reason>`,
// `approve <id>`, …), read by the same reply→decision flow.
//
// Event bodies (all carry `type` and `address`):
//   approval.requested  approval_id, project_id, tenant_id, kind, description,
//                       change_summary?, impact_analysis?, proposed_answer?,
//                       proposed_answer_note?, allowed_decisions,
//                       deblock_actions?, expires_at, text (the notification every
//                       channel sends: the same numbered menu, answered by the same
//                       `1` / `approve: <answer>` / `2 <reason>` reply)
//   approval.closed     approval_id, project_id, tenant_id, final_status
//   (both approval events carry correlation_id = metadata.mcp_run_id when an n8n
//   run started from MCP asked the question, so the MCP server reaches its task)
//   message             kind, text, correlation_id, meta (replies and results)
import { createHash } from 'node:crypto';
import { config } from '../../../config';
import { signMcpBody } from '../../../channels/mcp-signature';
import type { ApprovalWithDetails, ChannelMessage, NotificationChannel, SendResult } from '../notifications';
import { PROPOSED_ANSWER_NOTE, proposedAnswer } from '../deblock-actions';
import { approvalNotificationText } from '../approval-menu';

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function approvalEvent(
  approval: ApprovalWithDetails,
  address: string,
  /** The notification text every channel sends (`approvalNotificationText`). */
  text?: string,
): Record<string, unknown> {
  const base = {
    address,
    approval_id: approval.id,
    project_id: approval.project_id,
    tenant_id: approval.tenant_id ?? null,
    correlation_id: optionalString(approval.metadata?.mcp_run_id) ?? null,
  };
  if (approval.status !== 'pending') {
    return { type: 'approval.closed', ...base, final_status: approval.status };
  }
  const meta = approval.metadata ?? {};
  const deblock = Array.isArray(meta.deblock_actions) ? meta.deblock_actions : undefined;
  const proposal = proposedAnswer(meta);
  return {
    type: 'approval.requested',
    ...base,
    kind: approval.kind ?? null,
    description: approval.description,
    change_summary: optionalString(meta.change_summary),
    impact_analysis: optionalString(meta.impact_analysis),
    proposed_answer: proposal ?? undefined,
    proposed_answer_note: proposal !== null ? PROPOSED_ANSWER_NOTE : undefined,
    allowed_decisions: ['approved', 'rejected'],
    deblock_actions: deblock,
    expires_at: approval.expires_at ? approval.expires_at.toISOString() : null,
    text,
  };
}

export class McpAdapter implements NotificationChannel {
  name = 'mcp';

  async send(approval: ApprovalWithDetails, recipientAddress: string): Promise<SendResult> {
    const text = approval.status === 'pending' ? await approvalNotificationText(approval, 'mcp') : undefined;
    return this.post(approvalEvent(approval, recipientAddress, text));
  }

  sendMessage(address: string, message: ChannelMessage): Promise<SendResult> {
    return this.post({
      type: 'message',
      address,
      kind: message.kind,
      text: message.text,
      correlation_id: message.correlationId || null,
      meta: 'meta' in message ? (message.meta ?? null) : null,
    });
  }

  private async post(event: Record<string, unknown>): Promise<SendResult> {
    const { eventsUrl, secret } = config.services.mcp;
    if (!eventsUrl || !secret) return { success: false, error: 'mcp channel not configured' };
    const body = JSON.stringify(event);
    try {
      const res = await fetch(eventsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Derived from the body, so a redelivery of the same event carries the same key.
          'Idempotency-Key': createHash('sha256').update(body).digest('hex'),
          ...signMcpBody(secret, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { success: false, error: `mcp events ${res.status}` };
      return { success: true, metadata: { status: res.status } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const mcpAdapter = new McpAdapter();
