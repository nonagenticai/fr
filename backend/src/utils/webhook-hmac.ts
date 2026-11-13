// src/utils/webhook-hmac.ts
import { createHmac } from 'node:crypto';
import { timingSafeEquals } from './secret-compare';

/**
 * Verify an `X-Metering-Signature: sha256=<hex>` header against the HMAC-SHA256
 * of the RAW request body under `secret`.
 *
 * The signature MUST be computed over the exact bytes received. billing_service
 * signs the canonical JSON it emits (Python `json.dumps(separators=(",",":"),
 * sort_keys=True)`), so the receiver must hash `await req.text()` verbatim —
 * re-serialising the parsed object would reorder keys / change spacing and never
 * match. Comparison is constant-time (see secret-compare.ts).
 *
 * Returns false for a missing or malformed signature header. A missing/blank
 * SECRET is deliberately NOT handled here — callers decide whether an unset
 * secret means "skip verification (dev)" or "reject".
 */
export function verifyMeteringSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return timingSafeEquals(header, expected);
}
