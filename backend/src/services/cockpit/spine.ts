// src/services/cockpit/spine.ts
//
// Cockpit Slice 1 part 2 (FR-COCKPIT-IMPL-PLAN-2026-10-25 §4 Wave C): the read-model data behind
//   C3 the PHASE SPINE   — each phase of the project as a segment sized by time spent (RM phase
//                          events), the gate after it (who signed, when), the cards placed in it,
//                          and machine time vs time waiting on people (R-CK1);
//   C8 the DECISION LOG  — every question and sign-off as one compact row that NAMES ITS SUBJECT
//                          (which gate or card, what was asked, what was decided, who decided).
//
// Pure functions only (no I/O): project-cockpit.ts feeds them what it already read.
//
// ⛔ R-CK1 — what counts as WAITING ON PEOPLE. Only a HUMAN decision's open time (asked → decided),
// plus an item still open on a project that is not closed (it waits on a person until someone
// decides it). A decision by the approval-triage agent or by a rule is MACHINE time: Claude decides
// every conveyor-tenant approval (George 10-14), so counting its latency as people time would make
// every project read "waiting on people". Overlapping waits are merged, never double counted.
//
// fr is a facilitator: everything here is a projection of recorded facts; nothing is judged.
import { tidyConveyorProse } from '../conveyor-history/comment-parse';
import { askQuestion, humanCardType } from '../conveyor-history/history';
import type { RailNode } from '../../lib/project-phase';
import type { CockpitApproval, Phase } from './project-cockpit';

// ── Output shapes ───────────────────────────────────────────────────────────

export type DecidedByKind = 'human' | 'triage_agent' | 'rule' | 'agent';
export type SpinePhaseState = 'done' | 'active' | 'upcoming' | 'not_run';
export type SpineCardState = 'todo' | 'doing' | 'qa' | 'done' | 'blocked';

export interface SpinePhase {
  name: string;
  /** The tenant's title for the phase (plain words). */
  label: string;
  state: SpinePhaseState;
  entered_at: string | null;
  /** null while the phase is running, or when it never ran. */
  left_at: string | null;
  /** Time spent: left (or now, while active) − entered. null when it never ran. */
  duration_ms: number | null;
  /** Of `duration_ms`, the time a person was being waited on (R-CK1). */
  human_wait_ms: number;
  /** `duration_ms − human_wait_ms` (0 when the phase never ran). */
  machine_ms: number;
  /** The board cards placed in this phase. */
  card_ids: string[];
  /** A sign-off gates this phase's exit. */
  has_gate: boolean;
}

export interface SpineGate {
  /** The phase this gate closes. */
  phase: string;
  /** 'passed' = the phase was left; 'waiting' = a sign-off is open; 'ahead' = not reached yet. */
  state: 'passed' | 'waiting' | 'ahead';
  /** When the phase was left (passed) — the diamond's position. */
  at: string | null;
  /** The sign-off that let it pass (the latest signed in the phase), when one was recorded. */
  approval_id: string | null;
  signed_at: string | null;
  signed_by_kind: DecidedByKind | null;
  /** Display name of the person who signed — only for a human signer the directory names. */
  signed_by_name: string | null;
  /** What was signed, in plain words ("Sign-off for “Project setup” (project setup)"). */
  subject: string | null;
}

export interface SpineCard {
  id: string;
  name: string;
  state: SpineCardState;
  /** The project phase the card belongs to; null = not tied to a phase. */
  phase: string | null;
  /**
   * How it was placed — EXACT only (FR-PROJECT-HOME-REDESIGN §2b, "a phase is recorded and never
   * guessed"): the card's own `phase` field, or its card type `project_closure` (Closure). A card
   * with neither is not placed (`phase` null) and the UI shows it under "not tied to a phase".
   */
  placed_by: 'card_phase' | 'card_type' | null;
}

export interface CockpitSpine {
  phases: SpinePhase[];
  gates: SpineGate[];
  cards: SpineCard[];
  totals: { duration_ms: number; human_wait_ms: number; machine_ms: number };
  closed: boolean;
  /** The instant `now` the open segment was measured to. */
  measured_at: string;
}

export interface CockpitDecision {
  approval_id: string;
  kind: 'question' | 'signoff' | 'request';
  /** ONE plain sentence naming what this row is about: which gate or card, and what kind of ask. */
  subject: string;
  /** The question / what was put up for sign-off, first line only. */
  question: string;
  question_full: string;
  /** The answer in one line ("Approved — Fixed: …"); null while open. */
  answer: string | null;
  answer_full: string | null;
  decision: 'approved' | 'rejected' | string | null;
  /** Who decided: a person, the approval-triage agent, or a rule; null while open. */
  actor_kind: DecidedByKind | null;
  /** The person's display name — only for a human decider the directory names. */
  actor_name: string | null;
  asked_at: string | null;
  decided_at: string | null;
  card_id: string | null;
  card_name: string | null;
  /** The phase of the item's CARD (exact: the card's `phase` field / closure type); null = no card, or the card has no phase. */
  phase: string | null;
  open: boolean;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** An RM phase event (`GET /pm/projects/{eid}/phase-events`), any order. */
export interface PhaseEventIn {
  at: string;
  from_phase?: string | null;
  to_phase?: string | null;
  /** RM #235: 'closure' marks the project closing (from = to = the last phase). */
  kind?: string | null;
}

export interface BoardCardIn {
  id: string;
  name: string | null;
  /** fr's canonical mantra phase of the card's list. */
  list_phase: Phase;
  created_at: string | null;
  /** The card's own `phase` custom field, when the conveyor stamped one. */
  phase_field: string | null;
  /** The card's `card_type` custom field (`project_closure` = the Closure phase). */
  card_type?: string | null;
}

/** The phase fr adds after the project type's phases: RM models closure as an event, not a phase. */
export const CLOSURE_PHASE = 'closure';
export const CLOSURE_PHASE_LABEL = 'Closure';
/** The card type that IS the Closure phase (its card's own `phase` field says the last phase). */
export const CLOSURE_CARD_TYPE = 'project_closure';

/**
 * The exact phase of one card, or null: a `project_closure` card is Closure; otherwise the card's
 * own `phase` field when it names one of the project's phases. Nothing else places a card.
 */
export function exactCardPhase(c: Pick<BoardCardIn, 'phase_field' | 'card_type'>, phases: ReadonlySet<string>): {
  phase: string | null;
  placed_by: SpineCard['placed_by'];
} {
  if ((c.card_type ?? '').trim() === CLOSURE_CARD_TYPE) return { phase: CLOSURE_PHASE, placed_by: 'card_type' };
  if (c.phase_field && phases.has(c.phase_field)) return { phase: c.phase_field, placed_by: 'card_phase' };
  return { phase: null, placed_by: null };
}

/**
 * A closure event: `kind: 'closure'`, or — for an event that carries NO kind — from = to (the
 * shape before RM #235 named it). An explicit `kind: 'phase'` with from = to is a project or
 * phase RESTART (George 2026-10-31), a re-entry, never a closure (conveyor-plan.ts
 * `phaseWindows` reads it the same way). RM origin/main stores `kind` NOT NULL (default 'phase').
 */
function isClosureEvent(e: Pick<PhaseEventIn, 'kind' | 'from_phase' | 'to_phase'>): boolean {
  if (e.kind === 'closure') return true;
  if (e.kind != null) return false;
  return e.from_phase != null && e.from_phase === e.to_phase;
}

/** The closure instant RM recorded (see {@link isClosureEvent}), newest; null when none. */
export function closureEventAt(events: readonly PhaseEventIn[]): number | null {
  let best: number | null = null;
  for (const e of events) {
    const closure = isClosureEvent(e);
    const t = ms(e.at);
    if (closure && t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const isoOf = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

/** First line, trimmed, at most `max` characters (an ellipsis marks a cut). */
export function oneLine(text: string | null | undefined, max = 160): string {
  const first = (text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * Entered / left per phase from the RM phase events. A closure event ({@link isClosureEvent})
 * closes its phase; a `kind: 'phase'` event with from = to (a restart, George 2026-10-31)
 * re-enters it — the phase stays open and keeps its first entry.
 */
export function phaseWindowsFromEvents(
  events: readonly PhaseEventIn[],
): Map<string, { entered: number | null; left: number | null }> {
  const sorted = [...events]
    .map((e) => ({ ...e, t: ms(e.at) }))
    .filter((e): e is PhaseEventIn & { t: number } => e.t !== null)
    .sort((a, b) => a.t - b.t);
  const out = new Map<string, { entered: number | null; left: number | null }>();
  const get = (n: string) => {
    const w = out.get(n) ?? { entered: null, left: null };
    out.set(n, w);
    return w;
  };
  for (const ev of sorted) {
    const from = ev.from_phase ?? null;
    const to = ev.to_phase ?? null;
    if (isClosureEvent(ev)) {
      const n = from ?? to;
      if (n) get(n).left = ev.t;
      continue;
    }
    if (from) get(from).left = ev.t;
    if (to) {
      const w = get(to);
      if (w.entered === null) w.entered = ev.t;
      w.left = null; // a re-entry reopens the phase
    }
  }
  return out;
}

/** Merge [start, end) intervals and return their total length clipped to [lo, hi). */
function clippedUnion(intervals: Array<[number, number]>, lo: number, hi: number): number {
  const parts = intervals
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const p of parts) {
    if (!cur || p[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [p[0], p[1]];
    } else cur[1] = Math.max(cur[1], p[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

export function askKindOf(a: Pick<CockpitApproval, 'metadata'>): CockpitDecision['kind'] {
  const k = (a.metadata as { ask_kind?: unknown } | null)?.ask_kind;
  return k === 'question' || k === 'signoff' ? k : 'request';
}

/** The decision that speaks for the item: the latest one recorded. */
function latestDecision(a: CockpitApproval): CockpitApproval['decisions'][number] | null {
  const ds = [...a.decisions].sort((x, y) => (ms(y.decided_at) ?? 0) - (ms(x.decided_at) ?? 0));
  return ds[0] ?? null;
}

function cardStateOf(p: Phase): SpineCardState {
  switch (p) {
    case 'DOING':
      return 'doing';
    case 'INSPECTING':
      return 'qa';
    case 'PUBLISHING':
      return 'done';
    case 'BLOCKED':
      return 'blocked';
    default:
      return 'todo';
  }
}

const KIND_WORDS: Record<CockpitDecision['kind'], string> = {
  question: 'Question',
  signoff: 'Sign-off',
  request: 'Request',
};

/** The row's subject as one plain sentence: what kind of ask, on which card / of which type. */
export function decisionSubject(kind: CockpitDecision['kind'], cardName: string | null, cardType: string | null): string {
  const what = KIND_WORDS[kind];
  const on = kind === 'signoff' ? 'for' : 'on';
  if (cardName) return `${what} ${on} “${cardName}”${cardType && cardType.toLowerCase() !== cardName.toLowerCase() ? ` (${cardType})` : ''}`;
  if (cardType) return `${what} ${on} the ${cardType} step`;
  return `${what} on this project`;
}

const DECISION_WORDS: Record<string, string> = { approved: 'Approved', rejected: 'Rejected' };

function answerLine(decision: string | null, comment: string | null): { line: string | null; full: string | null } {
  if (!decision) return { line: null, full: null };
  const word = DECISION_WORDS[decision] ?? decision.replace(/_/g, ' ');
  const note = comment ? tidyConveyorProse(comment).trim() : '';
  return { line: note ? `${word} — ${oneLine(note, 140)}` : word, full: note ? `${word}. ${note}` : word };
}

// ── C8 decision log ─────────────────────────────────────────────────────────

/**
 * One row per approval, oldest asked first. `names` maps an approver id to a display name
 * (only consulted for a HUMAN decider — an agent or rule is named by its kind).
 */
export function composeDecisionLog(input: {
  approvals: readonly CockpitApproval[];
  cardNames: ReadonlyMap<string, string>;
  /** card id → its EXACT phase (`exactCardPhase`). A decision takes its card's phase, never a time window's. */
  cardPhases?: ReadonlyMap<string, string>;
  names?: ReadonlyMap<string, string>;
}): CockpitDecision[] {
  const cardPhases = input.cardPhases ?? new Map<string, string>();
  const rows = input.approvals.map((a): CockpitDecision => {
    const kind = askKindOf(a);
    const md = (a.metadata ?? {}) as Record<string, unknown>;
    const cardType = humanCardType(typeof md.card_type === 'string' ? md.card_type : null);
    const cardName = a.card_id ? (input.cardNames.get(a.card_id) ?? null) : null;
    const questionFull = tidyConveyorProse(askQuestion(a)).trim();
    const d = latestDecision(a);
    const open = a.status === 'pending';
    const ans = open ? { line: null, full: null } : answerLine(d?.decision ?? a.status, d?.comment ?? null);
    const kindOfActor = d ? d.decided_by_kind : null;
    return {
      approval_id: a.id,
      kind,
      subject: decisionSubject(kind, cardName, cardType),
      question: oneLine(questionFull) || 'No question text was recorded.',
      question_full: questionFull,
      answer: ans.line,
      answer_full: ans.full,
      decision: open ? null : (d?.decision ?? a.status),
      actor_kind: open ? null : kindOfActor,
      actor_name:
        !open && d && kindOfActor === 'human' ? (input.names?.get(d.approver_id) ?? null) : null,
      asked_at: a.created_at,
      decided_at: open ? null : (d?.decided_at ?? null),
      card_id: a.card_id,
      card_name: cardName,
      phase: a.card_id ? (cardPhases.get(a.card_id) ?? null) : null,
      open,
    };
  });
  return rows.sort((x, y) => (ms(x.asked_at) ?? 0) - (ms(y.asked_at) ?? 0));
}

// ── C3 phase spine ──────────────────────────────────────────────────────────

/**
 * The project's phase chain: the type's phases (RM) and, after them, Closure — unless the type
 * already names a `closure` phase. RM models closure as an EVENT (status `closed`), so fr adds the
 * segment; its cards are the `project_closure` cards (FR-PROJECT-HOME-REDESIGN §2b).
 */
export function withClosure<N extends Pick<RailNode, 'phase' | 'label' | 'state' | 'isGate'>>(
  nodes: readonly N[],
): Array<Pick<RailNode, 'phase' | 'label' | 'state' | 'isGate'>> {
  if (nodes.length === 0 || nodes.some((n) => n.phase === CLOSURE_PHASE)) return [...nodes];
  return [...nodes, { phase: CLOSURE_PHASE, label: CLOSURE_PHASE_LABEL, state: 'upcoming', isGate: false }];
}

export function composeSpine(input: {
  nodes: readonly Pick<RailNode, 'phase' | 'label' | 'state' | 'isGate'>[];
  events: readonly PhaseEventIn[];
  approvals: readonly CockpitApproval[];
  cards: readonly BoardCardIn[];
  closed: boolean;
  now: number;
  names?: ReadonlyMap<string, string>;
}): CockpitSpine {
  const { now, closed } = input;
  const rmNodes = input.nodes;
  const nodes = withClosure(rmNodes);
  const addedClosure = nodes.length > rmNodes.length;
  const windows = phaseWindowsFromEvents(input.events);
  const phaseSet = new Set(nodes.map((n) => n.phase));

  // Waits on people (R-CK1): a human decision's open time; an open item on a live project.
  const humanWaits: Array<[number, number]> = [];
  for (const a of input.approvals) {
    const asked = ms(a.created_at);
    if (asked === null) continue;
    const d = latestDecision(a);
    if (a.status === 'pending') {
      if (!closed) humanWaits.push([asked, now]);
      continue;
    }
    if (d && d.decided_by_kind === 'human') {
      const decided = ms(d.decided_at);
      if (decided !== null && decided > asked) humanWaits.push([asked, decided]);
    }
  }

  // Cards: EXACT placement only — never by creation time.
  const cards: SpineCard[] = input.cards.map((c) => {
    const { phase, placed_by } = exactCardPhase(c, phaseSet);
    return { id: c.id, name: c.name ?? '', state: cardStateOf(c.list_phase), phase, placed_by };
  });
  const cardPhase = new Map(cards.filter((c) => c.phase).map((c) => [c.id, c.phase as string] as const));

  // Closure (fr-added): entered when its first closure card was made, left at RM's closure event.
  // It is the current phase once a closure card has left To do on an open project; the type's last
  // phase then ends where Closure began.
  if (addedClosure) {
    const closureCards = input.cards.filter((c) => cardPhase.get(c.id) === CLOSURE_PHASE);
    const made = closureCards.map((c) => ms(c.created_at)).filter((t): t is number => t !== null);
    const entered = made.length > 0 ? Math.min(...made) : null;
    const closedAt = closureEventAt(input.events);
    const started = closureCards.some((c) => c.list_phase !== 'READYING');
    if (entered !== null && (closed || started)) {
      windows.set(CLOSURE_PHASE, { entered, left: closed ? closedAt : null });
      const last = rmNodes[rmNodes.length - 1]?.phase;
      const lw = last ? windows.get(last) : undefined;
      if (lw && lw.entered !== null && entered >= lw.entered && (lw.left === null || entered < lw.left)) lw.left = entered;
    }
  }
  const closureRunning = addedClosure && !closed && windows.get(CLOSURE_PHASE)?.entered != null;

  let totalDur = 0;
  let totalHuman = 0;
  const phases: SpinePhase[] = nodes.map((n) => {
    const w = windows.get(n.phase) ?? { entered: null, left: null };
    const isClosure = addedClosure && n.phase === CLOSURE_PHASE;
    const isCurrentOpen = !closed && (isClosure ? closureRunning : n.state === 'active' && !closureRunning);
    const entered = w.entered;
    const left = w.left;
    const end = left ?? (entered !== null && isCurrentOpen ? now : null);
    const duration = entered !== null && end !== null ? Math.max(0, end - entered) : null;
    const human = duration !== null && entered !== null && end !== null ? clippedUnion(humanWaits, entered, end) : 0;
    let state: SpinePhaseState;
    if (isCurrentOpen) state = 'active';
    else if (entered !== null) state = 'done';
    else if (isClosure && closed) state = 'done';
    else if (n.state === 'done' || closed) state = 'not_run';
    else state = 'upcoming';
    if (duration !== null) {
      totalDur += duration;
      totalHuman += human;
    }
    return {
      name: n.phase,
      label: n.label,
      state,
      entered_at: isoOf(entered),
      left_at: isoOf(left),
      duration_ms: duration,
      human_wait_ms: human,
      machine_ms: duration === null ? 0 : duration - human,
      card_ids: cards.filter((c) => c.phase === n.phase).map((c) => c.id),
      has_gate: n.isGate,
    };
  });

  // Gates: one after every phase that was left (the transition is the gate), and one ahead of
  // the open phase when it is gated. The signer is the latest sign-off decided on one of the
  // phase's OWN cards (exact) — a sign-off on a card without a phase signs no gate.
  const cardNames = new Map(input.cards.map((c) => [c.id, c.name ?? ''] as const).filter(([, n]) => n !== ''));
  const gateSubject = (a: CockpitApproval): string => {
    const md = (a.metadata ?? {}) as Record<string, unknown>;
    const type = humanCardType(typeof md.card_type === 'string' ? md.card_type : null);
    return decisionSubject('signoff', a.card_id ? (cardNames.get(a.card_id) ?? null) : null, type);
  };
  const signoffs = input.approvals
    .filter((a) => askKindOf(a) === 'signoff')
    .map((a) => ({ a, d: latestDecision(a), phase: a.card_id ? (cardPhase.get(a.card_id) ?? null) : null }));
  const gates: SpineGate[] = [];
  for (const p of phases) {
    const mine = signoffs.filter((x) => x.phase === p.name);
    if (p.state === 'done' && (p.left_at || p.name === CLOSURE_PHASE)) {
      const signed = mine
        .filter(({ a, d }) => a.status !== 'pending' && d && ms(d.decided_at) !== null)
        .sort((x, y) => ms(y.d!.decided_at)! - ms(x.d!.decided_at)!)[0];
      gates.push({
        phase: p.name,
        state: 'passed',
        at: p.left_at,
        approval_id: signed?.a.id ?? null,
        signed_at: signed?.d?.decided_at ?? null,
        signed_by_kind: signed?.d?.decided_by_kind ?? null,
        signed_by_name:
          signed?.d && signed.d.decided_by_kind === 'human' ? (input.names?.get(signed.d.approver_id) ?? null) : null,
        subject: signed ? gateSubject(signed.a) : null,
      });
    } else if (p.state === 'active' && (p.has_gate || mine.some(({ a }) => a.status === 'pending'))) {
      const waiting = mine.find(({ a }) => a.status === 'pending');
      gates.push({
        phase: p.name,
        state: waiting ? 'waiting' : 'ahead',
        at: null,
        approval_id: waiting?.a.id ?? null,
        signed_at: null,
        signed_by_kind: null,
        signed_by_name: null,
        subject: waiting ? gateSubject(waiting.a) : null,
      });
    }
  }

  return {
    phases,
    gates,
    cards,
    totals: { duration_ms: totalDur, human_wait_ms: totalHuman, machine_ms: totalDur - totalHuman },
    closed,
    measured_at: new Date(now).toISOString(),
  };
}
