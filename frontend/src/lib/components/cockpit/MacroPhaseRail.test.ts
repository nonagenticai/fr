// @vitest-environment jsdom
//
// MacroPhaseRail — the ANTI-FAKE-PROGRESS suite.
//
// ⭐ THE FAILURE THIS FILE EXISTS TO PREVENT, stated as a shape rather than a
// sentence so it cannot be reintroduced by a rewording: nine grey outlines with
// node 1 highlighted reads as "1 of 9" — roughly 11% progress — on a project
// where `project_phase` is still its `DEFAULT 'request'` and
// `project_phase_updated_at` has never been stamped, i.e. where NOTHING has
// happened. The backend withholds the rail for that pair; this component must
// not put it back.
//
// So the unavailable branch is asserted by ABSENCE, over the rendered DOM:
//   · no text matching PROGRESS_FRACTION  — "1 of 9", "1/9", "1 / 9"
//   · no `[role=progressbar]`
//   · no percentage
//   · no rail nodes at all
// MUTATION WATCHED before this file was kept: render the nine nodes greyed in
// the unavailable branch → every absence assertion below goes RED.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MacroPhaseRail from './MacroPhaseRail.svelte';
import type { Panel } from '$lib/types/panel';
import type { LifecycleRail } from '$lib/types/cockpit';
import { PROGRESS_FRACTION } from './tests/progress-fraction';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host.remove();
});

/** The block the backend returns for an untouched project. */
function neverStartedBlock(): Panel<LifecycleRail> {
  return {
    data: null,
    as_of: '2026-09-23T09:00:00.000Z', health: 'ok' as const, detail_code: 'fr_db_no_data',
  };
}

function advancedBlock(): Panel<LifecycleRail> {
  return {
    data: {
      phase: 'deep_analysis',
      phase_updated_at: '2026-09-20T10:00:00.000Z',
      next_gate: null,
      nodes: [
        { phase: 'request', label: 'Request', state: 'done', isGate: false },
        { phase: 'preliminary_analysis', label: 'Preliminary analysis', state: 'done', isGate: false },
        { phase: 'contract', label: 'Contract', state: 'done', isGate: true },
        { phase: 'deep_analysis', label: 'Deep analysis', state: 'active', isGate: false },
        { phase: 'epic_design', label: 'Epic design', state: 'upcoming', isGate: false },
        { phase: 'enabler_architecture', label: 'Enabler architecture', state: 'upcoming', isGate: false },
        { phase: 'enabler_development', label: 'Enabler development', state: 'upcoming', isGate: false },
        { phase: 'feature_design', label: 'Feature design', state: 'upcoming', isGate: false },
        { phase: 'feature_development', label: 'Feature development', state: 'upcoming', isGate: false },
      ],
    },
    as_of: '2026-09-23T09:00:00.000Z', health: 'ok' as const,
  };
}

describe('MacroPhaseRail — the never-advanced state renders NO progress', () => {
  it('says it in plain words and nothing that implies a position', () => {
    app = mount(MacroPhaseRail, { target: host, props: { rail: neverStartedBlock() } });
    flushSync();

    const rail = host.querySelector('[data-testid="macro-phase-rail"]')!;
    expect(rail).toBeTruthy();

    // The honest sentence IS rendered — absence assertions alone would also pass
    // on a component that rendered nothing at all, which is a different bug.
    // (Plain words from the panel note — never the raw reason string.)
    expect(rail.querySelector('[data-testid="panel-note"]')).toBeTruthy();

    const text = rail.textContent ?? '';
    // ⛔ "1 of 9" / "1/9" / "1 / 9" — the fabricated fraction, in any spelling.
    expect(text).not.toMatch(PROGRESS_FRACTION);
    // ⛔ a percentage.
    expect(text).not.toMatch(/\d+\s*%/);
    // ⛔ a progress bar, semantic or otherwise.
    expect(rail.querySelector('[role=progressbar]')).toBeNull();
    expect(rail.querySelector('progress')).toBeNull();
    // ⛔ and no nodes at all — greyed nodes with node 1 active ARE the 11%.
    expect(rail.querySelectorAll('[data-testid="macro-phase-node"]').length).toBe(0);
    expect(rail.querySelector('[data-testid="macro-phase-nodes"]')).toBeNull();
    // ⛔ nor the "next gate" affordance, which implies a place on the spine.
    expect(rail.querySelector('[data-testid="macro-phase-next-gate"]')).toBeNull();
  });

  it('renders no nodes for ANY unavailable kind, not just no_data', () => {
    // A read that FAILED must not fall through to a rendered rail either.
    const errored: Panel<LifecycleRail> = {
      data: null,
      as_of: null, health: 'down' as const, detail_code: 'fr_db_error',
    };
    app = mount(MacroPhaseRail, { target: host, props: { rail: errored } });
    flushSync();
    expect(host.querySelectorAll('[data-testid="macro-phase-node"]').length).toBe(0);
    expect(host.textContent ?? '').not.toMatch(PROGRESS_FRACTION);
  });
});

describe('MacroPhaseRail — a genuinely recorded phase DOES render', () => {
  // The positive control: without this, the suite above would pass on a
  // component that renders nothing, ever.
  it('renders every node with its server-projected state', () => {
    const rail = advancedBlock();
    app = mount(MacroPhaseRail, { target: host, props: { rail } });
    flushSync();

    const nodes = [...host.querySelectorAll('[data-testid="macro-phase-node"]')];
    // Derived from the input rail, not a literal 9.
    expect(nodes).toHaveLength(rail.data!.nodes.length);
    expect(nodes[1]!.getAttribute('data-state')).toBe('done');
    expect(nodes[3]!.getAttribute('data-state')).toBe('active');
    expect(nodes[3]!.textContent).toContain('Deep analysis');
    // Still no fabricated fraction, even here — the rail shows states, not a score.
    expect(host.textContent ?? '').not.toMatch(PROGRESS_FRACTION);
  });
});
