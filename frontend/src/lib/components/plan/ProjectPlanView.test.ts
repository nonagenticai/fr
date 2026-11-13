// @vitest-environment jsdom
//
// ProjectPlanView (fr#1483) — renders the SERVER's plan facts, nothing else.
//
// MUTATIONS WATCHED before this file was kept (each turns a case below red):
//   · render the 11-phase spine (PROJECT_PHASE_SPINE) instead of plan.phases
//     → "exactly 3 phases" and the no-projection source pin go red;
//   · drop the gate marker → "A1 gate marker" goes red;
//   · treat a legacy response as an empty plan → "legacy, no plan" goes red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ProjectPlanView from './ProjectPlanView.svelte';
import type { ProjectPlanLive, ProjectPlanLegacy, PlanDeliverableFact, ProposedPlanView } from '$lib/types/plan';
import type { ProjectPhaseName } from '$lib/types/cockpit';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host.remove();
});

const deliv = (id: string, phase: ProjectPhaseName, card: string, cardinality: string, deferred: boolean, cards: number, done: number): PlanDeliverableFact => ({
  plan_deliverable_id: id,
  phase,
  card_types: [card],
  cardinality,
  minter: deferred ? 'minter' : 'commit',
  deliverable_id: `row-${id}`,
  title: `${id} title`,
  deferred,
  minted_at: null,
  minted_count: null,
  cards: { total: cards, done, by_list: cards ? { TODO: cards - done, ...(done ? { DONE: done } : {}) } : {} },
  complete: false,
  incomplete_reason: deferred ? 'minter_not_fired' : 'card_not_done',
});

/** The it.bug_hunt plan at start, exactly as GET /api/projects/:id/plan returns it. */
const BUG_HUNT_LIVE: ProjectPlanLive = {
  project_id: 'p1',
  legacy: false,
  template: { id: 'it.bug_hunt', hash: 'a'.repeat(64) },
  outline_id: 'o1',
  phase_plan_hash: 'b'.repeat(64),
  current_phase: 'deep_analysis',
  phase_updated_at: '2026-10-09T10:00:00.000Z',
  facts: { size_class: 'S', repo_count: 1, risk_flags: null, optional_phases: null },
  phases: [
    {
      phase: 'deep_analysis', label: 'Deep analysis', index: 0, state: 'active',
      gate: { kinds: ['ready_signoff', 'bug_fix_authorization'], satisfied: false, approval_ids: [], unknown_kinds: [] },
      deliverables: [deliv('d1_bug_report', 'deep_analysis', 'bug_analysis', 'fixed:1', false, 1, 0)],
      exit_ready: false,
      blockers: ['deliverable d1_bug_report: card_not_done', 'gate not approved: ready_signoff + bug_fix_authorization'],
      next_phase: 'feature_development',
    },
    {
      phase: 'feature_development', label: 'Feature development', index: 1, state: 'upcoming', gate: null,
      deliverables: [deliv('d2_fixes_pr', 'feature_development', 'development_bug_fix', 'per_approved_bug', true, 0, 0)],
      exit_ready: false, blockers: ['deliverable d2_fixes_pr: minter_not_fired'], next_phase: 'closure',
    },
    {
      phase: 'closure', label: 'Closure', index: 2, state: 'upcoming', gate: null,
      deliverables: [deliv('d3_closure', 'closure', 'project_closure', 'at_phase_exit', true, 0, 0)],
      exit_ready: false, blockers: ['deliverable d3_closure: minter_not_fired', 'final_phase'], next_phase: null,
    },
  ],
};

describe('ProjectPlanView mode=live', () => {
  it('bug-hunt plan: exactly 3 phases, the A1 gate marker, 3 deliverables, current phase highlighted', () => {
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: BUG_HUNT_LIVE } });
    const phases = [...host.querySelectorAll('[data-testid="plan-phase"]')];
    expect(phases.map((p) => p.getAttribute('data-phase'))).toEqual(['deep_analysis', 'feature_development', 'closure']);
    const gates = host.querySelectorAll('[data-testid="plan-gate"]');
    expect(gates).toHaveLength(1);
    expect(gates[0]!.textContent).toContain('ready_signoff + bug_fix_authorization');
    expect(gates[0]!.getAttribute('data-satisfied')).toBe('false');
    expect(phases[0]!.contains(gates[0]!)).toBe(true);
    expect(host.querySelectorAll('[data-testid="plan-deliverable"]')).toHaveLength(3);
    const current = host.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('data-phase')).toBe('deep_analysis');
    expect(host.querySelector('[data-testid="plan-fact-template"]')!.textContent).toContain('it.bug_hunt@');
    expect(host.querySelector('[data-testid="plan-phase-blockers"]')!.textContent).toContain('gate not approved');
  });

  it('legacy project: "legacy, no plan", and no phase list at all', () => {
    const legacy: ProjectPlanLegacy = { project_id: 'p2', legacy: true, reason: 'legacy, no plan' };
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: legacy } });
    expect(host.querySelector('[data-testid="plan-legacy"]')!.textContent).toMatch(/legacy, no plan/i);
    expect(host.querySelectorAll('[data-testid="plan-phase"]')).toHaveLength(0);
  });
});

describe('no client-side projection (CONVEYOR-TAXONOMY D8)', () => {
  it('the plan components never import the spine or a card-type→phase map', () => {
    for (const f of ['ProjectPlanView.svelte', 'PlanFactsPanel.svelte', 'ConveyorPlanView.svelte']) {
      // Code only: comments may NAME the banned module to explain the ban.
      const src = readFileSync(join(__dirname, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
      expect(src).not.toMatch(/PROJECT_PHASE_SPINE|cards\/projectPhase|MACRO_PHASE_/);
    }
  });
});

// fr#1484 — proposed mode on the request page.
// MUTATION WATCHED: render a "checks passed" line when checks is null →
// "checks pending" RED; compute the count client-side from card types →
// the count case RED (it pins the SERVER's number, 1, not a re-derivation).
describe('ProjectPlanView mode=proposed', () => {
  const proposed: ProposedPlanView = {
    template: { id: 'it.bug_hunt', hash: 'a'.repeat(64) },
    phase_plan_hash: 'b'.repeat(64),
    card_count_at_commit: 1,
    deliverable_count: 3,
    checks: null,
    phases: [
      { phase: 'deep_analysis', label: 'Deep analysis', gate_kinds: ['ready_signoff', 'bug_fix_authorization'],
        deliverables: [{ plan_deliverable_id: 'd1', card_types: ['bug_analysis'], cardinality: 'fixed:1', minter: 'commit', cards_at_commit: 1 }] },
      { phase: 'feature_development', label: 'Feature development', gate_kinds: [],
        deliverables: [{ plan_deliverable_id: 'd2', card_types: ['development_bug_fix'], cardinality: 'per_approved_bug', minter: 'f', cards_at_commit: 0 }] },
      { phase: 'closure', label: 'Closure', gate_kinds: [],
        deliverables: [{ plan_deliverable_id: 'd3', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'p', cards_at_commit: 0 }] },
    ],
  };

  it('shows the 3 phases, the A1 gate, the AT6 card count (1 of 3 deliverables) and "checks pending"', () => {
    app = mount(ProjectPlanView, { target: host, props: { mode: 'proposed', proposed } });
    expect([...host.querySelectorAll('[data-testid="plan-phase"]')].map((p) => p.getAttribute('data-phase'))).toEqual([
      'deep_analysis', 'feature_development', 'closure',
    ]);
    expect(host.querySelectorAll('[data-testid="plan-gate"]')).toHaveLength(1);
    const count = host.querySelector('[data-testid="plan-card-count"]')!.textContent!.replace(/\s+/g, ' ');
    expect(count).toContain('3 deliverables');
    expect(count).toContain('mints 1 card now');
    expect(host.querySelector('[data-testid="plan-checks-pending"]')!.textContent).toContain('Plan checks pending');
    expect(host.querySelector('[data-testid="plan-checks"]')).toBeNull();
    expect([...host.querySelectorAll('[data-testid="plan-deliverable-at-commit"]')].map((e) => e.textContent)).toEqual([
      '1 at approval', 'minted later', 'minted later',
    ]);
  });

  it('a plan with no deliverables says the count is not stated (never 0)', () => {
    app = mount(ProjectPlanView, {
      target: host,
      props: { mode: 'proposed', proposed: { ...proposed, card_count_at_commit: null, deliverable_count: null } },
    });
    expect(host.querySelector('[data-testid="plan-card-count"]')!.textContent).toContain('not stated');
  });
});
