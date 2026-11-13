// tests/unit/lib/plan-phase-exit.test.ts
//
// The PURE half of the plan read model (fr#1481): gate-slug mapping and the
// whole-plan predicate. DB-free; the DB-backed acceptance (the plan-phase-exit
// integration suite) was deleted 2026-10-29 — no longer in the suite.

import { describe, expect, test } from 'bun:test';

import { approvalKindEnum } from '../../../src/db/schema';
import {
  PLAN_GATE_MARKERS,
  evaluateGate,
  evaluatePlanPhases,
  gateRequirement,
} from '../../../src/lib/plan-phase-exit';
import { BUG_FIX_AUTHORIZATION_MARKER } from '../../../src/services/approvals/u3-gates';
import { PhasePlanSchema } from '../../../src/lib/phase-plan';

const KINDS = approvalKindEnum.enumValues;

describe('gate slugs → approval predicate', () => {
  test('the marker set is u3-gates\' marker (no second spelling)', () => {
    expect([...PLAN_GATE_MARKERS]).toEqual([BUG_FIX_AUTHORIZATION_MARKER]);
  });

  test('A1 = one approved execution.ready_signoff carrying the bug_fix_authorization marker', () => {
    expect(gateRequirement(['ready_signoff', 'bug_fix_authorization'], KINDS)).toEqual({
      groups: [{ kind: 'execution.ready_signoff', markers: ['bug_fix_authorization'] }],
      unknown: [],
    });
    const a1 = { id: 'a1', kind: 'execution.ready_signoff', approval_kind_marker: 'bug_fix_authorization' };
    const plain = { id: 'p', kind: 'execution.ready_signoff', approval_kind_marker: null };
    expect(evaluateGate(['ready_signoff', 'bug_fix_authorization'], KINDS, [plain]).satisfied).toBe(false);
    expect(evaluateGate(['ready_signoff', 'bug_fix_authorization'], KINDS, [plain, a1])).toEqual({
      kinds: ['ready_signoff', 'bug_fix_authorization'],
      satisfied: true,
      approval_ids: ['a1'],
      unknown_kinds: [],
    });
  });

  test('A3 / A5 name approval kinds', () => {
    expect(gateRequirement(['feature_design_approval'], KINDS).groups).toEqual([
      { kind: 'execution.feature_design_approval', markers: [] },
    ]);
    expect(gateRequirement(['landing_signoff'], KINDS).groups).toEqual([
      { kind: 'execution.landing_signoff', markers: [] },
    ]);
  });

  test('MUST-FAIL: an unknown slug makes the gate unsatisfiable, even with approvals present', () => {
    const g = evaluateGate(['not_a_kind'], KINDS, [{ id: 'x', kind: 'generic', approval_kind_marker: null }]);
    expect(g.satisfied).toBe(false);
    expect(g.unknown_kinds).toEqual(['not_a_kind']);
  });
});

describe('the whole-plan predicate', () => {
  const plan = PhasePlanSchema.parse({
    template_id: 'it.bug_hunt',
    template_hash: 'h',
    phases: ['deep_analysis', 'feature_development', 'closure'],
    gates: { deep_analysis: ['ready_signoff', 'bug_fix_authorization'] },
    deliverables: [
      { id: 'd1', phase: 'deep_analysis', card_types: ['code_quality_analysis'], cardinality: 'fixed:1', minter: 'commit' },
      { id: 'd2', phase: 'feature_development', card_types: ['development_bug_fix'], cardinality: 'per_approved_bug', minter: 'f' },
      { id: 'd3', phase: 'closure', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'planPhaseExit' },
    ],
  });
  const rows = [
    { id: 'r1', plan_deliverable_id: 'd1', title: 'd1', deferred: false, minted_at: null, minted_count: null },
    { id: 'r2', plan_deliverable_id: 'd2', title: 'd2', deferred: true, minted_at: null, minted_count: null },
    { id: 'r3', plan_deliverable_id: 'd3', title: 'd3', deferred: true, minted_at: null, minted_count: null },
  ];
  const base = {
    plan,
    currentPhase: 'deep_analysis',
    rows,
    cardsByRow: new Map([['r1', ['c1']]]),
    cardStates: new Map([['c1', { list: 'DONE', done: true }]]),
    approvalKinds: KINDS,
    labels: new Map([['deep_analysis', 'Deep analysis (RM)']]),
  };

  test('3 phases, A1 marker on deep_analysis, current highlighted, final phase never exit-ready', () => {
    const f = evaluatePlanPhases({ ...base, approved: [] });
    expect(f.map((p) => [p.phase, p.state, p.gate?.kinds ?? null])).toEqual([
      ['deep_analysis', 'active', ['ready_signoff', 'bug_fix_authorization']],
      ['feature_development', 'upcoming', null],
      ['closure', 'upcoming', null],
    ]);
    expect(f[0]!.exit_ready).toBe(false);
    expect(f[0]!.deliverables[0]!.cards).toEqual({ total: 1, done: 1, by_list: { DONE: 1 } });
    expect(f[2]!.blockers).toContain('final_phase');
    // labels are the project tenant's RM titles; no title ⇒ the name
    expect(f.map((p) => p.label)).toEqual(['Deep analysis (RM)', 'feature_development', 'closure']);
  });

  test('with A1 → deep_analysis is exit-ready to feature_development', () => {
    const f = evaluatePlanPhases({
      ...base,
      approved: [{ id: 'a1', kind: 'execution.ready_signoff', approval_kind_marker: 'bug_fix_authorization' }],
    });
    expect(f[0]!.exit_ready).toBe(true);
    expect(f[0]!.next_phase).toBe('feature_development');
  });

  test('MUST-FAIL: a card absent from the board is NOT done', () => {
    const f = evaluatePlanPhases({
      ...base,
      cardStates: new Map(),
      approved: [{ id: 'a1', kind: 'execution.ready_signoff', approval_kind_marker: 'bug_fix_authorization' }],
    });
    expect(f[0]!.exit_ready).toBe(false);
    expect(f[0]!.blockers).toEqual(['deliverable d1: card_not_done']);
  });
});

describe('PhasePlanSchema refuses dead placements', () => {
  test('a gate or deliverable on a phase the plan does not walk', () => {
    const bad = PhasePlanSchema.safeParse({
      template_id: 't', template_hash: 'h', phases: ['deep_analysis'],
      gates: { closure: ['landing_signoff'] },
      deliverables: [{ id: 'x', phase: 'closure', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'm' }],
    });
    expect(bad.success).toBe(false);
  });

  test('a plan without gates/deliverables (pre-PR-H outline) stays valid', () => {
    expect(PhasePlanSchema.safeParse({ template_id: 't', template_hash: 'h', phases: ['deep_analysis'] }).success).toBe(true);
  });
});
