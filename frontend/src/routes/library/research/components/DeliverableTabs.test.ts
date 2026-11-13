// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet } from 'svelte';
import DeliverableTabs from './DeliverableTabs.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

function snip(text: string) {
  return createRawSnippet(() => ({
    render: () => `<div>${text}</div>`,
  }));
}

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});
const q = (t: string) => host.querySelector(`[data-testid="${t}"]`);

describe('DeliverableTabs', () => {
  it('shows the Answer panel by default and switches tabs on click', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    app = mount(DeliverableTabs, {
      target: host,
      props: {
        answer: snip('ANSWER'),
        review: snip('REVIEW'),
        ledger: snip('LEDGER'),
        corpus: snip('CORPUS'),
        graph: snip('GRAPH'),
        synthesis: snip('SYNTHESIS'),
      },
    });
    flushSync();
    expect(q('deliverable-panel')?.textContent).toContain('ANSWER');
    (q('deliverable-tab-ledger') as HTMLButtonElement).click();
    flushSync();
    expect(q('deliverable-panel')?.textContent).toContain('LEDGER');
    (q('deliverable-tab-corpus') as HTMLButtonElement).click();
    flushSync();
    expect(q('deliverable-panel')?.textContent).toContain('CORPUS');
    (q('deliverable-tab-graph') as HTMLButtonElement).click();
    flushSync();
    expect(q('deliverable-panel')?.textContent).toContain('GRAPH');
    (q('deliverable-tab-synthesis') as HTMLButtonElement).click();
    flushSync();
    expect(q('deliverable-panel')?.textContent).toContain('SYNTHESIS');
  });
});
