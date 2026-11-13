// registers.ts — pure helpers for the project Registers page (REG-3, FR-PROJECT-HOME-REDESIGN-2026-10-26
// §7.3–7.5): the rows of the Risks, Criteria and Decisions registers, the phase filter, sorting and the
// client-side CSV export. Every phase shown here is the one RM (or the read model, for the decision
// log) recorded; nothing here infers a phase from a time window. A row with no recorded phase is
// listed under "All" only.
import type { CockpitDecision, ProjectRegisters, RegisterCriterion, RegisterDecision, RegisterRisk, SpineCard } from '$lib/types/cockpit';
import { actorWords } from '$lib/components/cockpit/spine';

/** The C8 decision log, as the page read it from the cockpit. */
export type DecisionLogView = { kind: 'reading' } | { kind: 'failed' } | { kind: 'loaded'; rows: readonly CockpitDecision[] };

export type LoadedRegisters = Extract<ProjectRegisters, { available: true }>;

/** The three registers the page shows. Assumptions are dropped until a source exists (§7.5). */
export type RegisterKey = 'risks' | 'criteria' | 'decisions';
export const REGISTER_KEYS: readonly RegisterKey[] = ['risks', 'criteria', 'decisions'];
export const REGISTER_NAMES: Readonly<Record<RegisterKey, string>> = { risks: 'Risks', criteria: 'Criteria', decisions: 'Decisions' };

/** The phase filter value that keeps every row. */
export const ALL_PHASES = 'all';

export interface PhaseOption {
  name: string;
  label: string;
}

/** The default phase model (RM's default catalogue + fr's Closure), used when the spine is unreadable. */
const DEFAULT_PHASES: readonly PhaseOption[] = [
  { name: 'setup', label: 'Setup' },
  { name: 'preliminary', label: 'Preliminary' },
  { name: 'execution', label: 'Execution' },
  { name: 'closure', label: 'Closure' },
];

/** "All" + the project's phases (R2's phase model: the type's phases + Closure), else the default set. */
export function phaseOptions(phases: readonly { name: string; label: string }[] | null | undefined): PhaseOption[] {
  const src = phases && phases.length > 0 ? phases : DEFAULT_PHASES;
  return [{ name: ALL_PHASES, label: 'All' }, ...src.map((p) => ({ name: p.name, label: p.label }))];
}

/** The label of a recorded phase name ("execution" → "Execution"); null when none was recorded. */
export function phaseLabel(phase: string | null | undefined, options: readonly PhaseOption[]): string | null {
  if (!phase) return null;
  return options.find((o) => o.name === phase)?.label ?? humanize(phase);
}

/** `phase` keeps the row: "All", or the row's own recorded phase equals it. */
export function inPhase(rowPhase: string | null | undefined, phase: string): boolean {
  return phase === ALL_PHASES || rowPhase === phase;
}

/** snake_case / kebab → "Sentence case". */
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : s;
}

// ── Owner ───────────────────────────────────────────────────────────────────
// Until REG-2 writes a real owner role, RM's `owner` is the capability that raised the risk
// (measured 2026-10-27: development, analysis, testing, change_management). Known capability names
// read as the agent that holds them; anything else is shown as written, made readable.
const CAPABILITY_OWNER_LABELS: Readonly<Record<string, string>> = {
  development: 'Development agent',
  analysis: 'Analysis agent',
  testing: 'Testing agent',
  change_management: 'Change management agent',
  architecture: 'Architecture agent',
  security: 'Security agent',
  documentation: 'Documentation agent',
  project_management: 'Project manager agent',
  pm: 'Project manager agent',
  qa: 'Quality agent',
  quality_assurance: 'Quality agent',
  operations: 'Operations agent',
  deployment: 'Deployment agent',
};

export function ownerLabel(owner: string | null | undefined): string {
  const o = (owner ?? '').trim();
  if (!o) return 'No owner yet';
  const known = CAPABILITY_OWNER_LABELS[o.toLowerCase()];
  if (known) return known;
  return /^[a-z][a-z0-9_-]*$/.test(o) ? humanize(o) : o;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface RiskRow {
  id: string;
  score: number;
  /** p×i to 2 decimals ("1.50"). */
  scoreText: string;
  /** "0.5 × 3" when both factors are known. */
  factors: string | null;
  title: string;
  category: string | null;
  plan: string | null;
  owner: string;
  phase: string | null;
  phaseLabel: string | null;
  raisedAt: string | null;
  /** The Planka card the risk was raised on, when its id resolves on the project's board. */
  cardName: string | null;
  status: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmtFactor = (v: number): string => String(Math.round(v * 100) / 100);

/** A risk's score: probability × impact when both are known, else RM's score; 2 decimals. */
export function riskScore(r: Pick<RegisterRisk, 'score' | 'probability' | 'impact'>): number {
  const p = num(r.probability);
  const i = num(r.impact);
  const raw = p !== null && i !== null ? p * i : (num(r.score) ?? 0);
  return Math.round(raw * 100) / 100;
}

export function riskRows(risks: readonly RegisterRisk[], options: readonly PhaseOption[], cardNames: ReadonlyMap<string, string>): RiskRow[] {
  return risks.map((r) => {
    const score = riskScore(r);
    const p = num(r.probability);
    const i = num(r.impact);
    return {
      id: r.id,
      score,
      scoreText: score.toFixed(2),
      factors: p !== null && i !== null ? `${fmtFactor(p)} × ${fmtFactor(i)}` : null,
      title: r.title,
      category: r.category ? humanize(r.category) : null,
      plan: r.response_plan?.trim() || null,
      owner: ownerLabel(r.owner),
      phase: r.phase ?? null,
      phaseLabel: phaseLabel(r.phase, options),
      raisedAt: r.raised_at ?? null,
      cardName: r.card_id ? (cardNames.get(r.card_id) ?? null) : null,
      status: humanize(r.status || 'identified'),
    };
  });
}

export interface CriterionRow {
  id: string;
  kind: 'success' | 'acceptance';
  kindLabel: string;
  text: string;
  /** Only an acceptance criterion carries a check (RM status is null for success). */
  checkable: boolean;
  met: boolean;
  statusLabel: 'Met' | 'Not yet met' | 'Not scored';
  evidence: { label: string; ref: string; href: string | null }[];
}

const EVIDENCE_KIND: Readonly<Record<string, string>> = { test_run: 'Test run', pr: 'Pull request', report: 'Report' };

const sameText = (t: string): string => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The criteria to show, one row per statement. The conveyor's setup flow writes the brief's
 * success criteria verbatim into its acceptance criteria (R-CK9, RM #235), so the SAME sentence
 * otherwise appears twice: once with a check and once as a success criterion carrying none —
 * which reads as one met and one unmet criterion. Where the texts are identical, the checked
 * acceptance row is the criterion; show it once. A success criterion of its own is kept.
 */
export function displayCriteria(criteria: readonly RegisterCriterion[]): RegisterCriterion[] {
  const checked = new Set(criteria.filter((c) => c.kind === 'acceptance').map((c) => sameText(c.text)));
  return criteria.filter((c) => c.kind === 'acceptance' || !checked.has(sameText(c.text)));
}

export function criterionRows(criteria: readonly RegisterCriterion[]): CriterionRow[] {
  return criteria.map((c, n) => {
    const checkable = c.kind === 'acceptance';
    const met = checkable && (c.status ?? '').toLowerCase() === 'met';
    return {
      id: c.id ?? `${c.kind}-${n}`,
      kind: c.kind,
      kindLabel: c.kind === 'success' ? 'Success criterion' : 'Acceptance criterion',
      text: c.text,
      checkable,
      met,
      statusLabel: !checkable ? 'Not scored' : met ? 'Met' : 'Not yet met',
      evidence: (c.evidence ?? [])
        .filter((e) => typeof e?.ref === 'string' && e.ref.trim() !== '')
        .map((e) => {
          const ref = String(e.ref).trim();
          return {
            label: EVIDENCE_KIND[e.kind ?? ''] ?? (e.kind ? humanize(e.kind) : 'Evidence'),
            ref,
            href: /^https?:\/\//i.test(ref) ? ref : null,
          };
        }),
    };
  });
}

export interface DecisionRow {
  id: string;
  at: string | null;
  text: string;
  by: string;
  phase: string | null;
  phaseLabel: string | null;
  cardName: string | null;
}

/** RM `decided_by_kind` (human/agent/rule) in the decision log's words. */
function registerActor(kind: string | null): string {
  if (kind === 'human') return actorWords('human');
  if (kind === 'agent') return actorWords('triage_agent');
  if (kind === 'rule') return actorWords('rule');
  return 'Not recorded';
}

export function registerDecisionRows(
  decisions: readonly RegisterDecision[],
  options: readonly PhaseOption[],
  cardNames: ReadonlyMap<string, string>,
): DecisionRow[] {
  return decisions.map((d) => ({
    id: d.id,
    at: d.decided_at ?? d.raised_at ?? null,
    text: d.decision?.trim() ? `${d.title}: ${d.decision.trim()}` : d.title,
    by: registerActor(d.decided_by_kind),
    phase: d.phase ?? null,
    phaseLabel: phaseLabel(d.phase, options),
    cardName: d.card_id ? (cardNames.get(d.card_id) ?? null) : null,
  }));
}

/** The C8 decision log's DECIDED rows (open asks are not decisions yet). */
export function logDecisionRows(log: readonly CockpitDecision[], options: readonly PhaseOption[]): DecisionRow[] {
  return log
    .filter((d) => !d.open)
    .map((d) => ({
      id: d.approval_id,
      at: d.decided_at,
      text: d.answer ? `${d.subject}: ${d.answer}` : d.subject,
      by: actorWords(d.actor_kind, d.actor_name),
      phase: d.phase,
      phaseLabel: phaseLabel(d.phase, options),
      cardName: d.card_name,
    }));
}

export function cardNameMap(cards: readonly Pick<SpineCard, 'id' | 'name'>[] | null | undefined): Map<string, string> {
  return new Map((cards ?? []).map((c) => [c.id, c.name] as const));
}

// ── Sorting ─────────────────────────────────────────────────────────────────

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

export type RiskSortKey = 'score' | 'title' | 'owner' | 'raised' | 'status';
export type CriterionSortKey = 'text' | 'status';
export type DecisionSortKey = 'when' | 'text' | 'by' | 'phase';

const ms = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};
const cmp = (a: string | number, b: string | number): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });

function sortBy<T>(rows: readonly T[], value: (r: T) => string | number, dir: SortDir, tie: (a: T, b: T) => number): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * cmp(value(a), value(b)) || tie(a, b));
}

/** Risks; the default is the highest score first, the latest raised breaking a tie. */
export function sortRisks(rows: readonly RiskRow[], s: SortState<RiskSortKey> = { key: 'score', dir: 'desc' }): RiskRow[] {
  const v: Record<RiskSortKey, (r: RiskRow) => string | number> = {
    score: (r) => r.score,
    title: (r) => r.title,
    owner: (r) => r.owner,
    raised: (r) => ms(r.raisedAt),
    status: (r) => r.status,
  };
  return sortBy(rows, v[s.key], s.dir, (a, b) => ms(b.raisedAt) - ms(a.raisedAt) || a.title.localeCompare(b.title));
}

export function sortCriteria(rows: readonly CriterionRow[], s: SortState<CriterionSortKey> | null): CriterionRow[] {
  if (!s) return [...rows];
  const v: Record<CriterionSortKey, (r: CriterionRow) => string | number> = { text: (r) => r.text, status: (r) => (r.met ? 1 : 0) };
  return sortBy(rows, v[s.key], s.dir, () => 0);
}

export function sortDecisions(rows: readonly DecisionRow[], s: SortState<DecisionSortKey> = { key: 'when', dir: 'desc' }): DecisionRow[] {
  const v: Record<DecisionSortKey, (r: DecisionRow) => string | number> = {
    when: (r) => ms(r.at),
    text: (r) => r.text,
    by: (r) => r.by,
    phase: (r) => r.phaseLabel ?? '',
  };
  return sortBy(rows, v[s.key], s.dir, (a, b) => ms(b.at) - ms(a.at));
}

/** Clicking a column: the same column flips its direction; a new one starts at `first`. */
export function nextSort<K extends string>(cur: SortState<K> | null, key: K, first: SortDir = 'asc'): SortState<K> {
  if (cur && cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: first };
}

// ── CSV export (client-side) ────────────────────────────────────────────────

export type CsvValue = string | number | null | undefined;

/**
 * One CSV cell. Every text cell is quoted, with inner quotes doubled, so commas, quotes and
 * newlines survive. A text cell that a spreadsheet would read as a formula (it starts with `=`,
 * `+`, `-`, `@`, a tab or a carriage return) is prefixed with `'` first (OWASP CSV injection).
 * Numbers are written as numbers.
 */
export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function risksCsv(rows: readonly RiskRow[]): string {
  return toCsv(
    ['Score', 'Probability x impact', 'Risk', 'Category', 'Response plan', 'Owner', 'Phase', 'Raised at', 'Card', 'Status'],
    rows.map((r) => [r.score, r.factors, r.title, r.category, r.plan, r.owner, r.phaseLabel, r.raisedAt, r.cardName, r.status]),
  );
}

export function criteriaCsv(rows: readonly CriterionRow[]): string {
  return toCsv(
    ['Kind', 'Criterion', 'Status', 'Evidence'],
    rows.map((r) => [r.kindLabel, r.text, r.statusLabel, r.evidence.map((e) => `${e.label}: ${e.ref}`).join('; ') || null]),
  );
}

export function decisionsCsv(rows: readonly DecisionRow[]): string {
  return toCsv(
    ['Decided at', 'Decision', 'Decided by', 'Phase', 'Card'],
    rows.map((r) => [r.at, r.text, r.by, r.phaseLabel, r.cardName]),
  );
}

/** "registers-risks-execution-0d5c2fb9.csv". */
export function csvFileName(projectId: string, register: RegisterKey, phase: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `registers-${register}-${safe(phase)}-${safe(projectId.slice(0, 8))}.csv`;
}
