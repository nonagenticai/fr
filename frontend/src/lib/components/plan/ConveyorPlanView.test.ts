// @vitest-environment jsdom
//
// ConveyorPlanView (FR-PROJECT-PAGE-CONVEYOR G1) — the conveyor plan as the
// server returns it for proof run 7 (RM closed, 3 phases, 9 DONE cards, 2
// capabilities, risks). Rendered through
// ProjectPlanView, the component the /plan route mounts.
//
// MUTATIONS WATCHED (each turns a case red):
//   · ProjectPlanView: route kind:'conveyor' to the legacy branch → "not legacy" red;
//   · render cap.reason as the visible line → "purpose visible, rationale behind Why" red;
//   · render an unavailable section as an empty list → "unavailable: <reason>" red;
//   · drop withoutRuleRefs → "no rule numbers" red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import ProjectPlanView from './ProjectPlanView.svelte';
import type { ConveyorPlanAvailable, ConveyorPlanCard } from '$lib/types/plan';
import { withoutRuleRefs, unavailableReason } from '$lib/utils/planCopy';

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

const card = (id: string, name: string, type: string, title: string): ConveyorPlanCard => ({
  id,
  name,
  card_type: type,
  card_type_title: title,
  list: 'DONE',
  last_moved_at: '2026-10-25T08:00:00.000Z',
  placed_by: 'card_phase',
});

function run7(): ConveyorPlanAvailable {
  return {
    project_id: '0ad49b9c-5a67-4a26-9fe6-8d24dc61779e',
    legacy: false,
    kind: 'conveyor',
    available: true,
    project_type: { id: 'pt', name: 'it' },
    status: 'closed',
    closed: true,
    current_phase: 'execution',
    phase_updated_at: '2026-10-25T08:19:19.411Z',
    phases: {
      available: true,
      items: [
        {
          name: 'setup', title: 'Setup', position: 0, has_gate: false, state: 'done',
          entered_at: '2026-10-25T07:02:59.413Z', left_at: '2026-10-25T07:44:22.158Z',
          cards: [card('c1', 'Project start request analysis', 'project_start_request_analysis', 'Project start request analysis'), card('c2', 'project setup', 'project_setup', 'Project setup')],
        },
        {
          name: 'preliminary', title: 'Preliminary', position: 1, has_gate: true, state: 'done',
          entered_at: '2026-10-25T07:44:22.158Z', left_at: '2026-10-25T08:19:19.411Z',
          cards: [
            card('c3', 'start preliminary phase', 'project_phase_start', 'Project phase start'),
            card('c4', 'confirm F4 total_value gap', 'bug_analysis', 'Bug analysis'),
            card('c5', 'Close preliminary phase', 'project_phase_closure', 'Project phase closure'),
          ],
        },
        {
          name: 'execution', title: 'Execution', position: 2, has_gate: true, state: 'done',
          entered_at: '2026-10-25T08:19:19.411Z', left_at: null,
          cards: [
            card('c6', 'start execution phase', 'project_phase_start', 'Project phase start'),
            card('c7', 'add Inventory.total_value (F4)', 'development_feature_new', 'Development feature new'),
            card('c8', 'Close execution phase', 'project_phase_closure', 'Project phase closure'),
            card('c9', 'project closure', 'project_closure', 'Project closure'),
          ],
        },
      ],
    },
    phase_history: { available: true },
    cards: { available: true, unplaced: [] },
    capabilities: {
      available: true,
      selected: [
        {
          name: 'analysis', title: 'Analysis', involvement: 'light', rigor: 'medium', complexity: 'low',
          purpose: 'Produce the bug_analysis card that confirms the F4 gap before the bug fix is implemented, satisfying the R300 rule that a bug fix needs bug_analysis first.',
          reason: "The earlier rework block (contradiction: development_requires_analysis, R300) requires a bug_analysis card first, so I include analysis despite the consult's 'none' involvement.",
          order_after: [], selected_at: '2026-10-25T07:44:19.421Z',
        },
        {
          name: 'development', title: 'Development', involvement: 'standard', rigor: 'medium', complexity: 'medium',
          purpose: 'Implement Inventory.total_value(category=None) per BRIEF.md F4, add tests, and deliver them as a pull request.',
          reason: 'I include it with after=[analysis] because the R300 rule requires the bug_analysis card to complete first.',
          order_after: ['analysis'], selected_at: '2026-10-25T07:44:19.421Z',
        },
      ],
    },
    risks: {
      available: true,
      items: [
        { id: 'r1', title: 'Rounding differs from the acceptance examples', description: null, status: 'identified', category: 'technical', probability: 0.3, impact_score: 3, risk_score: 0.9, response_strategy: 'mitigate', response_plan: 'test every example', },
      ],
    },
  };
}

const text = (sel: string) => [...host.querySelectorAll(sel)].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());

describe('ConveyorPlanView (via ProjectPlanView)', () => {
  it('a conveyor plan is not "legacy, no plan": closed status, 3 phases in order with dates, 9 cards', () => {
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: run7() } });
    expect(host.querySelector('[data-testid="plan-legacy"]')).toBeNull();
    expect(host.querySelector('[data-testid="conveyor-plan-status"]')!.textContent).toContain('Closed');
    const phases = [...host.querySelectorAll('[data-testid="conveyor-phase"]')];
    expect(phases.map((p) => p.getAttribute('data-phase'))).toEqual(['setup', 'preliminary', 'execution']);
    expect(phases.map((p) => p.getAttribute('data-state'))).toEqual(['done', 'done', 'done']);
    expect(host.querySelectorAll('[data-testid="conveyor-card"]')).toHaveLength(9);
    expect(text('[data-testid="conveyor-card-list"]').every((t) => t === 'Done')).toBe(true);
    expect(text('[data-testid="conveyor-phase-dates"]')[2]).toMatch(/^Entered /);
    expect(text('[data-testid="conveyor-phase-dates"]')[0]).toContain('left');
    expect(phases[1]!.textContent).toContain('Bug analysis');
  });

  it('capabilities: purpose is the visible line, the rationale sits behind a closed "Why"', () => {
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: run7() } });
    const caps = [...host.querySelectorAll('[data-testid="conveyor-capability"]')];
    expect(caps).toHaveLength(2);
    expect(caps[1]!.querySelector('[data-testid="conveyor-capability-purpose"]')!.textContent).toContain('Inventory.total_value');
    const why = caps[1]!.querySelector('details[data-testid="conveyor-capability-why"]') as HTMLDetailsElement;
    expect(why.open).toBe(false);
    expect(why.querySelector('summary')!.textContent).toBe('Why');
    expect(caps[1]!.querySelector('[data-testid="conveyor-capability-after"]')!.textContent).toContain('after Analysis');
    expect(caps[0]!.textContent).toContain('involvement light');
  });

  it('no rule numbers reach the user', () => {
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: run7() } });
    expect(host.textContent).not.toMatch(/\bR\d{2,}\b/);
    expect(host.querySelector('[data-testid="conveyor-capability-purpose"]')!.textContent).toContain('satisfying the rule that');
  });

  it('risks render', () => {
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: run7() } });
    expect(text('[data-testid="conveyor-risk"]')[0]).toContain('likelihood 30% · impact 3/5');
  });

  it('a source that could not be read says "Unavailable: <reason>", never an empty list', () => {
    const p = run7();
    p.risks = { available: false, reason: 'UPSTREAM_UNREACHABLE' };
    p.cards = { available: false, reason: 'no_board' };
    p.capabilities = { available: false, reason: 'UPSTREAM_TIMEOUT' };
    if (p.phases.available) for (const ph of p.phases.items) ph.cards = [];
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: p } });
    expect(host.querySelector('[data-testid="conveyor-risks-unavailable"]')!.textContent).toContain('Unavailable: the planning service could not be reached');
    expect(host.querySelector('[data-testid="conveyor-risks-none"]')).toBeNull();
    expect(host.querySelector('[data-testid="conveyor-cards-unavailable"]')!.textContent).toContain('the project has no board');
    expect(host.querySelectorAll('[data-testid="conveyor-phase-no-cards"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="conveyor-capabilities-unavailable"]')).not.toBeNull();
  });

  it('the whole plan unavailable: an alert with the reason', () => {
    app = mount(ProjectPlanView, {
      target: host,
      props: { mode: 'live', plan: { project_id: 'p', legacy: false, kind: 'conveyor', available: false, reason: 'rm_project_missing' } },
    });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Plan unavailable: the project has no plan record');
    expect(host.querySelectorAll('[data-testid="conveyor-phase"]')).toHaveLength(0);
  });

  it('an open project marks its current phase', () => {
    const p = run7();
    p.closed = false;
    p.status = 'active';
    if (p.phases.available) p.phases.items[2]!.state = 'active';
    app = mount(ProjectPlanView, { target: host, props: { mode: 'live', plan: p } });
    expect(host.querySelector('[aria-current="step"]')!.getAttribute('data-phase')).toBe('execution');
    expect(host.querySelector('[data-testid="conveyor-plan-status"]')!.textContent).toContain('In Execution');
  });
});

describe('planCopy', () => {
  it('withoutRuleRefs strips rule references and keeps the sentence', () => {
    expect(withoutRuleRefs('a published findings report (bug_analysis, R163)')).toBe('a published findings report (bug_analysis)');
    expect(withoutRuleRefs('released after sign-off (R88, R92)')).toBe('released after sign-off');
    expect(withoutRuleRefs('the R300 rule (enforced by the flow) applies')).toBe('the rule (enforced by the flow) applies');
    expect(withoutRuleRefs(null)).toBe('');
  });
  it('unavailableReason humanizes unknown codes rather than hiding them', () => {
    expect(unavailableReason('some_new_code')).toBe('some new code');
    expect(unavailableReason('')).toBe('unknown reason');
  });
});
