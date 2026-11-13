// @vitest-environment jsdom
//
// KagCallInspector (P3-D4) — the "Copy as API / n8n" disclosure. Asserts it shows
// the method/path/body + curl, maps a search call to the real n8n operation, and
// is honest that a RAG ask has no single node operation. No API mocks needed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import KagCallInspector from './KagCallInspector.svelte';

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
const q = (t: string) => host.querySelector(`[data-testid="${t}"]`);

describe('KagCallInspector', () => {
  it('shows the method, path, body and a curl for a search call + its n8n operation', () => {
    app = mount(KagCallInspector, {
      target: host,
      props: {
        call: { method: 'POST', path: '/api/assets/kag/search', body: { query_text: 'rag', limit: 10 } },
      },
    });
    flushSync();
    expect(q('kag-inspector-method')?.textContent).toBe('POST');
    expect(q('kag-inspector-path')?.textContent).toContain('/api/assets/kag/search');
    expect(q('kag-inspector-curl')?.textContent).toContain('curl -X POST');
    expect(q('kag-inspector-body')?.textContent).toContain('"query_text": "rag"');
    expect(q('kag-inspector-n8n-op')?.textContent).toBe('semanticSearch');
  });

  it('is honest that a RAG ask has no single n8n node operation', () => {
    app = mount(KagCallInspector, {
      target: host,
      props: {
        call: { method: 'POST', path: '/api/assets/kag/ask', body: { query: 'q', mode: 'hybrid_rerank' } },
      },
    });
    flushSync();
    expect(q('kag-inspector-n8n-none')).not.toBeNull();
    expect(q('kag-inspector-n8n-op')).toBeNull();
  });

  it('maps hierarchical retrieval to the hierarchicalRetrieval operation', () => {
    app = mount(KagCallInspector, {
      target: host,
      props: {
        call: { method: 'POST', path: '/api/assets/kag/hierarchical-retrieval', body: { query: 'q', topK: 15 } },
      },
    });
    flushSync();
    expect(q('kag-inspector-n8n-op')?.textContent).toBe('hierarchicalRetrieval');
  });
});
