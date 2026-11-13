// tests/unit/services/cockpit/spine.test.ts
//
// C3 phase spine + C8 decision log (services/cockpit/spine.ts), on a run-7-shaped fixture
// (RM phase events + fr approvals measured 2026-10-26 for project 0ad49b9c / RM 01a171de):
//   setup 07:02:59 → preliminary 07:44:22 → execution 08:19:19 → closure 08:57:21.
import { describe, expect, test } from 'bun:test';

import {
  closureEventAt,
  composeDecisionLog,
  composeSpine,
  decisionSubject,
  oneLine,
  phaseWindowsFromEvents,
  exactCardPhase,
  withClosure,
  type BoardCardIn,
  type PhaseEventIn,
} from '../../../../src/services/cockpit/spine';
import { composeTimeline, type CockpitApproval } from '../../../../src/services/cockpit/project-cockpit';

const T = (hm: string) => `2026-10-25T${hm}Z`;

const EVENTS: PhaseEventIn[] = [
  // newest first, as RM serves them
  { at: T('08:57:21'), from_phase: 'execution', to_phase: 'execution', kind: 'closure' },
  { at: T('08:19:19'), from_phase: 'preliminary', to_phase: 'execution' },
  { at: T('07:44:22'), from_phase: 'setup', to_phase: 'preliminary' },
  { at: T('07:02:59'), from_phase: null, to_phase: 'setup' },
];

const NODES = [
  { phase: 'setup', label: 'Setup', state: 'done' as const, isGate: true },
  { phase: 'preliminary', label: 'Preliminary', state: 'done' as const, isGate: true },
  { phase: 'execution', label: 'Execution', state: 'active' as const, isGate: true },
];

function approval(over: Partial<CockpitApproval> & { id: string }): CockpitApproval {
  return {
    kind: 'execution.ready_signoff',
    status: 'approved',
    description: '[ready-signoff] 1893483182280410369: Sign-off: project setup — conveyor proof run 7',
    card_id: null,
    created_at: T('07:41:28'),
    expires_at: null,
    metadata: { ask_kind: 'signoff', card_type: 'project_setup' },
    required_approvers: [],
    decisions: [],
    tenant_id: 't',
    source: 'n8n',
    requester_id: null,
    action_id: null,
    change_summary: null,
    impact_analysis: null,
    ...over,
  };
}
const decided = (at: string, kind: 'human' | 'triage_agent' | 'rule', comment = 'ok', decision = 'approved') => [
  { approver_id: 'u1', decision, comment, decided_at: at, decided_by_kind: kind },
];

const APPROVALS: CockpitApproval[] = [
  approval({
    id: 'q1',
    created_at: T('07:17:36'),
    card_id: 'c-setup',
    description: '[ready-signoff] 1893483182280410369: Question: project setup — conveyor proof run 7',
    metadata: { ask_kind: 'question', card_type: 'project_setup', open_questions: ['Which repository holds the fixture?'] },
    decisions: decided(T('07:33:48'), 'triage_agent', 'Fixed: the conveyor tenant now has access to conveyor-coding'),
  }),
  approval({ id: 's1', card_id: 'c-setup', created_at: T('07:41:28'), decisions: decided(T('07:41:34'), 'triage_agent', 'Reviewed: Sign-off: project setup complete; proceed.') }),
  approval({
    id: 's2',
    card_id: 'c-pclose',
    created_at: T('08:16:31'),
    metadata: { ask_kind: 'signoff', card_type: 'project_phase_closure' },
    decisions: decided(T('08:16:40'), 'triage_agent'),
  }),
  approval({
    id: 's3',
    card_id: 'c-close',
    created_at: T('08:55:24'),
    metadata: { ask_kind: 'signoff', card_type: 'project_closure' },
    decisions: decided(T('08:55:45'), 'triage_agent'),
  }),
];

const CARDS: BoardCardIn[] = [
  { id: 'c-setup', name: 'Project setup', list_phase: 'PUBLISHING', created_at: T('07:10:00'), phase_field: 'setup' },
  { id: 'c-pclose', name: 'Phase closure', list_phase: 'PUBLISHING', created_at: T('08:10:00'), phase_field: 'preliminary' },
  { id: 'c-fix', name: 'Add total_value', list_phase: 'PUBLISHING', created_at: T('08:30:00'), phase_field: 'execution' },
  // The closure card says phase=execution on the board; its card TYPE makes it Closure.
  { id: 'c-close', name: 'Project closure', list_phase: 'INSPECTING', created_at: T('08:50:00'), phase_field: 'execution', card_type: 'project_closure' },
  // No phase field, a bad one: NOT placed (never by creation time).
  { id: 'c-orphan', name: 'Stray card', list_phase: 'PUBLISHING', created_at: T('08:12:00'), phase_field: null },
  { id: 'c-bogus', name: 'Odd card', list_phase: 'READYING', created_at: T('08:31:00'), phase_field: 'bogus' },
];

const NOW = Date.parse(T('12:00:00'));
const MIN = 60_000;

describe('phaseWindowsFromEvents', () => {
  test("a kind 'closure' event CLOSES its phase instead of reopening it", () => {
    const w = phaseWindowsFromEvents(EVENTS);
    expect(w.get('execution')).toEqual({ entered: Date.parse(T('08:19:19')), left: Date.parse(T('08:57:21')) });
    expect(w.get('setup')).toEqual({ entered: Date.parse(T('07:02:59')), left: Date.parse(T('07:44:22')) });
  });

  // George 2026-10-31: RM records a project/phase RESTART as kind 'phase' with from = to.
  test("a kind 'phase' event with from = to (a restart) keeps the phase OPEN and its first entry", () => {
    const restart = { at: T('09:30:00'), from_phase: 'execution', to_phase: 'execution', kind: 'phase' };
    const w = phaseWindowsFromEvents([restart, ...EVENTS.slice(1)]);
    expect(w.get('execution')).toEqual({ entered: Date.parse(T('08:19:19')), left: null });
  });

  test('an event with NO kind and from = to still closes its phase (the shape before RM named closures)', () => {
    const legacy = { at: T('08:57:21'), from_phase: 'execution', to_phase: 'execution' };
    const w = phaseWindowsFromEvents([legacy, ...EVENTS.slice(1)]);
    expect(w.get('execution')).toEqual({ entered: Date.parse(T('08:19:19')), left: Date.parse(T('08:57:21')) });
  });

  test('a restart AFTER a closure reopens the phase', () => {
    const restart = { at: T('09:30:00'), from_phase: 'execution', to_phase: 'execution', kind: 'phase' };
    const w = phaseWindowsFromEvents([restart, ...EVENTS]);
    expect(w.get('execution')).toEqual({ entered: Date.parse(T('08:19:19')), left: null });
  });
});

describe('closureEventAt', () => {
  test("is the newest kind 'closure' event", () => {
    expect(closureEventAt(EVENTS)).toBe(Date.parse(T('08:57:21')));
  });

  test("an explicit kind 'phase' from = to event (a restart) is not a closure", () => {
    expect(
      closureEventAt([{ at: T('09:30:00'), from_phase: 'execution', to_phase: 'execution', kind: 'phase' }, ...EVENTS.slice(1)]),
    ).toBeNull();
  });

  test('an event with NO kind keeps the old reading: from = to is a closure', () => {
    expect(closureEventAt([{ at: T('09:40:00'), from_phase: 'execution', to_phase: 'execution' }, ...EVENTS.slice(1)])).toBe(
      Date.parse(T('09:40:00')),
    );
    expect(closureEventAt([{ at: T('09:40:00'), from_phase: 'execution', to_phase: 'execution', kind: null }, ...EVENTS.slice(1)])).toBe(
      Date.parse(T('09:40:00')),
    );
  });
});

describe('composeSpine — run 7 (closed)', () => {
  const spine = composeSpine({ nodes: NODES, events: EVENTS, approvals: APPROVALS, cards: CARDS, closed: true, now: NOW });

  test('four segments (fr adds Closure): setup 41, preliminary 35, execution 31 (to the closure card), closure 7 min', () => {
    expect(spine.phases.map((p) => [p.name, p.label, p.state, Math.round((p.duration_ms ?? 0) / MIN)])).toEqual([
      ['setup', 'Setup', 'done', 41],
      ['preliminary', 'Preliminary', 'done', 35],
      ['execution', 'Execution', 'done', 31],
      ['closure', 'Closure', 'done', 7],
    ]);
    // Execution ends where Closure began (the closure card was made); Closure ends at RM's closure event.
    expect(spine.phases[2]!.left_at).toBe('2026-10-25T08:50:00.000Z');
    expect(spine.phases[3]!.left_at).toBe('2026-10-25T08:57:21.000Z');
  });

  test('R-CK1: every decision was the triage agent ⇒ zero time waiting on people', () => {
    expect(spine.totals.human_wait_ms).toBe(0);
    expect(spine.totals.machine_ms).toBe(spine.totals.duration_ms);
  });

  test("a gate after every phase left, signed by the latest sign-off on one of THAT phase's cards", () => {
    expect(spine.gates.map((g) => [g.phase, g.state, g.approval_id, g.signed_by_kind])).toEqual([
      ['setup', 'passed', 's1', 'triage_agent'],
      ['preliminary', 'passed', 's2', 'triage_agent'],
      // No sign-off on an execution card: passed, but nobody is named (never borrowed by time).
      ['execution', 'passed', null, null],
      ['closure', 'passed', 's3', 'triage_agent'],
    ]);
    // The card type is left out when it only repeats the card's name.
    expect(spine.gates[0]!.subject).toBe('Sign-off for “Project setup”');
    expect(spine.gates[1]!.subject).toBe('Sign-off for “Phase closure” (project phase closure)');
    expect(spine.gates[0]!.signed_at).toBe(T('07:41:34'));
  });

  test('cards are placed EXACTLY: phase field, or project_closure ⇒ Closure; no field / a bad field ⇒ not placed', () => {
    const byId = Object.fromEntries(spine.cards.map((c) => [c.id, [c.phase, c.placed_by, c.state]]));
    expect(byId['c-setup']).toEqual(['setup', 'card_phase', 'done']);
    expect(byId['c-pclose']).toEqual(['preliminary', 'card_phase', 'done']);
    expect(byId['c-fix']).toEqual(['execution', 'card_phase', 'done']);
    expect(byId['c-close']).toEqual(['closure', 'card_type', 'qa']);
    // Created inside the preliminary window, yet NOT placed there: a phase is never guessed.
    expect(byId['c-orphan']).toEqual([null, null, 'done']);
    expect(byId['c-bogus']).toEqual([null, null, 'todo']);
    expect(spine.phases[2]!.card_ids).toEqual(['c-fix']);
    expect(spine.phases[3]!.card_ids).toEqual(['c-close']);
  });

  test('a live project whose closure card has left To do is IN Closure; one still in To do is not', () => {
    const live = EVENTS.slice(1);
    const now = Date.parse(T('08:55:00'));
    const doing = composeSpine({ nodes: NODES, events: live, approvals: [], cards: CARDS, closed: false, now });
    expect(doing.phases.map((p) => [p.name, p.state])).toEqual([
      ['setup', 'done'],
      ['preliminary', 'done'],
      ['execution', 'done'],
      ['closure', 'active'],
    ]);
    const todo = CARDS.map((c) => (c.id === 'c-close' ? { ...c, list_phase: 'READYING' as const } : c));
    const waiting = composeSpine({ nodes: NODES, events: live, approvals: [], cards: todo, closed: false, now });
    expect(waiting.phases.map((p) => p.state)).toEqual(['done', 'done', 'active', 'upcoming']);
  });

  test('a type that already names a closure phase gets no second one', () => {
    const nodes = [...NODES, { phase: 'closure', label: 'Wrap-up', state: 'upcoming' as const, isGate: false }];
    expect(withClosure(nodes).map((n) => n.label)).toEqual(['Setup', 'Preliminary', 'Execution', 'Wrap-up']);
    expect(exactCardPhase({ phase_field: 'setup', card_type: 'project_closure' }, new Set(['setup', 'closure']))).toEqual({
      phase: 'closure',
      placed_by: 'card_type',
    });
  });
});

describe('composeSpine — machine vs people (R-CK1)', () => {
  test('a HUMAN decision counts as waiting on people; overlapping waits are not double counted', () => {
    const approvals = [
      approval({ id: 'h1', created_at: T('07:10:00'), decisions: decided(T('07:30:00'), 'human') }),
      approval({ id: 'h2', created_at: T('07:20:00'), decisions: decided(T('07:40:00'), 'human') }),
      approval({ id: 'r1', created_at: T('07:00:00'), decisions: decided(T('07:44:00'), 'rule') }),
    ];
    const s = composeSpine({ nodes: NODES, events: EVENTS, approvals, cards: [], closed: true, now: NOW });
    expect(s.phases[0]!.human_wait_ms).toBe(30 * MIN); // 07:10 → 07:40, merged
    expect(s.phases[0]!.machine_ms).toBe(s.phases[0]!.duration_ms! - 30 * MIN);
    expect(s.phases[1]!.human_wait_ms).toBe(0);
  });

  test('an open item on a live project waits on people up to now, and its gate reads "waiting"', () => {
    const now = Date.parse(T('08:30:00'));
    const live = EVENTS.slice(1);
    const approvals = [approval({ id: 'p1', status: 'pending', created_at: T('08:20:00'), decisions: [] })];
    const s = composeSpine({ nodes: NODES, events: live, approvals, cards: [], closed: false, now });
    const exec = s.phases[2]!;
    expect(exec.state).toBe('active');
    expect(exec.left_at).toBeNull();
    expect(exec.duration_ms).toBe(now - Date.parse(T('08:19:19')));
    expect(exec.human_wait_ms).toBe(10 * MIN);
    // Waiting only on a sign-off raised on one of THIS phase's cards.
    expect(s.gates.at(-1)).toMatchObject({ phase: 'execution', state: 'ahead', approval_id: null });
    const onCard = [approval({ id: 'p2', status: 'pending', card_id: 'c-fix', created_at: T('08:20:00'), decisions: [] })];
    const s2 = composeSpine({ nodes: NODES, events: live, approvals: onCard, cards: CARDS.filter((c) => c.id !== 'c-close'), closed: false, now });
    expect(s2.gates.at(-1)).toMatchObject({ phase: 'execution', state: 'waiting', approval_id: 'p2' });
  });

  test('a phase never entered has no duration and is "upcoming" on a live project, "not run" on a closed one', () => {
    const nodes = [...NODES, { phase: 'handover', label: 'Handover', state: 'gate' as const, isGate: true }];
    expect(composeSpine({ nodes, events: EVENTS, approvals: [], cards: [], closed: false, now: NOW }).phases[3]).toMatchObject({
      state: 'upcoming',
      duration_ms: null,
    });
    expect(composeSpine({ nodes, events: EVENTS, approvals: [], cards: [], closed: true, now: NOW }).phases[3]!.state).toBe('not_run');
  });
});

describe('composeDecisionLog (C8)', () => {
  const names = new Map(CARDS.map((c) => [c.id, c.name ?? ''] as const));
  const spineCards = composeSpine({ nodes: NODES, events: EVENTS, approvals: APPROVALS, cards: CARDS, closed: true, now: NOW }).cards;
  const cardPhases = new Map(spineCards.filter((c) => c.phase).map((c) => [c.id, c.phase as string] as const));
  const rows = composeDecisionLog({ approvals: APPROVALS, cardNames: names, cardPhases });

  test('oldest first; every row names its subject in a plain sentence', () => {
    expect(rows.map((r) => r.subject)).toEqual([
      'Question on “Project setup”',
      'Sign-off for “Project setup”',
      'Sign-off for “Phase closure” (project phase closure)',
      'Sign-off for “Project closure”',
    ]);
    for (const r of rows) {
      expect(`${r.subject} ${r.question} ${r.answer}`).not.toMatch(/A decision was/);
      expect(r.question).not.toMatch(/\[ready-signoff\]|\d{15,}/);
    }
  });

  test('question and answer are one line each; actor kind and phase are recorded', () => {
    expect(rows[0]).toMatchObject({
      kind: 'question',
      question: 'Which repository holds the fixture?',
      answer: 'Approved — Fixed: the conveyor tenant now has access to conveyor-coding',
      actor_kind: 'triage_agent',
      phase: 'setup',
      open: false,
    });
    expect(rows[2]!.phase).toBe('preliminary');
    expect(rows[3]!.phase).toBe('closure');
  });

  test('a decision with no card, or on an unplaced card, has NO phase (never by the time it was asked)', () => {
    const r = composeDecisionLog({
      approvals: [approval({ id: 'x', card_id: null, created_at: T('07:20:00') }), approval({ id: 'y', card_id: 'c-orphan', created_at: T('08:13:00') })],
      cardNames: names,
      cardPhases,
    });
    expect(r.map((d) => d.phase)).toEqual([null, null]);
  });

  test('an open item has no answer and no actor', () => {
    const [r] = composeDecisionLog({
      approvals: [approval({ id: 'o', status: 'pending', decisions: [] })],
      cardNames: new Map(),
    });
    expect(r).toMatchObject({ open: true, answer: null, actor_kind: null, decision: null });
    expect(r!.subject).toBe('Sign-off for the project setup step');
  });

  test('subjects without a card or a type still say what they are', () => {
    expect(decisionSubject('request', null, null)).toBe('Request on this project');
    expect(oneLine('first\nsecond')).toBe('first');
    expect(oneLine('x'.repeat(200), 10)).toHaveLength(10);
  });
});

describe('the live timeline no longer says "A decision was approved"', () => {
  test('a decision row names its subject', () => {
    const events = composeTimeline({
      mappings: [],
      sessions: [],
      approvals: [APPROVALS[1]!],
      cards: [],
      now: NOW,
      cardNames: new Map([['c-setup', 'Project setup']]),
    });
    const d = events.find((e) => e.type === 'decision_write');
    expect(d?.title).toBe('Approved: Sign-off for “Project setup”');
  });
});
