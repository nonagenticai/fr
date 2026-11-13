// Pure render helpers for the verification surface.
//
// ⛔ The one rule every function here obeys: a `null` is "not measured" and is
// rendered as words, never as 0 / 0% / 0.00. The contract says "never
// fabricate a zero"; the UI is the last place that could still do it.

/** The literal text shown for an unmeasured value. */
export const NO_DATA_TEXT = 'no data';

/** A finite number, or not measured. Anything else (null, undefined, a string, NaN) is "not measured". */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return NO_DATA_TEXT;
  return `${(v * 100).toFixed(digits)}%`;
}

export function num(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return NO_DATA_TEXT;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(digits);
}

/** `v.toFixed(digits)`, or "no data" for anything that is not a finite number. */
export function fixed(v: number | null | undefined, digits: number): string {
  return isNum(v) ? v.toFixed(digits) : NO_DATA_TEXT;
}

export function signed(v: number | null | undefined, digits = 3): string {
  if (!isNum(v)) return NO_DATA_TEXT;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

/** ISO → "2026-09-22 09:01 UTC". Unparseable → the raw string. */
export function utc(iso: string | null | undefined): string {
  if (!iso || typeof iso !== 'string') return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Relative age ("3h ago"). Future times read "in the future", never negative. */
export function relAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso || typeof iso !== 'string') return 'unknown age';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown age';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'in the future';
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Wilson / Newcombe interval rendering; any null end → not measurable. */
export function ciText(
  ci: [number | null, number | null] | null | undefined,
  fmt: (v: number) => string = (v) => v.toFixed(3),
): string {
  if (!Array.isArray(ci) || !isNum(ci[0]) || !isNum(ci[1])) return 'CI n/a';
  return `95% CI [${fmt(ci[0])}, ${fmt(ci[1])}]`;
}

/** A value that is an array, or an empty array. Contract fields may be null. */
export function arr<T>(v: readonly T[] | null | undefined): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Object.entries of a record that may be null. */
export function entries<V>(v: Record<string, V> | null | undefined): [string, V][] {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [];
}

/** A count for display: a number verbatim, anything else "no data" (never a fabricated 0). */
export function count(v: unknown): string {
  return isNum(v) ? String(v) : NO_DATA_TEXT;
}

// ---------------------------------------------------------------------------
// PHASE 2 helpers
// ---------------------------------------------------------------------------

/**
 * A label that came from an upstream payload, made safe to render: control
 * and format characters (\p{Cc}, \p{Cf}: bidi overrides, zero-width) stripped, whitespace collapsed, length bounded. Svelte escapes
 * HTML already; this bounds what an upstream can do to the LAYOUT (a 10 KB
 * model id, embedded newlines). null/empty → the fallback.
 */
export function boundedLabel(v: unknown, max = 80, fallback = 'not reported'): string {
  if (typeof v !== 'string') return fallback;
  // Cc = C0, DEL, C1 (incl. U+0085); Cf = format chars: bidi overrides/isolates
  // (U+202E, U+2066…), zero-width (U+200B…). Either can reorder or hide text.
  const clean = v.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export type Tone = 'success' | 'danger' | 'warning' | 'muted';

export const TONE_CLASS: Record<Tone, string> = {
  success: 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
  danger: 'border-2 border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
  warning: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
  muted: 'border-dashed border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]',
};

/** Seconds → "3h 5m" / "2d 4h". null → the caller decides (never "0s"). */
export function durationText(s: number | null | undefined): string {
  if (!isNum(s) || s < 0) return NO_DATA_TEXT;
  if (s < 90) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A GitHub PR URL safe to link, or null. Only https://github.com/… is linked. */
export function safePrUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Board accuracy (live browser verification, 2026-09-23)
// ---------------------------------------------------------------------------

/**
 * Whole days a window spans (`to - from`), or null when either bound is
 * missing or unparseable. Two counts over different windows (the tab asks for
 * 180 days, the tile for 30) disagree legitimately — the reader can only tell
 * if each count names its span.
 */
export function windowDays(w: { from?: string | null; to?: string | null } | null | undefined): number | null {
  if (!w || typeof w.from !== 'string' || typeof w.to !== 'string') return null;
  const a = Date.parse(w.from);
  const b = Date.parse(w.to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Fidelity of a set of replays: `captured` only when EVERY one says captured
 * (frozen from the inference-router ledger's captured request); any
 * `reconstructed` makes the whole set a proxy; nothing reported → null.
 */
export function fidelityOf(values: readonly unknown[]): 'captured' | 'reconstructed' | 'mixed' | null {
  const seen = values.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (seen.length === 0) return null;
  const captured = seen.filter((v) => v === 'captured').length;
  if (captured === seen.length) return 'captured';
  return captured === 0 ? 'reconstructed' : 'mixed';
}

/** The most common decision key among outputs (ties → first seen); null when none recorded. */
export function modalKey(keys: readonly (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const k of keys) if (typeof k === 'string') counts.set(k, (counts.get(k) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
}
