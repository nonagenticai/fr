/**
 * A stored enum value (`approved`, `needs_revision`, `IN_PROGRESS`) as a label a
 * person reads: separators become spaces and the result is sentence-cased.
 * Short all-caps acronyms (`QA`, `CI`, ≤3 letters) are kept as written. Unknown
 * values still render (never blank) — this only changes the casing (FR-9).
 */
export function humanizeEnum(value: string | null | undefined): string {
  if (value == null) return '';
  const raw = String(value).trim();
  if (raw === '') return '';
  if (/^[A-Z]{1,3}$/.test(raw)) return raw;
  const words = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const LIST_LABELS: Readonly<Record<string, string>> = {
  TODO: 'To do',
  QA: 'QA',
};

/** A board list name (`DOING`, `TODO`, `QA`) as a label. */
export function listNameLabel(listName: string | null | undefined): string {
  if (listName == null) return '';
  const key = String(listName).trim().toUpperCase();
  return LIST_LABELS[key] ?? humanizeEnum(listName);
}
