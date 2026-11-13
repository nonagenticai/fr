// src/channels/mcp.ts
//
// Inbound `mcp` channel. The MCP server is a channel like Telegram: it relays a
// human's message from its client (care-bus first) and fr runs it through the
// ONE channel pipeline (`dispatchInbound`): identity → intent → tenant →
// capability → reply. Nothing here decides anything.
//
// Body (signed, see ./mcp-signature.ts):
//   { "address": "<client-scoped user id, e.g. care-bus:<tenant>:<staff id>>",
//     "text": "<the same command a Telegram user types>",
//     "correlation_id": "<MCP task / run id>" }
//
// `text` is what a Telegram user would type. An answer to an approval (`1`, `approve`,
// `2 <reason>`, `approve: <answer>`, `#<short id>`, an `[ApprovalId:…]` tag) is read by the
// ONE reply→decision flow every channel shares (`runChannelTurn`, run by the dispatcher
// before the agent sees the text); anything else — `start <type> <title>`, `approve <id>`,
// `status`, `help`, `<action.name> {json}` — goes to the command grammar as on any channel.

// Replies (pending approvals, results, errors) go back out through the `mcp`
// outbound adapter as `message` events; the HTTP response also carries the
// dispatch outcome for the synchronous caller.
import { config } from '../config';
import { mcpAdapter } from '../domain/engagement/adapters/mcp';
import type { ChannelMessage } from '../domain/engagement/notifications';
import type { ChannelInbound, InboundMessage } from './index';
import { isUuidShape } from '../lib/uuid-shape';
import { MCP_SIGNATURE_HEADER, MCP_TIMESTAMP_HEADER, verifyMcpSignature } from './mcp-signature';

const MAX_TEXT = 4000;

/** Parse a VERIFIED raw body. Exported pure for tests. */
export function parseMcpBody(rawBody: string): InboundMessage | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const b = body as { address?: unknown; text?: unknown; correlation_id?: unknown; job?: unknown; on_behalf_of?: unknown };
  if (typeof b.address !== 'string' || b.address.length === 0 || b.address.length > 512) return null;
  if (typeof b.text !== 'string' || b.text.trim().length === 0 || b.text.length > MAX_TEXT) return null;
  // nonagenticai_mcp_server #64: optional `job` (uuid) and `on_behalf_of` (1–256 chars). A
  // present but malformed value makes the whole body malformed, never silently dropped.
  if (b.job !== undefined && b.job !== null && (typeof b.job !== 'string' || !isUuidShape(b.job))) return null;
  if (
    b.on_behalf_of !== undefined &&
    b.on_behalf_of !== null &&
    (typeof b.on_behalf_of !== 'string' || b.on_behalf_of.length < 1 || b.on_behalf_of.length > 256)
  ) {
    return null;
  }
  const correlationId =
    typeof b.correlation_id === 'string' && b.correlation_id.length > 0 ? b.correlation_id : crypto.randomUUID();
  return {
    channel: 'mcp',
    userId: '',
    address: b.address,
    text: b.text.trim(),
    correlationId,
    // The reply goes back to the sending address.
    threadId: b.address,
    raw: body,
    ...(typeof b.on_behalf_of === 'string' ? { onBehalfOf: b.on_behalf_of } : {}),
    ...(typeof b.job === 'string' ? { jobId: b.job } : {}),
  };
}

export const mcpChannel: ChannelInbound = {
  name: 'mcp',

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    const rawBody = await req.text();
    const ok = verifyMcpSignature(
      config.services.mcp.secret,
      rawBody,
      req.headers.get(MCP_TIMESTAMP_HEADER),
      req.headers.get(MCP_SIGNATURE_HEADER),
    );
    return ok ? parseMcpBody(rawBody) : null;
  },

  async postReply(threadId: string | undefined, message: ChannelMessage): Promise<void> {
    if (!threadId) return;
    const res = await mcpAdapter.sendMessage(threadId, message);
    if (!res.success) throw new Error(`mcp reply failed: ${res.error ?? 'unknown'}`);
  },
};
