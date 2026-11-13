// @vitest-environment jsdom
//
// selection-cleared.svelte.test.ts
//
// Class regression: a drawer/inspector whose selected item is cleared (close,
// route teardown) while it is still mounted. Svelte 5 can re-run the child's
// deriveds/template with the cleared (undefined/null) prop before the parent's
// `{#if}` removes it, and a bare `card.x` / `project.x` then throws
// "Cannot read properties of undefined". `.svelte.test.ts` so `$state` props
// are reactive: mount with a value, clear it, flush — must not throw.

import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CurrentCardEvidenceDrawer from './cockpit/CurrentCardEvidenceDrawer.svelte';
import type { CockpitCard, TimelineEvent } from '$lib/types/cockpit';

let host: HTMLElement | null = null;
let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
  host = null;
});

function target(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

const card: CockpitCard = {
  id: 'card-1',
  name: 'Wire the intake router',
  phase: 'DOING',
  list_name: 'Doing',
  labels: ['intake'],
  age_in_phase_ms: 60_000,
  updated_at: '2026-10-01T00:00:00Z',
  blocked: false,
  blocked_reason: null,
};

const events: TimelineEvent[] = [
  {
    id: 'ev-1',
    type: 'phase_transition',
    at: '2026-10-01T00:00:00Z',
    title: 'Moved to Doing',
    card_id: 'card-1',
    execution_id: null,
    correlation_id: null,
    status: null,
    pills: [],
  },
];

describe('cleared selection does not crash the still-mounted child', () => {
  it('CurrentCardEvidenceDrawer: card → undefined', () => {
    const props = $state<{ card: CockpitCard | undefined; events: TimelineEvent[] }>({
      card,
      events,
    });
    const el = target();
    app = mount(CurrentCardEvidenceDrawer, { target: el, props });
    flushSync();
    expect(el.textContent).toContain('Wire the intake router');
    expect(el.textContent).toContain('Moved to Doing');
    expect(el.textContent).toContain('intake');

    expect(() => {
      props.card = undefined;
      flushSync();
    }).not.toThrow();
    expect(el.textContent).not.toContain('Moved to Doing');
  });
});
