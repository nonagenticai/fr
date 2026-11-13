import { jsonResponse } from '../utils/response';
import { config } from '../config';
import { channelDispatcher } from '../channels';
import { parseMcpBody } from '../channels/mcp';
import { MCP_SIGNATURE_HEADER, MCP_TIMESTAMP_HEADER, verifyMcpSignature } from '../channels/mcp-signature';

/**
 * POST /api/webhooks/mcp/incoming — the MCP server relaying a human's message
 * into the channel dispatcher (channels/mcp.ts).
 *
 * Unlike the Telegram/email receivers this answers with honest statuses: the
 * only sender is our own MCP server, which retries on non-2xx.
 *   401 bad/stale signature (always, while FR_MCP_CHANNEL_SECRET is unset) · 400 bad body
 *   503 channel dispatch off (CHANNEL_DISPATCH_ENABLED) · else the dispatcher's response.
 */
export async function handleMcpIncoming(req: Request): Promise<Response> {
  const { secret } = config.services.mcp;

  const rawBody = await req.clone().text();
  if (!verifyMcpSignature(secret, rawBody, req.headers.get(MCP_TIMESTAMP_HEADER), req.headers.get(MCP_SIGNATURE_HEADER))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (parseMcpBody(rawBody) === null) {
    return jsonResponse({ error: 'bad_request', message: 'body must be {address, text, correlation_id?}' }, 400);
  }

  const dispatched = await channelDispatcher.handleWebhook('mcp', req);
  if (dispatched) return dispatched;
  return jsonResponse({ error: 'channel_dispatch_disabled', retryable: true }, 503);
}
