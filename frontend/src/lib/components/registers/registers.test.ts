// registers.test.ts — the Registers page helpers (REG-3): rows, owner labels, phase filter, sorting
// and the client-side CSV export (escaping + CSV injection).
import { describe, expect, it } from 'vitest';
import type { CockpitDecision, RegisterCriterion, RegisterRisk } from '$lib/types/cockpit';
import {
  ALL_PHASES,
  csvCell,
  csvFileName,
  criteriaCsv,
  criterionRows,
  decisionsCsv,
  displayCriteria,
  inPhase,
  logDecisionRows,
  nextSort,
  ownerLabel,
  phaseOptions,
  registerDecisionRows,
  riskRows,
  riskScore,
  risksCsv,
  sortDecisions,
  sortRisks,
  toCsv,
} from './registers';

const risk = (over: Partial<RegisterRisk>): RegisterRisk => ({
  id: 'r',
  title: 'A risk',
  score: 0,
  status: 'identified',
  owner: 'analysis',
  response_plan: null,
  phase: null,
  probability: 0.5,
  impact: 3,
  category: 'scope',
  card_id: null,
  raised_at: '2026-10-25T10:15:00Z',
  ...over,
});

const OPTS = phaseOptions([
  { name: 'setup', label: 'Setup' },
  { name: 'preliminary', label: 'Preliminary' },
  { name: 'execution', label: 'Execution' },
  { name: 'closure', label: 'Closure' },
]);

describe('phaseOptions / inPhase', () => {
  it('starts with All, then the project phases; falls back to the default model', () => {
    expect(OPTS.map((o) => o.label)).toEqual(['All', 'Setup', 'Preliminary', 'Execution', 'Closure']);
    expect(phaseOptions(null).map((o) => o.name)).toEqual([ALL_PHASES, 'setup', 'preliminary', 'execution', 'closure']);
  });

  it('All keeps every row; a phase keeps only rows that RECORDED it (no phase ⇒ All only)', () => {
    expect(inPhase(null, ALL_PHASES)).toBe(true);
    expect(inPhase('execution', 'execution')).toBe(true);
    expect(inPhase(null, 'execution')).toBe(false);
    expect(inPhase('setup', 'execution')).toBe(false);
  });
});

describe('ownerLabel', () => {
  it('maps the capability names RM holds today to the agent, and keeps anything else readable', () => {
    expect(ownerLabel('development')).toBe('Development agent');
    expect(ownerLabel('change_management')).toBe('Change management agent');
    expect(ownerLabel('testing')).toBe('Testing agent');
    expect(ownerLabel('product_owner')).toBe('Product owner');
    expect(ownerLabel('Jane Doe')).toBe('Jane Doe');
    expect(ownerLabel(null)).toBe('No owner yet');
    expect(ownerLabel('  ')).toBe('No owner yet');
  });
});

describe('riskRows / sortRisks', () => {
  it('score = p × i to 2 decimals (not RM\'s unrounded float), with the factors', () => {
    expect(riskScore({ score: 0.6000000000000001, probability: 0.2, impact: 3 })).toBe(0.6);
    const [row] = riskRows([risk({ probability: 0.2, impact: 3, score: 0.6000000000000001 })], OPTS, new Map());
    expect(row!.scoreText).toBe('0.60');
    expect(row!.factors).toBe('0.2 × 3');
    expect(row!.category).toBe('Scope');
    expect(row!.owner).toBe('Analysis agent');
    expect(row!.status).toBe('Identified');
    expect(row!.phaseLabel).toBeNull();
  });

  it('falls back to RM\'s score when a factor is missing', () => {
    expect(riskScore({ score: 2.456, probability: null, impact: 3 })).toBe(2.46);
  });

  it('names the card only when its id resolves on the project board', () => {
    const rows = riskRows(
      [risk({ id: 'a', card_id: 'c1', phase: 'execution' }), risk({ id: 'b', card_id: 'c-unknown' })],
      OPTS,
      new Map([['c1', 'Start execution phase']]),
    );
    expect(rows.map((r) => r.cardName)).toEqual(['Start execution phase', null]);
    expect(rows[0]!.phaseLabel).toBe('Execution');
  });

  it('defaults to the highest score first; a column click sorts and flips', () => {
    const rows = riskRows(
      [risk({ id: 'lo', title: 'B', probability: 0.2, impact: 1 }), risk({ id: 'hi', title: 'C', probability: 0.8, impact: 3 }), risk({ id: 'mid', title: 'A' })],
      OPTS,
      new Map(),
    );
    expect(sortRisks(rows).map((r) => r.id)).toEqual(['hi', 'mid', 'lo']);
    const byTitle = nextSort({ key: 'score', dir: 'desc' } as const, 'title');
    expect(byTitle).toEqual({ key: 'title', dir: 'asc' });
    expect(sortRisks(rows, byTitle).map((r) => r.title)).toEqual(['A', 'B', 'C']);
    expect(sortRisks(rows, nextSort(byTitle, 'title')).map((r) => r.title)).toEqual(['C', 'B', 'A']);
  });
});

describe('displayCriteria', () => {
  it('shows a sentence once when the setup flow wrote it as both a success and an acceptance criterion', () => {
    const rows = displayCriteria([
      { kind: 'success', id: null, text: 'A regression test for even-length input passes', status: null },
      { kind: 'acceptance', id: 'k1', text: 'A regression test for even-length input passes', status: 'met' },
      { kind: 'success', id: null, text: 'The report lists low stock', status: null },
    ]);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ['acceptance', 'A regression test for even-length input passes'],
      ['success', 'The report lists low stock'],
    ]);
  });

  it('matches on the words, not on spacing', () => {
    const rows = displayCriteria([
      { kind: 'success', id: null, text: '  A regression   test passes ', status: null },
      { kind: 'acceptance', id: 'k1', text: 'A regression test passes', status: 'unchecked' },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['acceptance']);
  });
});

describe('criterionRows', () => {
  it('met / not yet met / not scored (success criteria carry no check), evidence with links', () => {
    const criteria: RegisterCriterion[] = [
      { kind: 'success', id: null, text: 'Report lists low stock', status: null },
      { kind: 'acceptance', id: 'k1', text: 'F3 examples pass', status: 'met', evidence: [{ kind: 'pr', ref: 'https://github.com/x/y/pull/1' }, { kind: 'test_run', ref: 'run-42' }] },
      { kind: 'acceptance', id: 'k2', text: 'Unchecked', status: 'unchecked' },
    ];
    const rows = criterionRows(criteria);
    expect(rows.map((r) => r.statusLabel)).toEqual(['Not scored', 'Met', 'Not yet met']);
    expect(rows.map((r) => r.checkable)).toEqual([false, true, true]);
    expect(rows[0]!.id).toBe('success-0');
    expect(rows[1]!.evidence).toEqual([
      { label: 'Pull request', ref: 'https://github.com/x/y/pull/1', href: 'https://github.com/x/y/pull/1' },
      { label: 'Test run', ref: 'run-42', href: null },
    ]);
  });
});

describe('decision rows', () => {
  const log: CockpitDecision[] = [
    { approval_id: 'a1', kind: 'signoff', subject: 'Sign-off for “Plan”', question: '', question_full: '', answer: 'Approved', answer_full: null, decision: 'approved', actor_kind: 'triage_agent', actor_name: null, asked_at: '2026-10-25T10:00:00Z', decided_at: '2026-10-25T10:12:00Z', card_id: 'c1', card_name: 'Plan', phase: 'setup', open: false },
    { approval_id: 'a2', kind: 'signoff', subject: 'Open ask', question: '', question_full: '', answer: null, answer_full: null, decision: null, actor_kind: null, actor_name: null, asked_at: '2026-10-25T12:00:00Z', decided_at: null, card_id: null, card_name: null, phase: null, open: true },
    { approval_id: 'a3', kind: 'question', subject: 'Planning block', question: '', question_full: '', answer: 'One card per problem', answer_full: null, decision: 'approved', actor_kind: 'human', actor_name: 'George', asked_at: '2026-10-25T12:40:00Z', decided_at: '2026-10-25T12:45:00Z', card_id: null, card_name: null, phase: 'execution', open: false },
  ];

  it('the decision log keeps only decided rows, newest first', () => {
    const rows = sortDecisions(logDecisionRows(log, OPTS));
    expect(rows.map((r) => r.id)).toEqual(['a3', 'a1']);
    expect(rows[0]!.text).toBe('Planning block: One card per problem');
    expect(rows[0]!.by).toBe('George');
    expect(rows[1]!.by).toBe('Approval agent');
    expect(rows[1]!.phaseLabel).toBe('Setup');
  });

  it('RM decisions read decided_by_kind in the same words', () => {
    const [r] = registerDecisionRows(
      [{ id: 'd1', title: 'Use one card per problem', decision: 'Split', decided_by_kind: 'agent', decided_at: null, raised_at: '2026-10-25T11:00:00Z', phase: 'execution', card_id: 'c9' }],
      OPTS,
      new Map([['c9', 'Plan execution']]),
    );
    expect(r).toMatchObject({ text: 'Use one card per problem: Split', by: 'Approval agent', at: '2026-10-25T11:00:00Z', phaseLabel: 'Execution', cardName: 'Plan execution' });
  });
});

describe('CSV export', () => {
  it('quotes text, doubles inner quotes, keeps commas and newlines inside the cell', () => {
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
    expect(csvCell(1.5)).toBe('1.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('neutralises formula injection: a leading = + - @ tab or CR is prefixed with a quote', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('\t=1')).toBe('"\'\t=1"');
    expect(csvCell('\r=1')).toBe('"\'\r=1"');
    // Not at the start: left alone. A number is a number, never prefixed.
    expect(csvCell('a=b')).toBe('"a=b"');
    expect(csvCell(-1)).toBe('-1');
  });

  it('rows join with CRLF and end with one', () => {
    expect(toCsv(['A', 'B'], [['x', 1]])).toBe('"A","B"\r\n"x",1\r\n');
  });

  it('the risks CSV carries the filtered, sorted rows the table shows', () => {
    const rows = sortRisks(
      riskRows([risk({ id: 'a', title: '=evil()', phase: 'execution', response_plan: 'Line 1\nLine 2' }), risk({ id: 'b', title: 'Other', phase: 'setup' })], OPTS, new Map()).filter((r) =>
        inPhase(r.phase, 'execution'),
      ),
    );
    const csv = risksCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('"Score","Probability x impact","Risk","Category","Response plan","Owner","Phase","Raised at","Card","Status"');
    expect(lines).toHaveLength(3); // header + one row + trailing empty
    expect(lines[1]).toBe('1.5,"0.5 × 3","\'=evil()","Scope","Line 1\nLine 2","Analysis agent","Execution","2026-10-25T10:15:00Z",,"Identified"');
  });

  it('criteria and decisions CSVs', () => {
    expect(criteriaCsv(criterionRows([{ kind: 'acceptance', id: 'k', text: 'T', status: 'met', evidence: [{ kind: 'report', ref: 'r1' }] }]))).toBe(
      '"Kind","Criterion","Status","Evidence"\r\n"Acceptance criterion","T","Met","Report: r1"\r\n',
    );
    expect(decisionsCsv([{ id: 'x', at: null, text: '-x', by: 'A rule', phase: null, phaseLabel: null, cardName: null }])).toBe(
      '"Decided at","Decision","Decided by","Phase","Card"\r\n,"\'-x","A rule",,\r\n',
    );
  });

  it('file name names the register, the phase and the project', () => {
    expect(csvFileName('0d5c2fb9-47a2-4b48-83ed-f41e87017877', 'risks', 'all')).toBe('registers-risks-all-0d5c2fb9.csv');
  });
});
