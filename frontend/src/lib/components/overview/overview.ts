// overview.ts — pure helpers for the project Overview (R2, FR-PROJECT-HOME-REDESIGN-2026-10-26 §4).
// The read model (backend services/cockpit/overview.ts) places every entity in its phase EXACTLY;
// this file only words it. Nothing here decides a phase.
import type {
  CockpitDecision,
  OverviewOutput,
  OverviewPhase,
  ProjectOverview,
  ProjectRegisters,
  RegisterRisk,
  SpineCardState,
} from '$lib/types/cockpit';
import { durationWords, moneyWords } from '$lib/projects/cockpit-status';
import { actorWords, shortTime } from '$lib/components/cockpit/spine';
import { displayCriteria } from '$lib/components/registers/registers';

/** The phase the Overview shows: the one the user chose, else the current one, else the first. */
export function phaseShown(o: Pick<ProjectOverview, 'phases' | 'current_phase'>, chosen: string | null): string | null {
  if (chosen && o.phases.some((p) => p.name === chosen)) return chosen;
  return o.current_phase ?? o.phases[0]?.name ?? null;
}

const STATE_ORDER: SpineCardState[] = ['todo', 'doing', 'qa', 'blocked', 'done'];
const STATE_WORD: Record<SpineCardState, string> = { todo: 'To do', doing: 'Doing', qa: 'In review', blocked: 'Blocked', done: 'Done' };

/** One line for a phase's board: "To do 4 · Done 2 · Blocked 1" (empty columns left out). */
export function boardLine(by: Record<SpineCardState, number>): string {
  const parts = STATE_ORDER.filter((s) => by[s] > 0).map((s) => `${STATE_WORD[s]} ${by[s]}`);
  return parts.length > 0 ? parts.join(' · ') : 'No cards';
}

export function cardStateWord(s: SpineCardState): string {
  return STATE_WORD[s];
}

/** "41 min · 07:03 to 07:44" / "2 h 22 min so far · since 10:41" / "Not started". */
export function phaseTiming(p: Pick<OverviewPhase, 'state' | 'entered_at' | 'left_at' | 'duration_ms'>): string {
  if (p.state === 'upcoming') return 'Not started';
  if (p.state === 'not_run') return 'Did not run';
  const dur = p.duration_ms !== null ? durationWords(p.duration_ms) : null;
  if (p.state === 'active') return [dur ? `${dur} so far` : null, p.entered_at ? `since ${shortTime(p.entered_at)}` : null].filter(Boolean).join(' · ');
  const span = p.entered_at && p.left_at ? `${shortTime(p.entered_at)} to ${shortTime(p.left_at)}` : null;
  return [dur, span].filter(Boolean).join(' · ') || 'Done';
}

/** "$13.65 · 113 calls" / "no cost recorded on its cards" / null when per-card cost was not read. */
export function phaseCostWords(p: Pick<OverviewPhase, 'cost'>, currency: string | null): string | null {
  if (!p.cost) return null;
  if (p.cost.calls === 0) return 'No model calls recorded on its cards';
  const money = moneyWords(p.cost.cost, currency ?? 'USD');
  return `${money ?? 'Cost unknown'} · ${p.cost.calls} model call${p.cost.calls === 1 ? '' : 's'}`;
}

/** "Approval agent, 25 Oct 10:12" — who signed the phase off, and when. */
export function signoffWords(p: Pick<OverviewPhase, 'signoff'>): string | null {
  const s = p.signoff;
  if (!s || !s.by_kind) return null;
  const when = shortTime(s.at);
  return `${actorWords(s.by_kind, s.by_name)}${when ? `, ${when}` : ''}`;
}

/** The progress sentence for one phase, in plain words. */
export function progressSentence(p: OverviewPhase): string {
  const c = p.cards;
  if (p.state === 'upcoming') return 'Not started yet.';
  if (p.state === 'not_run') return 'Did not run.';
  const bits: string[] = [];
  if (c.total > 0) {
    bits.push(`${c.by_state.done} of ${c.total} card${c.total === 1 ? '' : 's'} done`);
    if (c.by_state.qa > 0) bits.push(`${c.by_state.qa} in review`);
    if (c.by_state.blocked > 0) bits.push(`${c.by_state.blocked} blocked`);
  } else {
    bits.push('no cards');
  }
  let out = bits.join('; ');
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (p.state === 'done') {
    const who = signoffWords(p);
    const delivered = p.delivered.map((d) => d.title);
    return `${out}.${delivered.length > 0 ? ` Delivered: ${delivered.slice(0, 3).join('; ')}${delivered.length > 3 ? ` and ${delivered.length - 3} more` : ''}.` : ''}${who ? ` Signed off by ${who}.` : ''}`;
  }
  return `${out}.${p.open_asks > 0 ? ` ${p.open_asks} question${p.open_asks === 1 ? '' : 's'} or sign-off${p.open_asks === 1 ? '' : 's'} waiting.` : ''}`;
}

const STATUS_WORD: Record<NonNullable<OverviewOutput['status']>, string> = {
  published: 'published',
  draft: 'draft',
  in_review: 'changes asked',
  open: 'open',
  merged: 'merged',
  closed: 'closed',
};

/** "Analysis report · published · 25 Oct 10:33". */
export function outputMeta(o: OverviewOutput): string {
  return [o.type_label, o.status ? STATUS_WORD[o.status] : null, shortTime(o.at) || null].filter(Boolean).join(' · ');
}

/** Where an output opens: a PR at its url; a document in the project's document reader (R3 / DOC-3). */
export function outputHref(projectId: string, o: OverviewOutput): string {
  if (o.url) return o.url;
  return `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(o.id)}`;
}

// ── Registers at a glance (§7.3) ──

/** The page's registers read: reading, failed (never shown as empty), or loaded. */
export type RegistersView = { kind: 'reading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; data: ProjectRegisters };

export interface RegistersGlance {
  risksOpen: number;
  topRisks: RegisterRisk[];
  /** The last 3 decisions: RM's register when it has any, else the decision log (§7.5). */
  decisions: { id: string; at: string | null; text: string; by: string | null }[];
  decisionsSource: 'register' | 'log';
  decisionsTotal: number;
  /** Acceptance criteria: the only criteria that carry a check (RM status). */
  criteriaMet: number;
  criteriaTotal: number;
  /** Success criteria: stated intent, never scored (RM status is null). */
  criteriaNotScored: number;
  requirements: number;
}

const OPEN_RISK = (r: RegisterRisk) => r.status.toLowerCase() !== 'closed';

export function registersGlance(r: Extract<ProjectRegisters, { available: true }>, log: readonly CockpitDecision[]): RegistersGlance {
  const topRisks = r.risks.filter(OPEN_RISK).sort((a, b) => b.score - a.score).slice(0, 3);
  // RM's counts.criteria_total includes success criteria, which carry no check and can never
  // be "met" — counting them in "x of y met" claims a failure that never happened. The setup
  // flow also copies each success criterion verbatim into an acceptance criterion (R-CK9), so
  // the same sentence is shown once, with its check.
  const shown = displayCriteria(r.criteria);
  const acceptance = shown.filter((c) => c.kind === 'acceptance');
  const fromRegister = r.decisions.length > 0;
  const decided = log.filter((d) => !d.open).sort((a, b) => Date.parse(b.decided_at ?? '') - Date.parse(a.decided_at ?? '') || 0);
  const decisions = fromRegister
    ? r.decisions.slice(0, 3).map((d) => ({ id: d.id, at: d.decided_at, text: d.title, by: d.decided_by_kind ? actorWords(d.decided_by_kind === 'agent' ? 'triage_agent' : d.decided_by_kind === 'rule' ? 'rule' : 'human') : null }))
    : decided.slice(0, 3).map((d) => ({ id: d.approval_id, at: d.decided_at, text: d.answer ? `${d.subject}: ${d.answer}` : d.subject, by: actorWords(d.actor_kind, d.actor_name) }));
  return {
    risksOpen: r.counts.risks_open,
    topRisks,
    decisions,
    decisionsSource: fromRegister ? 'register' : 'log',
    decisionsTotal: fromRegister ? r.counts.decisions : decided.length,
    criteriaMet: acceptance.filter((c) => (c.status ?? '').toLowerCase() === 'met').length,
    criteriaTotal: acceptance.length,
    criteriaNotScored: shown.length - acceptance.length,
    requirements: r.counts.requirements,
  };
}

/** A risk's score as RM rounds it (2 decimals), without trailing zeros. */
export function scoreWords(score: number): string {
  return Number.isFinite(score) ? String(Math.round(score * 100) / 100) : '—';
}
