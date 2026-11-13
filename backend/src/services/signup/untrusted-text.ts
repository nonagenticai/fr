// src/services/signup/untrusted-text.ts — one-line, printable text from a stranger.
//
// Copied from commonpractice `backend/src/utils/untrusted-text.ts` (early-access v2). Requester-typed
// `name` / `company` end up in a Telegram message George acts on. A newline, a bidi override or a
// zero-width character there would let a requester forge lines of that message ("Trusted via: …",
// a fake "Signup id:") or visually reorder it. So the fields are normalised at INPUT VALIDATION and
// again at render (services/signup/telegram.ts).
import { z } from 'zod';

// Cc = C0/C1 controls (incl. \t \n \r, DEL), Zl/Zp = U+2028/U+2029: all become a SPACE.
const BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// Cf = format characters: bidi embeddings/overrides/isolates, LRM/RLM, zero-width, BOM: removed.
const INVISIBLE = /\p{Cf}/gu;
const SPACES = /[\s\p{Zs}]+/gu;

/** Strip control/format characters, collapse whitespace, trim. Never returns a line break. */
export function singleLine(value: string): string {
  return value.replace(BREAKING, ' ').replace(INVISIBLE, '').replace(SPACES, ' ').trim();
}

/** A requester-typed single-line field: normalised, then 1..max characters (empty after stripping = 422). */
export function singleLineText(max: number, rawMax = max * 4) {
  return z.string().max(rawMax).transform(singleLine).pipe(z.string().min(1).max(max));
}

const NEWLINES = /\r\n?|[\p{Zl}\p{Zp}]/gu;
const CONTROLS_BUT_NEWLINE = /[^\P{Cc}\n]/gu;

/** Strip control/format characters except `\n`, normalise line endings, trim. */
export function multiLine(value: string): string {
  return value
    .replace(NEWLINES, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROLS_BUT_NEWLINE, '')
    .replace(INVISIBLE, '')
    .trim();
}

/** A requester-typed multi-line field: normalised, 0..max characters; empty → undefined. */
export function multiLineText(max: number, rawMax = max * 4) {
  return z
    .string()
    .max(rawMax)
    .transform(multiLine)
    .pipe(z.string().max(max))
    .transform((v) => (v === '' ? undefined : v));
}
