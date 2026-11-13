// The project brief page's pure logic: field catalogue, version labels, the
// field-level diff between two RM brief versions. READ-ONLY (George 2026-10-13,
// D15/R16): fr never edits the brief after create, so there is no edit form and
// no PUT body here. No fetching, no Svelte — everything here is unit-tested.

import type { BriefVersionSummary, ProjectBrief } from '$lib/api/project-brief';

export type BriefFieldKind = 'text' | 'list' | 'objects';

export interface BriefField {
  key: keyof ProjectBrief;
  label: string;
  kind: BriefFieldKind;
}

/** Every ProjectBrief key, in display order, with its human label. */
export const BRIEF_FIELDS: readonly BriefField[] = [
  { key: 'problem_statement', label: 'Problem statement', kind: 'text' },
  { key: 'desired_outcome', label: 'Desired outcome', kind: 'text' },
  { key: 'business_case', label: 'Business case', kind: 'text' },
  { key: 'success_criteria', label: 'Success criteria', kind: 'list' },
  { key: 'acceptance_criteria', label: 'Acceptance criteria', kind: 'list' },
  { key: 'in_scope', label: 'In scope', kind: 'list' },
  { key: 'out_of_scope', label: 'Out of scope', kind: 'list' },
  { key: 'high_level_requirements', label: 'High-level requirements', kind: 'list' },
  { key: 'assumptions', label: 'Assumptions', kind: 'list' },
  { key: 'access_requirements', label: 'Access requirements', kind: 'list' },
  { key: 'stakeholders', label: 'Stakeholders', kind: 'list' },
  { key: 'approvers', label: 'Approvers', kind: 'list' },
  { key: 'deadline', label: 'Deadline', kind: 'text' },
  { key: 'budget', label: 'Budget', kind: 'text' },
  { key: 'notes', label: 'Notes', kind: 'text' },
  { key: 'constraints', label: 'Constraints', kind: 'objects' },
  { key: 'dependencies', label: 'Dependencies', kind: 'objects' },
  { key: 'risks', label: 'Risks', kind: 'objects' },
];

export const TEXT_KEYS = BRIEF_FIELDS.filter((f) => f.kind === 'text').map((f) => f.key) as readonly (
  | 'problem_statement'
  | 'desired_outcome'
  | 'business_case'
  | 'deadline'
  | 'budget'
  | 'notes'
)[];
export type BriefTextKey = (typeof TEXT_KEYS)[number];

export const LIST_KEYS = BRIEF_FIELDS.filter((f) => f.kind === 'list').map((f) => f.key) as readonly (
  | 'success_criteria'
  | 'acceptance_criteria'
  | 'in_scope'
  | 'out_of_scope'
  | 'high_level_requirements'
  | 'assumptions'
  | 'access_requirements'
  | 'stakeholders'
  | 'approvers'
)[];
export type BriefListKey = (typeof LIST_KEYS)[number];

export const EMPTY = '—';

/**
 * RM's per-string cap (RM `src/schemas/pm_intake.py` MAX_STR) — the limit on
 * `notes`, where every conveyor version appends its "Clarifications" (R131) and
 * "Outcome" (R123) sections (v4 R144). Shown next to the notes so a reader can
 * see how much room the conveyor has left; fr enforces nothing here.
 */
export const NOTES_MAX_CHARS = 10_000;

/**
 * Text fields diffed LINE BY LINE instead of whole-value before → after. A
 * conveyor version copies every field unchanged and APPENDS to `notes` (R144),
 * so a whole-value diff would strike through the user's entire notes on every
 * version; a line diff shows only the appended section.
 */
export const LINE_DIFF_KEYS: readonly (keyof ProjectBrief)[] = ['notes'];

// --- labels --------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A timestamp as LOCAL `YYYY-MM-DD HH:mm` — date AND time.
 *
 * `string | Date` because `Project.created_at`/`updated_at` are typed that way
 * (`$lib/types/api`), while the brief pages pass ISO strings. An unparsable
 * STRING is returned as-is; an invalid Date prints empty.
 */
export function formatLocalDateTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "v3 · conveyor · 2026-10-13 08:40" */
export function versionLabel(v: Pick<BriefVersionSummary, 'version' | 'author_kind' | 'created_at'>): string {
  return `v${v.version} · ${v.author_kind} · ${formatLocalDateTime(v.created_at)}`;
}

/** "viewing v2 of 5" — M is `current_version` when known, else `total`. */
export function viewingBadge(version: number, currentVersion: number | null, total: number): string {
  return `viewing v${version} of ${currentVersion ?? total}`;
}

// --- item rendering ------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A criterion's check, in words. `unchecked` (and unknown) adds nothing: the text stands alone. */
const CRITERION_STATUS_WORDS: Readonly<Record<string, string>> = { met: 'met', not_met: 'not met' };

/** One list/object item as a single readable line. */
export function itemText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item === null || item === undefined) return '';
  if (isRecord(item)) {
    // an acceptance criterion (RM #235): {id, text, status, evidence, checked_at, checked_by}.
    // The TEXT is what the user wrote; the check is the conveyor's (R-CK7), shown in words.
    if (typeof item.text === 'string' && ('id' in item || 'status' in item)) {
      const status = CRITERION_STATUS_WORDS[String(item.status ?? '')];
      return status ? `${item.text} — ${status}` : item.text;
    }
    // a risk
    if (typeof item.description === 'string' && !('kind' in item)) {
      const facets = [
        item.likelihood ? `likelihood: ${String(item.likelihood)}` : '',
        item.impact ? `impact: ${String(item.impact)}` : '',
      ].filter(Boolean);
      const mitigation = item.mitigation ? ` — mitigation: ${String(item.mitigation)}` : '';
      return `${item.description}${facets.length ? ` (${facets.join(', ')})` : ''}${mitigation}`;
    }
    // a dependency {kind, name, note?}
    if (typeof item.kind === 'string' && typeof item.name === 'string') {
      const rest = Object.keys(item).filter((k) => !['kind', 'name', 'note'].includes(k));
      if (rest.length === 0) {
        return `${item.kind}: ${item.name}${item.note ? ` — ${String(item.note)}` : ''}`;
      }
    }
    // a structured constraint {kind, ...}
    if (typeof item.kind === 'string') {
      const { kind, ...rest } = item;
      const keys = Object.keys(rest);
      return keys.length ? `${kind}: ${JSON.stringify(rest)}` : String(kind);
    }
  }
  return JSON.stringify(item);
}

/** Is this field value empty (null, '', whitespace, [])? */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// --- diff ------------------------------------------------------------------------

export type FieldDiff =
  | { key: keyof ProjectBrief; label: string; kind: 'text'; before: string | null; after: string | null }
  | { key: keyof ProjectBrief; label: string; kind: 'items'; added: unknown[]; removed: unknown[] }
  | {
      key: keyof ProjectBrief;
      label: string;
      kind: 'lines';
      /** Unchanged lines around the change (common prefix + common suffix). */
      kept: number;
      removed: string[];
      added: string[];
    };

function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.trim() === '' ? null : s;
}

function itemsOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` are one item. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The changed block between two texts, by lines: everything after the common
 * line prefix and before the common line suffix. An append yields `removed: []`
 * and the appended lines; an edit in the middle yields the old and new block.
 */
export function lineDiff(
  before: string | null,
  after: string | null,
): { kept: number; removed: string[]; added: string[] } {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  return { kept: p + s, removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s) };
}

/** Items of `a` not matched (by JSON identity, counting duplicates) in `b`. */
function minus(a: unknown[], b: unknown[]): unknown[] {
  const counts = new Map<string, number>();
  for (const item of b) {
    const k = stableJson(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: unknown[] = [];
  for (const item of a) {
    const k = stableJson(item);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else out.push(item);
  }
  return out;
}

/**
 * Field-level diff of `after` against `before` (the previous version). Only
 * changed fields are returned, in BRIEF_FIELDS order. `before === null` (the
 * first version) diffs against an empty brief.
 */
export function diffBriefs(before: ProjectBrief | null, after: ProjectBrief): FieldDiff[] {
  const prev: ProjectBrief = before ?? {};
  const out: FieldDiff[] = [];
  for (const f of BRIEF_FIELDS) {
    const a = prev[f.key];
    const b = after[f.key];
    if (f.kind === 'text') {
      const ta = textOf(a);
      const tb = textOf(b);
      if (ta === tb) continue;
      if (LINE_DIFF_KEYS.includes(f.key)) {
        out.push({ key: f.key, label: f.label, kind: 'lines', ...lineDiff(ta, tb) });
      } else {
        out.push({ key: f.key, label: f.label, kind: 'text', before: ta, after: tb });
      }
      continue;
    }
    const added = minus(itemsOf(b), itemsOf(a));
    const removed = minus(itemsOf(a), itemsOf(b));
    if (added.length || removed.length) {
      out.push({ key: f.key, label: f.label, kind: 'items', added, removed });
    }
  }
  return out;
}

/** The version immediately below `version` in a newest-first list, or null. */
export function previousVersionOf(versions: readonly Pick<BriefVersionSummary, 'version'>[], version: number): number | null {
  let best: number | null = null;
  for (const v of versions) {
    if (v.version < version && (best === null || v.version > best)) best = v.version;
  }
  return best;
}
