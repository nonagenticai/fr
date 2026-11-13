// tests/unit/services/cockpit/lifecycle-rail.test.ts
//
// The MACRO lifecycle rail block on the project cockpit read-model. Its phases
// are the ORDERED phases of the project's RM project type (or its plan's), with
// RM titles — fr holds no spine.
//
// ⭐ WHAT THIS SUITE IS ACTUALLY DEFENDING. RM owns the phase and n8n is its only
// writer (George 2026-10-13); fr creates the pm_project with NO phase. A project
// n8n has not started reads phase NULL, and the rail must show exactly that:
// every node pending, none done or active — no highlighted node a reader could
// parse as "1 of N" progress on a project where nothing has happened.

import { test, expect, describe } from 'bun:test';

import { deriveLifecycleRail } from '../../../../src/services/cockpit/project-cockpit';
import { PhasePlanSchema } from '../../../../src/lib/phase-plan';
import { nextGate, railNodes, type PhaseSpec } from '../../../../src/lib/project-phase';

const PHASES: PhaseSpec[] = [
  { name: 'intake', title: 'Intake', has_gate: false },
  { name: 'contract', title: 'Contract', has_gate: true },
  { name: 'build', title: 'Build', has_gate: false },
  { name: 'close', title: 'Close', has_gate: false },
];
const type = { kind: 'type' as const, phases: PHASES };

describe('deriveLifecycleRail — the never-advanced state', () => {
  test('phase NULL (not started) is AVAILABLE with EVERY node pending and next_gate from the start', () => {
    const b = deriveLifecycleRail(null, null, type);
    expect(b.meta.available).toBe(true);
    const rail = b.data!;
    expect(rail.phase).toBeNull();
    expect(rail.phase_updated_at).toBeNull();
    expect(rail.nodes.map((n) => n.state)).toEqual(['upcoming', 'gate', 'upcoming', 'upcoming']);
    expect(rail.nodes.some((n) => n.state === 'done' || n.state === 'active')).toBe(false);
    expect(rail.next_gate).toBe('contract');
  });

  test('a not-started PLAN rail is the same: every plan node pending', () => {
    const plan = PhasePlanSchema.parse({
      template_id: 't',
      template_hash: 'h',
      phases: ['a', 'b'],
      gates: { b: ['ready_signoff'] },
    });
    const b = deriveLifecycleRail(null, null, { kind: 'plan', plan, labels: new Map() });
    expect(b.meta.available).toBe(true);
    expect(b.data!.nodes.map((n) => n.state)).toEqual(['upcoming', 'gate']);
    expect(b.data!.next_gate).toBe('b');
  });

  test("a phase OUTSIDE the type's phases is withheld (data_gap), never clamped", () => {
    // e.g. the legacy column default 'request' on a type that has no such phase.
    for (const p of ['request', 'continuous', 'not_a_phase']) {
      const b = deriveLifecycleRail(p, '2026-09-20T10:00:00.000Z', type);
      expect(b.meta.available).toBe(false);
      expect(b.meta.unavailable_kind).toBe('data_gap');
      expect(b.data).toBeNull();
    }
  });
});

describe('deriveLifecycleRail — a genuinely recorded phase', () => {
  test('projects done/active nodes with RM titles and the real next gate', () => {
    const b = deriveLifecycleRail('build', new Date('2026-09-20T10:00:00.000Z'), type);
    expect(b.meta.available).toBe(true);
    const rail = b.data!;
    expect(rail.phase).toBe('build');
    expect(rail.phase_updated_at).toBe('2026-09-20T10:00:00.000Z');
    expect(rail.nodes.map((n) => [n.phase, n.label, n.state])).toEqual([
      ['intake', 'Intake', 'done'],
      ['contract', 'Contract', 'done'],
      ['build', 'Build', 'active'],
      ['close', 'Close', 'upcoming'],
    ]);
    // ONE projection for the cockpit and GET /api/projects/:id/phase.
    expect(rail.next_gate).toBe(nextGate(PHASES, 'build'));
    expect(rail.nodes).toEqual(railNodes(PHASES, 'build')!);
    expect(rail.plan).toBeNull();
  });

  test('a phase past the first with NO stamp still renders, stamp reported as null', () => {
    const b = deriveLifecycleRail('contract', null, type);
    expect(b.meta.available).toBe(true);
    expect(b.data!.phase_updated_at).toBeNull();
  });

  test('a first phase RM holds renders active — it was SET by n8n, an observation', () => {
    const b = deriveLifecycleRail('intake', '2026-09-20T10:00:00.000Z', type);
    expect(b.meta.available).toBe(true);
    expect(b.data!.nodes[0]!.state).toBe('active');
  });

  test('the phase list could not be read (e.g. catalogue_not_initialised) ⇒ UNAVAILABLE with the reason', () => {
    const b = deriveLifecycleRail('build', '2026-09-20T10:00:00.000Z', {
      kind: 'unresolvable',
      reason: 'catalogue_not_initialised: the PM catalogue of tenant t is not initialised',
    });
    expect(b.meta.available).toBe(false);
    expect(b.meta.error).toContain('catalogue_not_initialised');
    expect(b.data ?? null).toBeNull();
  });
});

// fr#1482 — a PLAN project's rail is its plan's phases, server-projected.
describe('deriveLifecycleRail — plan projects (fr#1482)', () => {
  const plan = PhasePlanSchema.parse({
    template_id: 'it.bug_hunt',
    template_hash: 'h',
    phases: ['deep_analysis', 'feature_development', 'closure'],
    gates: { deep_analysis: ['ready_signoff', 'bug_fix_authorization'] },
  });
  const labels = new Map([
    ['deep_analysis', 'Deep analysis (RM)'],
    ['feature_development', 'Build (RM)'],
  ]);

  test('nodes = the plan phases only, labelled with RM titles, plan coordinates carried', () => {
    const b = deriveLifecycleRail('feature_development', '2026-10-09T10:00:00.000Z', { kind: 'plan', plan, labels });
    expect(b.meta.available).toBe(true);
    expect(b.data!.nodes.map((n) => [n.phase, n.label, n.state, n.isGate])).toEqual([
      ['deep_analysis', 'Deep analysis (RM)', 'done', true],
      ['feature_development', 'Build (RM)', 'active', false],
      // no RM title for this one ⇒ its name, never an fr label
      ['closure', 'closure', 'upcoming', false],
    ]);
    expect(b.data!.next_gate).toBeNull();
    expect(b.data!.plan).toEqual({ template_id: 'it.bug_hunt', template_hash: 'h' });
  });

  test('an unresolvable plan is UNAVAILABLE data_gap', () => {
    const b = deriveLifecycleRail('deep_analysis', '2026-10-09T10:00:00.000Z', { kind: 'unresolvable', reason: 'outline_not_found' });
    expect(b.meta.available).toBe(false);
    expect(b.data ?? null).toBeNull();
  });

  test('a phase outside the plan is UNAVAILABLE (no invented position)', () => {
    const b = deriveLifecycleRail('contract', '2026-10-09T10:00:00.000Z', { kind: 'plan', plan, labels });
    expect(b.meta.available).toBe(false);
  });
});
