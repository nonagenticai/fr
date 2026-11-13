// src/connectors/_helpers.ts
// Shared helpers for connector dryRun + general consumption.
// Spec 2 Plan 2-C Phase 3.

import type { FetchedRecord } from './types';
import { ConnectorError } from './types';

/**
 * Consume up to `n` items from an async generator and return them as an
 * array. Stops as soon as `n` items have been yielded OR the generator
 * is exhausted, whichever comes first.
 *
 * Used by `dryRun` to bound resource consumption from `fetch` (e.g. the
 * github_query connector defaults to up to 1000 results — for a UI test
 * connection we want at most 3).
 */
export async function takeAsyncIter<T>(
  gen: AsyncGenerator<T>,
  n: number,
): Promise<T[]> {
  if (n <= 0) return [];
  const out: T[] = [];
  try {
    for await (const item of gen) {
      out.push(item);
      if (out.length >= n) break;
    }
  } finally {
    // Best-effort cleanup of underlying generator (some implementations
    // open file handles / sockets that need to be released).
    try {
      await gen.return(undefined as unknown as T);
    } catch {
      // ignore — generator already closed or threw on return
    }
  }
  return out;
}

/**
 * Truncate a single string field to ~maxLen characters with an ellipsis
 * marker so a "Test connection" sample preview cannot leak the full
 * upstream payload (which may contain credentials echoed back, large
 * binary blobs, or PII not intended for the UI).
 */
function truncateString(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…(truncated ${s.length - maxLen} chars)`;
}

/**
 * Recursively walk a record's `raw` payload and truncate every string
 * leaf to `maxLen`. Object/array structure is preserved so the FE can
 * still pick out a `title` field for display. Non-JSON-serializable
 * values are coerced to a placeholder.
 *
 * `maxLen` is per-string-field, not the whole serialized record — the
 * route-level wrapper enforces an additional outer bound.
 */
export function truncateRawForPreview(value: unknown, maxLen = 512): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value, maxLen);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((v) => truncateRawForPreview(v, maxLen));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateRawForPreview(v, maxLen);
    }
    return out;
  }
  // bigint, function, symbol — not safe to serialize
  return `[unserializable:${typeof value}]`;
}

/**
 * Apply `truncateRawForPreview` to a sample record array. The
 * `stable_id` field is itself truncated (a 16-char hash is fine; a
 * pathological 5MB id is not).
 */
export function truncateSampleForPreview(
  records: FetchedRecord[],
  maxStringLen = 512,
): FetchedRecord[] {
  return records.map((r) => ({
    stable_id: truncateString(r.stable_id, maxStringLen),
    raw: truncateRawForPreview(r.raw, maxStringLen),
  }));
}

/**
 * Map an unknown thrown value into a `{ code, message }` envelope
 * suitable for `DryRunResult.error`. ConnectorError keeps its code;
 * everything else is bucketed into UPSTREAM_ERROR with the message
 * preserved.
 */
/** H1: cap on every dry-run error message — a message is never a data channel. */
export const DRY_RUN_ERROR_MESSAGE_MAX = 200;

function capMessage(message: string): string {
  return message.length > DRY_RUN_ERROR_MESSAGE_MAX
    ? message.slice(0, DRY_RUN_ERROR_MESSAGE_MAX)
    : message;
}

export function errorToDryRunError(
  err: unknown,
): { code: string; message: string } {
  if (err instanceof ConnectorError) {
    // ConnectorError.message is `[CODE] <msg>` per its constructor; the
    // code is already on the instance. Strip the prefix for cleaner UX
    // since `code` carries it explicitly.
    const raw = err.message;
    const stripped = raw.startsWith(`[${err.code}] `)
      ? raw.slice(err.code.length + 3)
      : raw;
    return { code: err.code, message: capMessage(stripped) };
  }
  if (err instanceof Error) {
    return { code: 'UPSTREAM_ERROR', message: capMessage(err.message) };
  }
  return { code: 'UPSTREAM_ERROR', message: capMessage(String(err)) };
}
