// src/channels/mcp-signature.ts
//
// The `mcp` channel's request signature, used in BOTH directions (MCP server →
// fr inbound, fr → MCP server events) with the one shared FR_MCP_CHANNEL_SECRET:
//
//   X-Channel-Timestamp: <unix seconds>
//   X-Channel-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
//
// The timestamp is inside the MAC and must be within MAX_SKEW_SECONDS of the
// receiver's clock, so a captured request cannot be replayed later.
import { createHmac } from 'node:crypto';
import { timingSafeEquals } from '../utils/secret-compare';

export const MCP_SIGNATURE_HEADER = 'X-Channel-Signature';
export const MCP_TIMESTAMP_HEADER = 'X-Channel-Timestamp';
export const MAX_SKEW_SECONDS = 300;

function mac(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Headers for an outbound signed body. */
export function signMcpBody(secret: string, rawBody: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { [MCP_TIMESTAMP_HEADER]: timestamp, [MCP_SIGNATURE_HEADER]: mac(secret, timestamp, rawBody) };
}

/**
 * True when the signature matches and the timestamp is fresh. A blank secret
 * never verifies: the channel fails closed when unconfigured.
 */
export function verifyMcpSignature(
  secret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  return timingSafeEquals(signature, mac(secret, timestamp, rawBody));
}
