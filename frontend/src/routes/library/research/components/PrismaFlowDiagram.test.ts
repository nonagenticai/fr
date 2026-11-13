// @vitest-environment jsdom
//
// PrismaFlowDiagram — the per-stage flow, drawn.
//
// The assertions split into three groups, and the second two are the ones worth
// having:
//
//  1. the per-stage counts land in the right tier, in protocol order;
//  2. the three boxes this system cannot fill render as an explicit unknown and
//     NEVER as `0` — a zero there is a claim ("we looked, there were none") and
//     every one of them would be false;
//  3. a service that serves no `counts_by_stage` degrades to one merged tier
//     that says it is merged, rather than to the standard's two tiers holding
//     the same number twice.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import PrismaFlowDiagram from './PrismaFlowDiagram.svelte';
import type { Flow } from '$lib/api/reviews';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

const counts: Flow['counts'] = {
  identified_total: 900,
  quarantined: 4,
  rejected: 6,
  records_total: 800,
  duplicates_removed: 90,
  records_screened: 780,
  not_yet_screened: 20,
  included: 12,
  excluded: 760,
  uncertain: 8,
  exclusion_reasons: { wrong_population: 500, wrong_design: 260 },
  adjudicated: 3,
};

// Deliberately out of `stage_order` in the array, so the sort is under test:
// an array-order render would draw full text above title/abstract and reverse
// the review, and nothing on screen would look wrong.
const flow: Flow = {
  counts,
  counts_by_stage: [
    {
      stage_key: 'full-text',
      stage_order: 2,
      name: 'Full text',
      reached: 100,
      settled_include: 12,
      settled_exclude: 80,
      settled_uncertain: 8,
      exclusion_reasons: { wrong_design: 60, wrong_population: 20 },
    },
    {
      stage_key: 'title-abstract',
      stage_order: 1,
      name: 'Title/abstract',
      reached: 780,
      settled_include: 100,
      settled_exclude: 680,
      settled_uncertain: 0,
      exclusion_reasons: { wrong_population: 480, wrong_design: 200 },
    },
  ],
  canonical_counts_hash: 'sha256:deadbeef',
  flow_revision_number: 7,
  projection_stale: false,
};

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
const txt = (t: string) => q(t)?.textContent?.trim();
function render(props: { flow: Flow | null }): void {
  app = mount(PrismaFlowDiagram, { target: host, props });
  flushSync();
}

describe('PrismaFlowDiagram — per-stage counts', () => {
  beforeEach(() => render({ flow }));

  it('draws each stage with its own reached and its own exclusions', () => {
    expect(txt('prisma-stage-title-abstract-reached')).toBe('780');
    expect(txt('prisma-stage-title-abstract-excluded')).toBe('680');
    expect(txt('prisma-stage-full-text-reached')).toBe('100');
    expect(txt('prisma-stage-full-text-excluded')).toBe('80');
  });

  it('breaks each stage down by ITS OWN reasons, not the merged histogram', () => {
    // The merged `counts.exclusion_reasons` has wrong_design 260; full text's
    // own is 60. Rendering the merge under a stage is the reporting failure the
    // per-stage split exists to remove.
    expect(txt('prisma-stage-full-text-reason-wrong_design')).toBe('60');
    expect(txt('prisma-stage-full-text-reason-wrong_population')).toBe('20');
    expect(txt('prisma-stage-title-abstract-reason-wrong_design')).toBe('200');
    expect(txt('prisma-stage-title-abstract-reason-wrong_population')).toBe('480');
  });

  it('orders stages by stage_order, not by array order', () => {
    const tiers = [...host.querySelectorAll('[data-stage-order]')].map(
      (el) => (el as HTMLElement).dataset.stageOrder,
    );
    expect(tiers).toEqual(['1', '2']);
  });

  it('draws identification and inclusion from the flat ledger', () => {
    expect(txt('prisma-identified')).toBe('900');
    expect(txt('prisma-removed-duplicates')).toBe('90');
    expect(txt('prisma-removed-quarantined')).toBe('4');
    expect(txt('prisma-removed-rejected')).toBe('6');
    expect(txt('prisma-records-total')).toBe('800');
    expect(txt('prisma-included')).toBe('12');
  });

  it('surfaces the unsettled records that block the export', () => {
    expect(txt('prisma-not-yet-screened')).toBe('20');
    expect(txt('prisma-uncertain')).toBe('8');
  });

  it('warns against subtracting across tiers', () => {
    expect(txt('prisma-no-subtraction')).toContain('Do not subtract');
  });
});

describe('PrismaFlowDiagram — the boxes that cannot be filled', () => {
  beforeEach(() => render({ flow }));

  // Each of these must be a stated absence. A `0` would be a false claim, and
  // silence would leave the reviewer unable to learn the box is theirs to fill.
  it.each([
    ['prisma-unknown-sources', 'not recorded'],
    ['prisma-unknown-retrieval', 'Not recorded'],
    ['prisma-unknown-studies-vs-reports', 'not recorded'],
  ])('%s renders as an explicit unknown', (testid, marker) => {
    const el = q(testid);
    expect(el, `${testid} must render`).not.toBeNull();
    expect(el?.textContent).toContain(marker);
    expect(el?.textContent).not.toMatch(/\b0\b/);
  });

  it('draws the retrieval tier BETWEEN screening stages, once', () => {
    // It is a step between two screening stages, so a single-stage review has
    // no place for it at all — see the degraded case below.
    expect(host.querySelectorAll('[data-testid="prisma-unknown-retrieval"]')).toHaveLength(1);
  });
});

describe('PrismaFlowDiagram — degraded and empty inputs', () => {
  it('renders nothing at all without a flow', () => {
    render({ flow: null });
    expect(q('prisma-flow')).toBeNull();
  });

  it('falls back to ONE merged tier, labelled merged, when the service serves no split', () => {
    const { counts_by_stage: _omitted, ...noSplit } = flow;
    render({ flow: noSplit });

    expect(q('prisma-merged-tier')).not.toBeNull();
    expect(txt('prisma-records-screened')).toBe('780');
    expect(txt('prisma-excluded-merged')).toBe('760');
    expect(txt('prisma-merged-reason-wrong_population')).toBe('500');
    expect(txt('prisma-no-stage-split')).toContain('no per-stage flow');
    // No stage tiers, and therefore no retrieval tier to sit between them.
    expect(host.querySelectorAll('[data-stage-order]')).toHaveLength(0);
    expect(q('prisma-unknown-retrieval')).toBeNull();
    // The unfillable boxes that are NOT per-stage still have to be stated.
    expect(q('prisma-unknown-sources')).not.toBeNull();
    expect(q('prisma-unknown-studies-vs-reports')).not.toBeNull();
  });

  it('says a stage settled no exclusions rather than printing an empty list', () => {
    render({
      flow: {
        ...flow,
        counts_by_stage: [{ ...flow.counts_by_stage![1], exclusion_reasons: {} }],
      },
    });
    expect(q('prisma-stage-title-abstract-reasons')).toBeNull();
    expect(txt('prisma-stage-title-abstract-no-reasons')).toContain('No exclusions settled');
  });

  it('omits the outstanding banner for a review with nothing unsettled', () => {
    render({ flow: { ...flow, counts: { ...counts, not_yet_screened: 0, uncertain: 0 } } });
    expect(q('prisma-outstanding')).toBeNull();
  });
});
