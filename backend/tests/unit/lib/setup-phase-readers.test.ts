// tests/unit/lib/setup-phase-readers.test.ts
//
// v4 D16 (George 2026-10-13): requirements_management creates EVERY project in
// phase `setup`, the first phase of every startable type. The rail readers
// render it as a NORMAL phase: active first node, the rest upcoming. `null` is a
// defensive fallback only (every node pending). Pure.

import { describe, expect, test } from 'bun:test';

import { nextGate, railNodes, type PhaseSpec } from '../../../src/lib/project-phase';
import { planNextGate, planRailNodes } from '../../../src/lib/plan-phase-exit';
import type { PhasePlan } from '../../../src/lib/phase-plan';
import { SETUP_PHASE, isStartableProjectType } from '../../../src/services/catalogue/tenant-catalogue';

const TYPE: PhaseSpec[] = [
  { name: 'setup', title: 'Setup', has_gate: false },
  { name: 'request', title: 'Request', has_gate: false },
  { name: 'contract', title: 'Contract', has_gate: true },
  { name: 'execution', title: 'Execution', has_gate: false },
];

describe('the type rail: setup is a normal phase', () => {
  test('a new project (phase setup): setup active, the rest pending, next gate = contract', () => {
    expect(SETUP_PHASE).toBe('setup');
    expect(railNodes(TYPE, 'setup')!.map((n) => [n.phase, n.state])).toEqual([
      ['setup', 'active'],
      ['request', 'upcoming'],
      ['contract', 'gate'],
      ['execution', 'upcoming'],
    ]);
    expect(nextGate(TYPE, 'setup')).toBe('contract');
  });

  test('null stays a defensive fallback: every node pending, none active', () => {
    expect(railNodes(TYPE, null)!.some((n) => n.state === 'active' || n.state === 'done')).toBe(false);
  });

  test('startable = the RM phase list STARTS with setup (position order)', () => {
    const at = (names: string[]) => names.map((name, position) => ({ phase_id: name, name, title: name, position, has_gate: false }));
    expect(isStartableProjectType({ phases: at(['setup', 'request']) })).toBe(true);
    expect(isStartableProjectType({ phases: at(['request', 'setup']) })).toBe(false);
    expect(isStartableProjectType({ phases: [] })).toBe(false);
    // position, not array order, decides
    expect(isStartableProjectType({ phases: [{ phase_id: 'r', name: 'request', title: 'r', position: 1, has_gate: false }, { phase_id: 's', name: 'setup', title: 's', position: 0, has_gate: false }] })).toBe(true);
  });
});

describe('the plan rail: setup precedes a plan that does not list it', () => {
  const plan = { phases: ['deep_analysis', 'feature_development'], gates: { deep_analysis: ['approval'] } } as unknown as PhasePlan;
  const labels = new Map([['setup', 'Setup (RM)'], ['deep_analysis', 'Deep analysis']]);

  test('phase setup: an ACTIVE setup node first, then the plan pending', () => {
    const nodes = planRailNodes(plan, 'setup', labels)!;
    expect(nodes.map((n) => [n.phase, n.label, n.state])).toEqual([
      ['setup', 'Setup (RM)', 'active'],
      ['deep_analysis', 'Deep analysis', 'gate'],
      ['feature_development', 'feature_development', 'upcoming'],
    ]);
    expect(planNextGate(plan, 'setup')).toBe('deep_analysis');
  });

  test('control: a phase that is in no plan and is not setup is still the unplaced (null) rail', () => {
    expect(planRailNodes(plan, 'closure', labels)).toBeNull();
    expect(planNextGate(plan, 'closure')).toBeNull();
  });
});
