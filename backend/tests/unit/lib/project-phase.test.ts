// lib/project-phase.ts — the pure rail projection over a project type's
// ORDERED phase list (from requirements_management; fr holds no spine).
import { describe, expect, test } from 'bun:test';

import {
  isPhaseOf,
  nextGate,
  railNodes,
  type PhaseSpec,
} from '../../../src/lib/project-phase';

// A type whose names share nothing with fr's old spine — the projection must
// not care what the names are.
const PHASES: PhaseSpec[] = [
  { name: 'intake', title: 'Intake', has_gate: false },
  { name: 'scope', title: 'Scope', has_gate: true },
  { name: 'build', title: 'Build', has_gate: false },
  { name: 'accept', title: 'Accept', has_gate: true },
  { name: 'close', title: 'Close', has_gate: false },
];
const NAMES = PHASES.map((p) => p.name);

describe('isPhaseOf', () => {
  test('only names of the list', () => {
    for (const p of NAMES) expect(isPhaseOf(PHASES, p)).toBe(true);
    for (const v of ['request', 'continuous', '', undefined, 7]) expect(isPhaseOf(PHASES, v)).toBe(false);
  });
});

describe('railNodes', () => {
  test('done / active / gate / upcoming relative to current, labels = RM titles', () => {
    expect(railNodes(PHASES, 'build')).toEqual([
      { phase: 'intake', label: 'Intake', state: 'done', isGate: false },
      { phase: 'scope', label: 'Scope', state: 'done', isGate: true },
      { phase: 'build', label: 'Build', state: 'active', isGate: false },
      { phase: 'accept', label: 'Accept', state: 'gate', isGate: true },
      { phase: 'close', label: 'Close', state: 'upcoming', isGate: false },
    ]);
  });
  test('a current phase outside the list ⇒ null (never clamped to the first node)', () => {
    expect(railNodes(PHASES, 'request')).toBeNull();
    expect(railNodes([], 'intake')).toBeNull();
  });
  test('the rail has exactly the type’s phases, in its order', () => {
    expect(railNodes(PHASES, 'intake')!.map((n) => n.phase)).toEqual(NAMES);
  });
});

describe('nextGate', () => {
  test('the first gated phase at or after current', () => {
    expect(nextGate(PHASES, 'intake')).toBe('scope');
    expect(nextGate(PHASES, 'scope')).toBe('scope');
    expect(nextGate(PHASES, 'build')).toBe('accept');
    expect(nextGate(PHASES, 'close')).toBeNull();
    expect(nextGate(PHASES, 'nope')).toBeNull();
  });
});

describe('no fr vocabulary', () => {
  test('the module exports no spine, labels or phase list', async () => {
    const mod = (await import('../../../src/lib/project-phase')) as Record<string, unknown>;
    // Q2 (George 2026-10-12): no forward-only rule, no gate-skip refusal either.
    for (const gone of [
      'PROJECT_PHASE_SPINE',
      'PROJECT_PHASE_LABELS',
      'PROJECT_PHASE_GATES',
      'ALL_PROJECT_PHASES',
      'isProjectPhase',
      'isForwardPhase',
      'gateSkippedBy',
    ]) {
      expect(mod[gone]).toBeUndefined();
    }
  });
});
