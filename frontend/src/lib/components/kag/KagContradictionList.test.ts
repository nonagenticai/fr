// @vitest-environment jsdom
//
// KagContradictionList renders `topology/contradictions` pairs as a compact
// disclosure list. Members of supporting/refuting may arrive as raw ids
// (string) or node objects — the label guard must tolerate both and never
// throw. Score colour is token-driven (success/danger/muted). Mirrors the
// KagNodeCard mount/flushSync test pattern.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import KagContradictionList from './KagContradictionList.svelte';
import type { ContradictionPair } from '$lib/api/research';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(pairs: ContradictionPair[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(KagContradictionList, { target: host, props: { pairs } });
  flushSync();
  return host;
}

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});

describe('KagContradictionList', () => {
  it('renders object members: label, supporting/refuting names, and a positive score', () => {
    const el = render([
      {
        target_label: 'Claim X',
        net_support_score: 0.7,
        // `properties.text` is where nodeLabelOf reads an entity's name.
        supporting_nodes: [{ id: 'n1', properties: { text: 'Study A' } }],
        // top-level `label` is a fallback name for nodeLabelOf.
        refuting_nodes: [{ label: 'Study B' }],
      },
    ]);
    const txt = el.textContent ?? '';
    expect(txt).toContain('Claim X');
    expect(txt).toContain('Study A');
    expect(txt).toContain('Study B');
    expect(txt).toContain('0.70');
    const score = Array.from(el.querySelectorAll('span')).find(
      (s) => s.textContent === '0.70',
    );
    expect(score?.className).toContain('success-text');
  });

  it('tolerates raw string members without throwing', () => {
    const el = render([{ target_id: 't1', supporting_nodes: ['raw string'] }]);
    expect(el.textContent).toContain('raw string');
  });

  it('colours a negative net_support_score with the danger token', () => {
    const el = render([{ target_label: 'Y', net_support_score: -0.5 }]);
    const score = Array.from(el.querySelectorAll('span')).find(
      (s) => s.textContent === '-0.50',
    );
    expect(score?.className).toContain('danger-text');
  });

  it('renders one item per pair', () => {
    const el = render([
      { target_label: 'A' },
      { target_label: 'B' },
    ]);
    expect(el.querySelectorAll('[data-testid="kag-contradiction-item"]').length).toBe(2);
  });
});
