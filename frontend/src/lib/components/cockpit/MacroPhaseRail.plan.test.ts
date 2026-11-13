// @vitest-environment jsdom
//
// MacroPhaseRail on a PLAN project (fr#1483): it renders ONLY the nodes the
// server projected from the plan — never the spine — and marks the exit gate.
//
// MUTATION WATCHED: render PROJECT_PHASE_SPINE (11 nodes) when `rail.plan` is
// set → "exactly the 3 plan phases" goes red; drop the gate-kinds span → the
// A1 marker case goes red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MacroPhaseRail from './MacroPhaseRail.svelte';
import type { Panel } from '$lib/types/panel';
import type { LifecycleRail } from '$lib/types/cockpit';

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

function planBlock(): Panel<LifecycleRail> {
  return {
    data: {
      phase: 'deep_analysis',
      phase_updated_at: '2026-10-09T10:00:00.000Z',
      next_gate: 'deep_analysis',
      plan: { template_id: 'it.bug_hunt', template_hash: 'a'.repeat(64) },
      nodes: [
        { phase: 'deep_analysis', label: 'Deep analysis', state: 'active', isGate: true, gate_kinds: ['ready_signoff', 'bug_fix_authorization'] },
        { phase: 'feature_development', label: 'Feature development', state: 'upcoming', isGate: false },
        { phase: 'closure', label: 'Closure', state: 'upcoming', isGate: false },
      ],
    },
    as_of: '2026-10-09T10:00:00.000Z', health: 'ok' as const,
  };
}

describe('MacroPhaseRail — plan project', () => {
  it('renders exactly the 3 plan phases, the A1 exit-gate marker and the plan badge', () => {
    app = mount(MacroPhaseRail, { target: host, props: { rail: planBlock(), projectId: 'p1' } });
    flushSync();
    const nodes = [...host.querySelectorAll('[data-testid="macro-phase-node"]')];
    expect(nodes.map((n) => n.getAttribute('data-phase'))).toEqual(['deep_analysis', 'feature_development', 'closure']);
    expect(host.querySelector('[data-testid="macro-phase-gate-kinds"]')!.textContent).toContain('ready_signoff + bug_fix_authorization');
    expect(host.querySelector('[data-testid="macro-phase-plan"]')!.textContent).toContain('it.bug_hunt');
    expect(host.querySelector('[data-testid="macro-phase-next-gate"]')!.textContent).toContain('at the exit of deep_analysis');
    // No contract sign-off affordance on a plan project.
    expect(host.querySelector('[data-testid="macro-phase-gate-request"]')).toBeNull();
  });

  it('no client-side projection: the rail never imports the spine', () => {
    const src = readFileSync(join(__dirname, 'MacroPhaseRail.svelte'), 'utf8').replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    expect(src).not.toMatch(/PROJECT_PHASE_SPINE|railNodes\(/);
  });
});
