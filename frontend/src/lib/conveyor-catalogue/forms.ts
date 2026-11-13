// Form state ⇄ request body for the catalogue editors. Pure, so the page logic
// is unit-testable in vitest's node environment.
//
// ⛔ No validation lives here. A builder shapes what the form holds into the
// body RM expects and nothing more: an emptied optional text box is `null`
// (not set), a blank row in a list editor is not an entry, and a number box
// carries the number typed — or, when it is not a number, the raw text, so RM
// (not fr) answers it with a 422 the page renders. Names, required fields
// and phase order are RM's to judge.
//
// NULL vs empty (RM rm#208): `null` = NOT SET (import-defaults fills it);
// `[]` / `""` = deliberately CLEARED (they stay cleared). A nullable form field
// therefore keeps `null` until the user sets it, and its body value stays null.
//
// RM's catalogue PUT is PARTIAL (an omitted key is unchanged, an explicit null
// sets NULL), and fr forwards it as-is. So an UPDATE sends only
// `changedFields(body(before), body(after))`: an untouched field is never sent,
// which is what keeps an untouched null from becoming `[]`.

import type {
  ApproverRole,
  CardType,
  CatalogueBase,
  DefinitionOfDone,
  Gate,
  PriorityLevel,
  ProjectPhase,
  ProjectType,
} from '$lib/api/conveyor-catalogue';

/** "not set" for an absent / null / empty value. */
export const NOT_SET = 'not set';

export function displayValue(v: unknown): string {
  if (v === undefined || v === null) return NOT_SET;
  if (typeof v === 'string') return v.trim() === '' ? NOT_SET : v;
  if (Array.isArray(v)) return v.length === 0 ? NOT_SET : v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function textOrNull(v: string): string | null {
  return v.trim() === '' ? null : v;
}

/** The entries of a list editor; blank rows are not entries. */
export function listEntries(rows: readonly string[]): string[] {
  return rows.filter((r) => r.trim() !== '');
}

/**
 * The keys of `after` whose value differs from `before` (structural compare).
 * RM's PUT is partial, so this IS the update body: an untouched key is omitted
 * and RM leaves it unchanged.
 */
export function changedFields<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out;
}

/** A nullable list's form value: `null` = not set, else the rows (copied). */
export function nullableList(v: readonly string[] | null | undefined): string[] | null {
  return v == null ? null : [...v];
}

/** A nullable list's body value: `null` stays null (not set); a set list drops blank rows ([] = cleared). */
export function nullableListBody(v: readonly string[] | null): string[] | null {
  return v === null ? null : listEntries(v);
}

/** A tri-state boolean select: '' = not set (null). */
export type TriState = '' | 'yes' | 'no';

export function triState(v: boolean | null | undefined): TriState {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return '';
}

export function triStateBody(v: TriState): boolean | null {
  return v === '' ? null : v === 'yes';
}

/** A number box: '' ⇒ null; a number ⇒ the number; anything else ⇒ the raw text, for RM to refuse. */
export function numberOrRaw(v: string | number | null | undefined): number | string | null {
  // A `type="number"` box bound through Svelte hands back a number (or null when empty).
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// --- base -----------------------------------------------------------------

export interface BaseForm {
  name: string;
  title: string;
  description: string;
}

export function baseForm(row?: Partial<CatalogueBase>): BaseForm {
  return {
    name: row?.name ?? '',
    title: row?.title ?? '',
    description: row?.description ?? '',
  };
}

function baseBody(f: BaseForm): { name: string; title: string | null; description: string | null } {
  return { name: f.name, title: textOrNull(f.title), description: textOrNull(f.description) };
}

// --- phase ----------------------------------------------------------------

/** `output` / `exit_rule`: `null` = not set, `''` = cleared, else the text. */
export interface PhaseForm extends BaseForm {
  output: string | null;
  exit_rule: string | null;
}

export function phaseForm(row?: Partial<ProjectPhase>): PhaseForm {
  return { ...baseForm(row), output: row?.output ?? null, exit_rule: row?.exit_rule ?? null };
}

export function phaseBody(f: PhaseForm) {
  return { ...baseBody(f), output: f.output, exit_rule: f.exit_rule };
}

// --- capability -----------------------------------------------------------

export function capabilityBody(f: BaseForm) {
  return baseBody(f);
}

// --- card type ------------------------------------------------------------

/** List attributes: `null` = not set (import-defaults fills it), `[]` = cleared. */
export interface CardTypeForm extends BaseForm {
  capability_id: string;
  inputs: string[] | null;
  outputs: string[] | null;
  acceptance: string[] | null;
  rules: string[] | null;
  human_task: TriState;
  /** '' = not set (null). */
  definition_of_done: DefinitionOfDone | '';
}

export function cardTypeForm(row?: Partial<CardType>): CardTypeForm {
  return {
    ...baseForm(row),
    capability_id: row?.capability_id ?? '',
    inputs: nullableList(row?.inputs),
    outputs: nullableList(row?.outputs),
    acceptance: nullableList(row?.acceptance),
    rules: nullableList(row?.rules),
    human_task: triState(row?.human_task),
    definition_of_done: row?.definition_of_done ?? '',
  };
}

export function cardTypeBody(f: CardTypeForm) {
  return {
    ...baseBody(f),
    capability_id: f.capability_id,
    inputs: nullableListBody(f.inputs),
    outputs: nullableListBody(f.outputs),
    acceptance: nullableListBody(f.acceptance),
    rules: nullableListBody(f.rules),
    human_task: triStateBody(f.human_task),
    definition_of_done: f.definition_of_done === '' ? null : f.definition_of_done,
  };
}

/**
 * The definition-of-done picker options: 'not set', then RM's values (null =
 * the enum read failed, so none are offered). A card type's current value that
 * RM no longer lists is kept selectable, so opening the form never silently
 * rewrites it.
 */
export function dodOptionsFor(
  values: readonly string[] | null,
  currentValue: string,
): { value: string; label: string }[] {
  const options = [{ value: '', label: 'not set' }, ...(values ?? []).map((d) => ({ value: d, label: d }))];
  if (currentValue !== '' && !options.some((o) => o.value === currentValue)) {
    options.push({ value: currentValue, label: `${currentValue} (current value)` });
  }
  return options;
}

// --- project type ---------------------------------------------------------

export interface ProjectTypeForm extends BaseForm {
  /** Ordered. */
  phase_ids: string[];
}

/** Edits derive `phase_ids` from the output's ordered `phases[]`. */
export function projectTypeForm(row?: Partial<ProjectType>): ProjectTypeForm {
  const phases = [...(row?.phases ?? [])].sort((a, b) => a.position - b.position);
  return { ...baseForm(row), phase_ids: phases.map((p) => p.phase_id) };
}

export function projectTypeBody(f: ProjectTypeForm) {
  return { ...baseBody(f), phase_ids: [...f.phase_ids] };
}

/** Move the entry at `index` by `delta` (−1 up, +1 down); out-of-range is a no-op. */
export function moveEntry<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item as T);
  return out;
}

// --- gates ----------------------------------------------------------------

export interface GateForm extends BaseForm {
  phase_id: string;
  approver_role: ApproverRole | string;
  quorum: string;
  /** '' = never expires (null). */
  expires_after_hours: string;
}

export function gateForm(row?: Partial<Gate>, phaseId = ''): GateForm {
  return {
    ...baseForm(row),
    phase_id: row?.phase_id ?? phaseId,
    approver_role: row?.approver_role ?? 'project_owner',
    quorum: row?.quorum == null ? '1' : String(row.quorum),
    expires_after_hours: row?.expires_after_hours == null ? '' : String(row.expires_after_hours),
  };
}

export function gateBody(f: GateForm) {
  return {
    ...baseBody(f),
    phase_id: f.phase_id,
    approver_role: f.approver_role,
    quorum: numberOrRaw(f.quorum),
    expires_after_hours: numberOrRaw(f.expires_after_hours),
  };
}

/** Gates grouped by the phase they guard. */
export function gatesByPhase(gates: readonly Gate[]): Map<string, Gate[]> {
  const out = new Map<string, Gate[]>();
  for (const g of gates) {
    const list = out.get(g.phase_id) ?? [];
    list.push(g);
    out.set(g.phase_id, list);
  }
  return out;
}

export function gateSummary(g: Gate): string {
  const parts = [
    `approver ${displayValue(g.approver_role)}`,
    `quorum ${displayValue(g.quorum)}`,
    g.expires_after_hours == null ? 'never expires' : `expires after ${g.expires_after_hours}h`,
  ];
  return `${g.title || g.name}: ${parts.join(', ')}`;
}

// --- priority levels ------------------------------------------------------

/** Priority levels in RM's order: `rank` ascending (0 = highest). Never by name. */
export function byRank(levels: readonly PriorityLevel[]): PriorityLevel[] {
  return [...levels].sort((a, b) => a.rank - b.rank);
}
