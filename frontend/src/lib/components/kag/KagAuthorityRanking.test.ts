// @vitest-environment jsdom
//
// KagAuthorityRanking renders KAG's `top_entities[]` as a score-ranked list.
// Labels resolve via `nodeLabelOf`, which reads a node's caption from
// `properties.text` (among other aliases) — so the mocks below carry the label
// under `properties.text`. Items are sorted by score descending; unscored items
// render label-only (no numeric span). Mirrors the KagNodeCard mount pattern.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import KagAuthorityRanking from './KagAuthorityRanking.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(entities: Array<Record<string, unknown>>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(KagAuthorityRanking, { target: host, props: { entities } });
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

describe('KagAuthorityRanking', () => {
  it('labels via nodeLabelOf and ranks by score descending', () => {
    const el = render([
      { id: 'a', score: 0.3, properties: { text: 'Alpha' } },
      { id: 'b', score: 0.9, properties: { text: 'Beta' } },
    ]);
    const items = el.querySelectorAll('[data-testid="kag-authority-item"]');
    // Highest score first.
    expect(items[0].textContent).toContain('Beta');
    expect(items[0].textContent).toContain('0.900');
    // Both labels present.
    expect(el.textContent).toContain('Alpha');
    expect(el.textContent).toContain('Beta');
  });

  it('renders an unscored entity as label-only, no numeric score', () => {
    const el = render([{ id: 'c', properties: { text: 'Gamma' } }]);
    const item = el.querySelector('[data-testid="kag-authority-item"]')!;
    expect(item.textContent).toContain('Gamma');
    expect(item.querySelector('.font-mono')).toBeNull();
  });

  it('renders one item per entity', () => {
    const el = render([
      { id: 'a', score: 0.5, properties: { text: 'Alpha' } },
      { id: 'b', score: 0.1, properties: { text: 'Beta' } },
    ]);
    expect(el.querySelectorAll('[data-testid="kag-authority-item"]').length).toBe(2);
  });
});
