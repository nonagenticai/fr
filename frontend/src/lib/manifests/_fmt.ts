// Shared manifest formatters. Kept tiny + framework-free so every per-asset
// manifest renders dates identically (mirrors the inline `fmtDate` in the
// requirements/principles manifests, deduplicated for the architecture/PM
// asset families added in the control-plane roadmap).

/** Locale-format a timestamp; passes through unparseable/empty values. */
export function fmtDate(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

/** Locale-format a date-only value; '—' for empty. */
export function fmtDateOrDash(v: unknown): string {
  return fmtDate(v) || '—';
}

/** Render a number with up to 2 decimals; '—' for null/undefined. */
export function fmtNum(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : String(Math.round(n * 100) / 100);
}
