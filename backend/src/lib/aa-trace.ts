// src/lib/aa-trace.ts
//
// AA-TRACE join key (~/.claude/plans/program/30-specs-contracts/AA-TRACE-join-key-SPEC.md).
//
//   §1  | `trace_id` | UUIDv7 | Minted ONCE, by the first n8n execution triggered by a
//       Planka card event (Router), or by fr for fr-originated actions … It never
//       changes downstream. |
//   §2  propagated as the HTTP header `X-AA-Trace-Id` on every internal call. An
//       inbound request with no `X-AA-Trace-Id` ⇒ recorded with `trace_id = NULL`
//       (orphan) — it is NOT refused; §4 makes a missing trace UNPROVEN in a proof
//       run, which needs the row to exist to be counted.
//
// PURE: no db, no env.

import { ValidationError, BadRequestError } from '../utils/errors';

export const AA_TRACE_HEADER = 'X-AA-Trace-Id';

/** RFC 9562 UUID version 7: version nibble `7`, variant `10xx` (8/9/a/b). */
export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTraceId(v: unknown): v is string {
  return typeof v === 'string' && UUID_V7_RE.test(v);
}

/**
 * The trace_id a write carries: the `X-AA-Trace-Id` header (the spec's carrier)
 * and/or a body `trace_id` (an n8n HTTP node's convenience). Lowercased.
 *   - neither         → null (an orphan write; stored, never refused)
 *   - malformed       → 422 `trace_id_malformed`
 *   - both, differing → 400 `trace_id_conflict` (two runs claim one write)
 */
export function resolveTraceId(header: string | null | undefined, body: string | null | undefined): string | null {
  const h = header == null || header.trim() === '' ? null : header.trim();
  const b = body == null ? null : body;
  for (const [where, v] of [
    ['header', h],
    ['body', b],
  ] as const) {
    if (v !== null && !isTraceId(v)) {
      throw new ValidationError(
        `trace_id (${where}) must be a UUIDv7 per AA-TRACE §1, got ${JSON.stringify(v)}`,
      ).withCode('trace_id_malformed');
    }
  }
  if (h !== null && b !== null && h.toLowerCase() !== b.toLowerCase()) {
    throw new BadRequestError(`${AA_TRACE_HEADER} header and body trace_id disagree`, {
      header: h,
      body: b,
    }).withCode('trace_id_conflict');
  }
  const v = h ?? b;
  return v === null ? null : v.toLowerCase();
}

// ── fr-originated actions (an approval decision): adopt or MINT, never refuse ──────────
// §1 makes fr the minter for its own actions. The decide path must never fail because a
// caller sent a bad header, so this never throws: a valid UUIDv7 header is adopted
// (lowercased); an absent or malformed one gets ONE freshly minted UUIDv7, and a malformed
// one is logged as a warning, an absent one at info (the malformed value is not stored — the join key is a UUIDv7 or nothing joins).

/** Mint an RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10, random rest. */
function mintUuidV7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The trace id an fr-originated action records: the request's `X-AA-Trace-Id` when it is a
 * UUIDv7 (lowercased), otherwise ONE freshly minted UUIDv7. Never throws.
 */
export function traceIdOrMint(headers: Headers): string {
  const raw = headers.get(AA_TRACE_HEADER)?.trim() ?? '';
  if (UUID_V7_RE.test(raw)) return raw.toLowerCase();
  const minted = mintUuidV7();
  if (raw !== '') {
    console.warn(
      `[aa-trace] malformed ${AA_TRACE_HEADER} ${JSON.stringify(raw.slice(0, 80))} ignored; minted ${minted}`,
    );
  } else {
    console.info(`[aa-trace] no ${AA_TRACE_HEADER} on an fr-originated action; minted ${minted}`);
  }
  return minted;
}
