// @vitest-environment jsdom
//
// KagDiagnosticsStrip — the retrieval-pipeline diagnostics <dl> renders every
// stat the diagnostics carry, and renders NOTHING when there are no stats.
// Mirrors the KagAskSearchTab test harness: raw Svelte mount/unmount, no
// @testing-library.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import KagDiagnosticsStrip from './KagDiagnosticsStrip.svelte';

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

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

const q = (t: string) => host.querySelector(`[data-testid="${t}"]`);

describe('KagDiagnosticsStrip', () => {
  it('renders every stat present in the diagnostics', async () => {
    app = mount(KagDiagnosticsStrip, {
      target: host,
      props: {
        mode: 'hybrid_rerank',
        diagnostics: {
          dense_count: 42,
          lexical_count: 18,
          fused_count: 50,
          survivor_count: 8,
          top_score: 0.87,
        },
      },
    });
    await flushAsync();
    const strip = q('kag-ask-diagnostics')?.textContent ?? '';
    expect(q('kag-ask-diagnostics')).not.toBeNull();
    expect(strip).toContain('Dense');
    expect(strip).toContain('42');
    expect(strip).toContain('Lexical');
    expect(strip).toContain('18');
    expect(strip).toContain('Fused');
    expect(strip).toContain('50');
    expect(strip).toContain('Survivors');
    expect(strip).toContain('8');
    expect(strip).toContain('Best match');
    expect(strip).toContain('87%');
  });

  // A degraded rerank hop means there is no comparable score to show at all: an
  // RRF fusion score printed as a percentage reads "2%", i.e. "nothing matched".
  // The reader has to see the withheld value AND the cause in the strip itself,
  // not just in the returned stats array.
  it('shows the reranker degradation in the rendered strip', async () => {
    app = mount(KagDiagnosticsStrip, {
      target: host,
      props: {
        mode: 'hybrid_rerank',
        diagnostics: {
          dense_count: 50,
          lexical_count: 50,
          fused_count: 50,
          survivor_count: 8,
          top_score: 1,
          rerank_degraded: true,
          rerank_degraded_reason: 'timeout',
        },
      },
    });
    await flushAsync();
    const strip = q('kag-ask-diagnostics')?.textContent ?? '';
    expect(strip).toContain('Reranker');
    expect(strip).toContain('timeout');
    expect(strip).toContain('unavailable');
    // The whole point: no percentage anywhere in a degraded strip.
    expect(strip).not.toContain('%');
  });

  it('does not mention the reranker when retrieval was healthy', async () => {
    app = mount(KagDiagnosticsStrip, {
      target: host,
      props: {
        mode: 'hybrid_rerank',
        diagnostics: { fused_count: 50, survivor_count: 8, top_score: 0.87 },
      },
    });
    await flushAsync();
    const strip = q('kag-ask-diagnostics')?.textContent ?? '';
    expect(strip).toContain('Best match');
    expect(strip).not.toContain('Reranker');
  });

  // The strip is rendered once per column in the Compare grid, so `dense` and
  // `hybrid` — which have no cross-encoder hop and therefore never set
  // `rerank_degraded` — used to print an RRF fusion score as "2%" under the same
  // "Best match" label as full's cross-encoder "96%".
  it('withholds the best-match percentage for a mode that never reranks', async () => {
    app = mount(KagDiagnosticsStrip, {
      target: host,
      props: {
        mode: 'hybrid',
        diagnostics: { dense_count: 50, fused_count: 50, survivor_count: 8, top_score: 0.0213 },
      },
    });
    await flushAsync();
    const strip = q('kag-ask-diagnostics')?.textContent ?? '';
    expect(strip).toContain('Best match');
    expect(strip).toContain('fusion order, not scored');
    expect(strip).not.toContain('%');
    // Nothing degraded: there was never a hop to fail.
    expect(strip).not.toContain('Reranker');
  });

  it('renders nothing when diagnostics are absent', async () => {
    app = mount(KagDiagnosticsStrip, {
      target: host,
      props: { mode: 'hybrid_rerank', diagnostics: undefined },
    });
    await flushAsync();
    expect(q('kag-ask-diagnostics')).toBeNull();
  });
});
