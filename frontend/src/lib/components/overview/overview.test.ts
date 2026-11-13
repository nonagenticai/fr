// @vitest-environment jsdom
//
// R2 project Overview (FR-PROJECT-HOME-REDESIGN-2026-10-26 §4): the pure words (progress sentences,
// board line, the registers strip incl. its decision-log fallback) and the three components —
// PhaseDetail (a phase as a mini-project), ProjectOutcome (a closed project = outcome page, no
// asks, no drafts) and RegistersStrip (four states, a failed read never shown as empty).
//
// TO MAKE THIS FILE GO RED: let the outcome page list a draft or an open ask; word a failed
// registers read as "0 open risks"; let the phase shown default to anything but the current phase.
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import PhaseDetail from './PhaseDetail.svelte';
import ProjectOutcome from './ProjectOutcome.svelte';
import RegistersStrip from './RegistersStrip.svelte';
import { boardLine, outputMeta, phaseShown, phaseTiming, progressSentence, registersGlance, scoreWords, type RegistersView } from './overview';
import type { CockpitDecision, OverviewOutput, OverviewPhase, ProjectOverview, ProjectRegisters } from '$lib/types/cockpit';
import type { Panel } from '$lib/types/panel';

const T = (hm: string) => `2026-10-25T${hm}:00.000Z`;

function out(over: Partial<OverviewOutput> & { id: string }): OverviewOutput {
  return {
    kind: 'document',
    title: 'Report',
    type_label: 'Report',
    status: 'published',
    summary: null,
    at: T('10:33'),
    card_id: null,
    card_name: null,
    phase: null,
    is_final: false,
    url: null,
    ...over,
  };
}

function phase(over: Partial<OverviewPhase> & { name: string }): OverviewPhase {
  return {
    label: over.name.charAt(0).toUpperCase() + over.name.slice(1),
    position: 1,
    state: 'done',
    entered_at: T('09:56'),
    left_at: T('10:15'),
    duration_ms: 19 * 60_000,
    cards: { total: 2, by_state: { todo: 0, doing: 0, qa: 0, done: 2, blocked: 0 }, items: [] },
    outputs: [],
    delivered: [],
    decisions: 0,
    open_asks: 0,
    cost: { cost: 7.22, calls: 70 },
    signoff: { at: T('10:12'), by_kind: 'triage_agent', by_name: null, subject: 'Sign-off for “Project setup”' },
    ...over,
  };
}

const PHASES: OverviewPhase[] = [
  phase({ name: 'setup', position: 1, delivered: [out({ id: 'b', title: 'Project brief · version 3', phase: 'setup' })] }),
  phase({ name: 'preliminary', position: 2, entered_at: T('10:15'), left_at: T('10:41') }),
  phase({
    name: 'execution',
    position: 3,
    state: 'active',
    left_at: null,
    duration_ms: 142 * 60_000,
    cards: {
      total: 6,
      by_state: { todo: 4, doing: 0, qa: 0, done: 1, blocked: 1 },
      items: [
        { id: 'c1', name: 'F3 3-tuple shape', state: 'done' },
        { id: 'c2', name: 'Start execution phase', state: 'blocked' },
      ],
    },
    outputs: [out({ id: 'pr', kind: 'pull_request', title: 'PR #3 · low_stock_report() returns 3-tuples', type_label: 'Pull request', status: 'open', url: 'https://github.com/o/r/pull/3', phase: 'execution' })],
    open_asks: 1,
    signoff: null,
    cost: { cost: 13.65, calls: 113 },
  }),
  phase({ name: 'closure', position: 4, state: 'upcoming', entered_at: null, left_at: null, duration_ms: null, cards: { total: 0, by_state: { todo: 0, doing: 0, qa: 0, done: 0, blocked: 0 }, items: [] }, signoff: null, cost: { cost: 0, calls: 0 } }),
];

function overview(over: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    phases: PHASES,
    current_phase: 'execution',
    current_position: 3,
    phase_count: 4,
    unassigned: { cards: 0, outputs: [], decisions: 0, cost: null },
    outputs: [],
    outcome: null,
    problems: [],
    cost_by_card_since: null,
    currency: 'USD',
    ...over,
  };
}

const decision = (over: Partial<CockpitDecision> & { approval_id: string }): CockpitDecision => ({
  kind: 'signoff',
  subject: 'Sign-off for “Start execution phase”',
  question: 'q',
  question_full: 'q',
  answer: 'Approved',
  answer_full: 'Approved',
  decision: 'approved',
  actor_kind: 'triage_agent',
  actor_name: null,
  asked_at: T('12:45'),
  decided_at: T('12:50'),
  card_id: null,
  card_name: null,
  phase: 'execution',
  open: false,
  ...over,
});

const REGISTERS: Extract<ProjectRegisters, { available: true }> = {
  available: true,
  project_id: 'p1',
  rm_project_id: 'rm',
  phase: null,
  risks: [
    { id: 'r1', title: 'Incomplete edge-case coverage', score: 1.5, status: 'identified', owner: 'analysis agent', response_plan: null, phase: 'execution' },
    { id: 'r2', title: 'Test update scope creep', score: 2.25, status: 'identified', owner: 'development agent', response_plan: null, phase: 'execution' },
    { id: 'r3', title: 'Closed one', score: 9, status: 'closed', owner: null, response_plan: null, phase: null },
    { id: 'r4', title: 'Test drift', score: 1.2, status: 'DRAFT', owner: 'development agent', response_plan: null, phase: null },
    { id: 'r5', title: 'Low', score: 0.4, status: 'identified', owner: null, response_plan: null, phase: null },
  ],
  decisions: [],
  requirements: [],
  criteria: [
    { kind: 'acceptance', id: 'k1', text: 'The F4 examples in BRIEF.md pass as tests', status: 'met' },
    { kind: 'acceptance', id: 'k2', text: 'Docs updated', status: 'not_met' },
  ],
  counts: { risks_open: 4, risks_total: 5, decisions: 0, requirements: 0, criteria_met: 1, criteria_total: 2 },
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host?.remove();
});
function render(C: unknown, props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(C as never, { target: host, props });
  flushSync();
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const $$ = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)];

describe('overview words', () => {
  it('the phase shown defaults to the CURRENT phase; a chosen phase wins; an unknown choice falls back', () => {
    expect(phaseShown(overview(), null)).toBe('execution');
    expect(phaseShown(overview(), 'setup')).toBe('setup');
    expect(phaseShown(overview(), 'nope')).toBe('execution');
    expect(phaseShown(overview({ current_phase: null }), null)).toBe('setup');
  });

  it('progress as plain sentences, per phase state', () => {
    expect(progressSentence(PHASES[0]!)).toMatch(/^2 of 2 cards done\. Delivered: Project brief · version 3\. Signed off by Approval agent, /);
    expect(progressSentence(PHASES[2]!)).toBe('1 of 6 cards done; 1 blocked. 1 question or sign-off waiting.');
    expect(progressSentence(PHASES[3]!)).toBe('Not started yet.');
    expect(progressSentence(phase({ name: 'x', state: 'not_run' }))).toBe('Did not run.');
  });

  it('the board is ONE line (D8), empty columns left out', () => {
    expect(boardLine({ todo: 4, doing: 0, qa: 0, done: 1, blocked: 1 })).toBe('To do 4 · Blocked 1 · Done 1');
    expect(boardLine({ todo: 0, doing: 0, qa: 0, done: 0, blocked: 0 })).toBe('No cards');
  });

  it('timing and output meta', () => {
    expect(phaseTiming(PHASES[3]!)).toBe('Not started');
    expect(phaseTiming(PHASES[2]!)).toMatch(/^2 h 22 min so far · since /);
    expect(outputMeta(out({ id: 'x', type_label: 'Analysis report', status: 'draft' }))).toMatch(/^Analysis report · draft · /);
  });

  it('registers at a glance: open risks by score (closed ones out), decisions fall back to the decision log', () => {
    const log = [decision({ approval_id: 'd1', decided_at: T('11:16') }), decision({ approval_id: 'd2' }), decision({ approval_id: 'o', open: true, decided_at: null })];
    const g = registersGlance(REGISTERS, log);
    expect(g.risksOpen).toBe(4);
    expect(g.topRisks.map((r) => r.id)).toEqual(['r2', 'r1', 'r4']);
    expect(g.decisionsSource).toBe('log');
    expect(g.decisions.map((d) => d.id)).toEqual(['d2', 'd1']);
    expect([g.criteriaMet, g.criteriaTotal]).toEqual([1, 2]);
    const withRm = registersGlance({ ...REGISTERS, decisions: [{ id: 'rd', title: 'Use FIFO valuation', decision: 'x', decided_by_kind: 'human', decided_at: T('11:00'), phase: 'execution' }], counts: { ...REGISTERS.counts, decisions: 1 } }, log);
    expect(withRm.decisionsSource).toBe('register');
    expect(withRm.decisions.map((d) => [d.text, d.by])).toEqual([['Use FIFO valuation', 'A person']]);
    expect(scoreWords(1.5)).toBe('1.5');
  });
});

describe('PhaseDetail', () => {
  const decisions: Panel<CockpitDecision[]> = { data: [decision({ approval_id: 'd1' }), decision({ approval_id: 'd9', phase: 'setup', subject: 'Brief signed off' })], as_of: T('13:00'), health: 'ok' };

  it('the CURRENT phase: progress, one-line board, its cards, its outputs, only its decisions', () => {
    render(PhaseDetail, { projectId: 'p1', phase: PHASES[2], currency: 'USD', decisions });
    expect($('phase-detail')?.getAttribute('data-phase')).toBe('execution');
    expect($('phase-progress')?.textContent).toBe('1 of 6 cards done; 1 blocked. 1 question or sign-off waiting.');
    expect($('phase-board-line')?.textContent).toBe('To do 4 · Blocked 1 · Done 1');
    expect($$('phase-card').map((c) => c.getAttribute('data-state'))).toEqual(['done', 'blocked']);
    expect($$('phase-output').map((o) => o.textContent)).toEqual([expect.stringContaining('PR #3 · low_stock_report() returns 3-tuples')]);
    expect($('phase-cost')?.textContent).toBe('$13.65 · 113 model calls');
    expect($$('decision-row').map((r) => r.getAttribute('data-approval'))).toEqual(['d1']);
    expect($('phase-delivered')).toBeNull();
  });

  it('a PAST phase shows what it delivered and who signed it off, and when', () => {
    render(PhaseDetail, { projectId: 'p1', phase: PHASES[0], currency: 'USD', decisions });
    expect($('phase-delivered')?.textContent).toContain('Project brief · version 3');
    expect($('phase-signed-by')?.textContent).toMatch(/^Approval agent, /);
    expect($$('decision-row').map((r) => r.getAttribute('data-approval'))).toEqual(['d9']);
  });
});

describe('ProjectOutcome — a closed project is an outcome page', () => {
  const finalReport = out({ id: 'f', title: 'Final report', is_final: true, phase: 'closure', at: T('08:50') });
  const pr = out({ id: 'pr:o/r#2', kind: 'pull_request', title: 'PR #2 · Add Inventory.total_value (F4)', status: 'merged', url: 'https://github.com/o/r/pull/2' });
  const done = overview({
    current_phase: 'closure',
    phases: PHASES.map((p) => ({ ...p, state: 'done' as const, open_asks: 0 })),
    outcome: { state: 'completed', final_report: finalReport, summary: 'Inventory.total_value() now returns the value of stock on hand.', pull_requests: [pr] },
  });
  const loaded: RegistersView = { kind: 'loaded', data: REGISTERS };

  it('what was delivered, the final report, the PRs, criteria met / not met, and every phase in a sentence', () => {
    render(ProjectOutcome, { projectId: 'p1', overview: done, registers: loaded });
    expect($('project-outcome')?.getAttribute('data-state')).toBe('completed');
    expect($('outcome-summary')?.textContent).toBe('Inventory.total_value() now returns the value of stock on hand.');
    expect($('outcome-final-report')?.getAttribute('href')).toBe('/projects/p1/documents/f');
    expect($('outcome-prs')?.textContent).toContain('PR #2 · Add Inventory.total_value (F4)');
    expect($('outcome-criteria-count')?.textContent).toBe('1 of 2 acceptance criteria met');
    expect($$('outcome-criterion').map((c) => c.getAttribute('data-status'))).toEqual(['met', 'not_met']);
    expect($$('outcome-phase').map((p) => p.getAttribute('data-phase'))).toEqual(['setup', 'preliminary', 'execution', 'closure']);
    // No asks, drafts or running indicators on an outcome page.
    expect(host.textContent).not.toMatch(/waiting|draft|so far|Approve/i);
  });

  it('a success criterion is listed, labelled not scored, and never counted as met or unmet', () => {
    const data: Extract<ProjectRegisters, { available: true }> = {
      ...REGISTERS,
      criteria: [
        { kind: 'success', id: null, text: 'The median bug no longer reproduces', status: null },
        { kind: 'acceptance', id: 'k1', text: 'The regression test passes', status: 'met' },
      ],
    };
    render(ProjectOutcome, { projectId: 'p1', overview: done, registers: { kind: 'loaded', data } });
    expect($('outcome-criteria-count')?.textContent).toContain('1 of 1 acceptance criteria met');
    expect($('outcome-criteria-count')?.textContent).toContain('1 success criterion not scored');
    expect($$('outcome-criterion').map((c) => c.getAttribute('data-status'))).toEqual(['none', 'met']);
  });

  it('a sentence the brief holds as both success and acceptance is listed once', () => {
    const text = 'A regression test for even-length input passes';
    const data: Extract<ProjectRegisters, { available: true }> = {
      ...REGISTERS,
      criteria: [
        { kind: 'success', id: null, text, status: null },
        { kind: 'acceptance', id: 'k1', text, status: 'met' },
      ],
    };
    render(ProjectOutcome, { projectId: 'p1', overview: done, registers: { kind: 'loaded', data } });
    expect($('outcome-criteria-count')?.textContent).toContain('1 of 1 acceptance criteria met');
    expect($$('outcome-criterion')).toHaveLength(1);
    expect($$('outcome-criterion').map((c) => c.getAttribute('data-status'))).toEqual(['met']);
  });

  it('a brief with only success criteria says there are no acceptance criteria and lists them as not scored', () => {
    const data: Extract<ProjectRegisters, { available: true }> = {
      ...REGISTERS,
      criteria: [{ kind: 'success', id: null, text: 'The report lists low stock', status: null }],
    };
    render(ProjectOutcome, { projectId: 'p1', overview: done, registers: { kind: 'loaded', data } });
    expect($('outcome-criteria-count')?.textContent).toContain('No acceptance criteria');
    expect($('outcome-criteria-count')?.textContent).toContain('1 success criterion not scored');
    expect($$('outcome-criterion')).toHaveLength(1);
  });

  it('a failed criteria read says so — never "no criteria"', () => {
    render(ProjectOutcome, { projectId: 'p1', overview: done, registers: { kind: 'failed', message: 'x' } });
    expect($('outcome-criteria-failed')).toBeTruthy();
    expect($('outcome-criteria-none')).toBeNull();
  });

  it('no final report published ⇒ it says so', () => {
    render(ProjectOutcome, { projectId: 'p1', overview: { ...done, outcome: { ...done.outcome!, final_report: null, summary: null } }, registers: loaded });
    expect($('outcome-no-report')).toBeTruthy();
  });
});

describe('RegistersStrip — four states', () => {
  it('loaded: open risks with the top 3 and owners, criteria x of y, decisions from the log until RM has some', () => {
    render(RegistersStrip, { view: { kind: 'loaded', data: REGISTERS }, decisions: [decision({ approval_id: 'd1' })] });
    expect($('registers-risks')?.textContent).toContain('4 open risks');
    expect($$('registers-risk').map((r) => r.textContent?.trim())).toEqual([
      expect.stringContaining('Test update scope creep · development agent'),
      expect.stringContaining('Incomplete edge-case coverage · analysis agent'),
      expect.stringContaining('Test drift · development agent'),
    ]);
    expect($('registers-criteria')?.textContent).toContain('1 of 2 acceptance criteria met');
    expect($('registers-decisions')?.getAttribute('data-source')).toBe('log');
  });

  it('a success criterion is never counted as an unmet one (run 9: one success + one acceptance, met)', () => {
    const data: Extract<ProjectRegisters, { available: true }> = {
      ...REGISTERS,
      criteria: [
        { kind: 'success', id: null, text: 'The median bug no longer reproduces', status: null },
        { kind: 'acceptance', id: 'k1', text: 'The regression test passes', status: 'met' },
      ],
    };
    render(RegistersStrip, { view: { kind: 'loaded', data } });
    expect($('registers-criteria')?.textContent).toContain('1 of 1 acceptance criteria met');
    expect($('registers-criteria')?.textContent).toContain('1 success criterion not scored');
    expect($('registers-criteria')?.textContent).not.toContain('1 of 2');
  });

  it('a sentence the brief holds as both success and acceptance is shown once, with its check', () => {
    const text = 'A regression test for even-length input passes';
    const data: Extract<ProjectRegisters, { available: true }> = {
      ...REGISTERS,
      criteria: [
        { kind: 'success', id: null, text, status: null },
        { kind: 'acceptance', id: 'k1', text, status: 'met' },
      ],
    };
    render(RegistersStrip, { view: { kind: 'loaded', data } });
    expect($('registers-criteria')?.textContent).toContain('1 of 1 acceptance criteria met');
    expect($('registers-criteria')?.textContent).not.toContain('not scored');
    expect($('registers-criteria')?.textContent).not.toContain('1 of 2');
  });

  it('a brief with no criteria says so; only success criteria are counted as not scored', () => {
    render(RegistersStrip, { view: { kind: 'loaded', data: { ...REGISTERS, criteria: [] } } });
    expect($('registers-criteria')?.textContent).toContain('No criteria yet');
  });

  it('only success criteria: no acceptance count, they are shown as not scored', () => {
    const data: Extract<ProjectRegisters, { available: true }> = {
      ...REGISTERS,
      criteria: [{ kind: 'success', id: null, text: 'The report lists low stock', status: null }],
    };
    render(RegistersStrip, { view: { kind: 'loaded', data } });
    expect($('registers-criteria')?.textContent).toContain('1 success criterion');
    expect($('registers-criteria')?.textContent).toContain('not scored');
    expect($('registers-criteria')?.textContent).not.toContain('acceptance criteria met');
  });

  it('a failed read is "could not be read", never zero risks', () => {
    render(RegistersStrip, { view: { kind: 'failed', message: 'x' } });
    expect($('registers-failed')).toBeTruthy();
    expect(host.textContent).not.toMatch(/0 open risks/);
  });

  it('a project with no RM link keeps no registers', () => {
    render(RegistersStrip, { view: { kind: 'loaded', data: { available: false, project_id: 'p', reason: 'no_rm_project' } } });
    expect($('registers-none')).toBeTruthy();
  });
});
