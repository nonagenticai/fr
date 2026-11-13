/**
 * Plan 3 — shared NDJSON encoder so `routes/agui.ts` and `routes/agent.ts`
 * use the same wire format. Promote any future per-event helpers here.
 *
 * NDJSON is a single JSON value per line, terminated with `\n`. The reader
 * splits on `\n` and parses each line independently; partial buffering is
 * the reader's responsibility.
 */

const encoder = new TextEncoder();

export function ndjsonLine(ev: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(ev) + '\n');
}
