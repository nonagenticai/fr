// @vitest-environment jsdom
//
// IngestionProgress stepper tests. Mounts the component in jsdom and asserts the
// stage rendering, the failed-state error, the DEGRADED (terminal-but-
// incomplete) terminal, and the operator details panel (tenant id) — the
// staged-progress UX + tenant-fragmentation diagnostic.
//
// Mirrors the svelte mount/unmount/flushSync pattern used across the kag tests
// (no @testing-library/svelte).

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import IngestionProgress from './IngestionProgress.svelte';
import type { IngestionProgress as IngestionProgressData } from '$lib/types/api';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(progress: IngestionProgressData | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(IngestionProgress, { target: host, props: { progress } });
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

const baseProgress = (over: Partial<IngestionProgressData> = {}): IngestionProgressData => ({
  stages: [
    { key: 'upload', label: 'Uploaded', state: 'done' },
    { key: 'parse', label: 'Parsed', state: 'done', detail: '12 pages' },
    { key: 'knowledge', label: 'Extracting knowledge', state: 'done', detail: '4,827 entities' },
    { key: 'hierarchy', label: 'Building hierarchy', state: 'active' },
    { key: 'index', label: 'Indexed', state: 'pending' },
  ],
  currentStageKey: 'hierarchy',
  percentComplete: 60,
  terminal: null,
  failedStageKey: null,
  errorMessage: null,
  // Required, not optional, on purpose: `null` means "degradation was never
  // evaluated", and every fixture has to say which of the two it is rather
  // than inheriting a default that reads as "clean".
  degradation: null,
  ids: { ingestionJobId: 'job-1', orchestratorJobId: 'orch-1', tenantId: 'tenant-xyz' },
  ...over,
});

/** The real prod numbers: 119 of 137 chunks lost, 18 indexed. */
const PROD_DEGRADATION = {
  degraded: true,
  reason: 'nlp_extraction_degraded: 119 of 137 chunks failed extraction',
  stage: 'knowledge' as const,
  chunksIndexed: 18,
  chunksFailed: 119,
  chunksTotal: 137,
};

/**
 * The terminal cap's state + its LABEL ONLY.
 *
 * Reading `li.textContent` would fold the ✓/○/⚠ glyph into the string and let a
 * `toContain('Ready')` pass on "Ready — partially indexed" — which is exactly
 * how the pre-existing stage test could not tell a green terminal from a
 * degraded one. The label lives in the last span.
 */
function readyCap(el: HTMLElement): { state: string | null; label: string } {
  const li = el.querySelector('[data-testid="ingestion-stage-ready"]');
  const spans = li?.querySelectorAll('span');
  return {
    state: li?.getAttribute('data-state') ?? null,
    label: (spans?.[spans.length - 1]?.textContent ?? '').trim(),
  };
}

/** The "Indexing usually takes a few minutes…" keep-waiting hint. */
function hasWaitHint(el: HTMLElement): boolean {
  return /usually takes a few minutes/i.test(el.textContent ?? '');
}

describe('IngestionProgress', () => {
  it('renders nothing when progress is null', () => {
    const el = render(null);
    expect(el.querySelector('[data-testid="ingestion-progress"]')).toBeNull();
  });

  it('renders each stage with its state + detail + percent', () => {
    const el = render(baseProgress());
    expect(el.querySelector('[data-testid="ingestion-progress"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ingestion-progress-pct"]')?.textContent).toContain('60%');
    expect(
      el.querySelector('[data-testid="ingestion-stage-knowledge"]')?.getAttribute('data-state'),
    ).toBe('done');
    expect(
      el.querySelector('[data-testid="ingestion-stage-hierarchy"]')?.getAttribute('data-state'),
    ).toBe('active');
    expect(el.textContent).toContain('4,827 entities');
    // TIGHTENED. This used to be `toContain('Ready')` on the whole component,
    // which a degraded render ("Ready — partially indexed") also satisfies —
    // so the three-way terminal cap could regress to a green Ready and this
    // test would stay green. Exact label + data-state is the assertion that
    // can actually distinguish the three outcomes.
    expect(readyCap(el)).toEqual({ state: 'pending', label: 'Ready' });
    // Still in flight → the keep-waiting hint is correct here, and its
    // presence is what makes its ABSENCE on a degraded terminal meaningful.
    expect(hasWaitHint(el)).toBe(true);
    // No degradation reported → no warning block anywhere.
    expect(el.querySelector('[data-testid="ingestion-degraded"]')).toBeNull();
  });

  it('a READY terminal caps green with the bare "Ready" label', () => {
    const el = render(baseProgress({ terminal: 'ready', percentComplete: 100 }));
    expect(readyCap(el)).toEqual({ state: 'done', label: 'Ready' });
    expect(el.querySelector('[data-testid="ingestion-degraded"]')).toBeNull();
  });

  it('shows the error on a failed terminal', () => {
    const el = render(
      baseProgress({
        terminal: 'failed',
        failedStageKey: 'knowledge',
        errorMessage: 'karma blew up',
        stages: [
          { key: 'upload', label: 'Uploaded', state: 'done' },
          { key: 'parse', label: 'Parsed', state: 'done' },
          { key: 'knowledge', label: 'Extracting knowledge', state: 'failed' },
        ],
      }),
    );
    expect(el.querySelector('[data-testid="ingestion-error"]')?.textContent).toContain(
      'karma blew up',
    );
  });

  // ── the DEGRADED terminal ────────────────────────────────────────────────
  //
  // karma PR #127 gave the pipeline partial credit: a job that lost 119 of 137
  // chunks now FINISHES. Before this, `terminal` was two-valued, so such a job
  // took the `!== 'failed'` branch and capped with the same green "Ready" a
  // fully-indexed document gets.

  it('a DEGRADED terminal caps warning-toned, never the green Ready', () => {
    const el = render(
      baseProgress({ terminal: 'degraded', percentComplete: 100, degradation: PROD_DEGRADATION }),
    );
    // The mutation this kills: collapsing the three-way cap back to
    // `terminal === 'ready' ? done : pending`, which renders a plain "Ready"
    // over a graph missing 86% of its chunks.
    expect(readyCap(el)).toEqual({ state: 'degraded', label: 'Ready — partially indexed' });
    expect(readyCap(el).label).not.toBe('Ready');
    // Warning, not danger: the document IS searchable, just not in full.
    expect(el.querySelector('[data-testid="ingestion-error"]')).toBeNull();
  });

  it('the "usually takes a few minutes" hint is ABSENT on a degraded terminal', () => {
    // Kills dropping `!isDegraded` from the hint guard. A finished-but-partial
    // job is not going to improve; telling the researcher to wait for "Ready"
    // both hides the loss and describes an event that will never happen.
    const el = render(
      baseProgress({ terminal: 'degraded', percentComplete: 100, degradation: PROD_DEGRADATION }),
    );
    expect(hasWaitHint(el)).toBe(false);
  });

  it('the degraded block carries the reason AND the real ratio (18 of 137)', () => {
    const el = render(
      baseProgress({ terminal: 'degraded', percentComplete: 100, degradation: PROD_DEGRADATION }),
    );
    const block = el.querySelector('[data-testid="ingestion-degraded"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('nlp_extraction_degraded');
    expect(block?.textContent).toContain('18 of 137 chunks indexed');
  });

  it('a degraded terminal with NO chunk total shows the reason and NO ratio', () => {
    // The no-fabrication rule at the stepper. Kills a mutant that derives a
    // denominator (e.g. falls back to chunksIndexed) when the backend sent none.
    const el = render(
      baseProgress({
        terminal: 'degraded',
        percentComplete: 100,
        degradation: {
          ...PROD_DEGRADATION,
          chunksIndexed: 18,
          chunksFailed: null,
          chunksTotal: null,
        },
      }),
    );
    const block = el.querySelector('[data-testid="ingestion-degraded"]');
    expect(block?.textContent).toContain('nlp_extraction_degraded');
    expect(block?.textContent).not.toMatch(/chunks indexed/);
    expect(block?.textContent).not.toContain('18 of');
  });

  it('a degraded STAGE shows the · partial chip while KEEPING data-state="done"', () => {
    // The flag deliberately rides a `done` stage rather than becoming a new
    // IngestionStageState member — the stage really did complete. Kills both
    // mutants: dropping the chip (the stepper stops naming WHICH stage lost
    // data) and widening the state union (every `state === 'done'` branch in
    // the stepper silently changes meaning).
    const el = render(
      baseProgress({
        terminal: 'degraded',
        percentComplete: 100,
        degradation: PROD_DEGRADATION,
        stages: [
          { key: 'upload', label: 'Uploaded', state: 'done' },
          { key: 'parse', label: 'Parsed', state: 'done' },
          {
            key: 'knowledge',
            label: 'Extracting knowledge',
            state: 'done',
            degraded: true,
            degradedReason: '119 of 137 chunks failed extraction',
          },
          { key: 'hierarchy', label: 'Building hierarchy', state: 'done' },
        ],
      }),
    );
    const chip = el.querySelector('[data-testid="ingestion-stage-knowledge-degraded"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('partial');
    expect(chip?.getAttribute('title')).toBe('119 of 137 chunks failed extraction');
    // The stage itself still reads `done`.
    expect(
      el.querySelector('[data-testid="ingestion-stage-knowledge"]')?.getAttribute('data-state'),
    ).toBe('done');
    // …and a stage that is NOT degraded gets no chip — the chip has to
    // discriminate, not decorate every done stage.
    expect(el.querySelector('[data-testid="ingestion-stage-hierarchy-degraded"]')).toBeNull();
    expect(el.querySelector('[data-testid="ingestion-stage-parse-degraded"]')).toBeNull();
  });

  it('exposes the tenant id in the details panel (tenant-fragmentation diagnostic)', () => {
    const el = render(baseProgress());
    // Collapsed by default → tenant not yet in the DOM.
    expect(el.querySelector('[data-testid="ingestion-details"]')).toBeNull();
    const toggle = el.querySelector('[data-testid="ingestion-details-toggle"]') as HTMLButtonElement;
    toggle.click();
    flushSync();
    expect(el.querySelector('[data-testid="ingestion-tenant"]')?.textContent).toContain(
      'tenant-xyz',
    );
  });
});
