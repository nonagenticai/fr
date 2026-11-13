// src/lib/components/analytics/PerChannelBars.test.ts
//
// Pure-logic coverage for the layout helpers exported from
// PerChannelBars.svelte. The chart itself is render-only; here we pin
// width math + ordering so the smallest channel never disappears and
// the largest fills `maxWidth`.
//
// Spec: docs/archive/2026-04-27-foundation-design.md §9.3.

import { describe, it, expect } from 'vitest';
import { layoutBars, type ChannelDatum } from './PerChannelBars.svelte';

const sample: ChannelDatum[] = [
  { kind: 'telegram', sends: 100 },
  { kind: 'teams', sends: 25 },
  { kind: 'email', sends: 50 },
  { kind: 'web', sends: 1 },
];

describe('layoutBars', () => {
  it('sorts channels by sends descending', () => {
    const out = layoutBars(sample, 200);
    expect(out.map((b) => b.kind)).toEqual(['telegram', 'email', 'teams', 'web']);
  });

  it('breaks ties on kind ascending', () => {
    const tied: ChannelDatum[] = [
      { kind: 'voice', sends: 10 },
      { kind: 'inapp', sends: 10 },
      { kind: 'email', sends: 10 },
    ];
    const out = layoutBars(tied, 200);
    expect(out.map((b) => b.kind)).toEqual(['email', 'inapp', 'voice']);
  });

  it('largest bar fills maxWidth', () => {
    const out = layoutBars(sample, 200);
    expect(out[0]!.width).toBe(200);
  });

  it('scales other bars proportionally to maxWidth', () => {
    const out = layoutBars(sample, 200);
    // teams=25/100*200=50, email=50/100*200=100
    expect(out.find((b) => b.kind === 'email')!.width).toBe(100);
    expect(out.find((b) => b.kind === 'teams')!.width).toBe(50);
  });

  it('clamps tiny bars to a minimum-visible width of 2px', () => {
    const out = layoutBars(sample, 200);
    const web = out.find((b) => b.kind === 'web')!;
    expect(web.width).toBeGreaterThanOrEqual(2);
  });

  it('returns [] for empty input', () => {
    expect(layoutBars([], 200)).toEqual([]);
  });

  it('formats sends as human-readable label', () => {
    const out = layoutBars(
      [
        { kind: 'a', sends: 1_500 },
        { kind: 'b', sends: 2_400_000 },
        { kind: 'c', sends: 12 },
      ],
      200,
    );
    expect(out.find((b) => b.kind === 'a')!.label).toBe('1.5k');
    expect(out.find((b) => b.kind === 'b')!.label).toBe('2.40M');
    expect(out.find((b) => b.kind === 'c')!.label).toBe('12');
  });

  it('does not mutate the input array', () => {
    const before = sample.map((c) => c.kind);
    layoutBars(sample, 200);
    expect(sample.map((c) => c.kind)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The three-state panel. See `channelPanelState`'s docstring: an empty
// `channels` array arrives identically whether the window was quiet or the read
// failed, and the component's copy — "No notifications dispatched in this
// window." — is only true for the first.
// ---------------------------------------------------------------------------

import { channelPanelState } from './PerChannelBars.svelte';

describe('channelPanelState', () => {
  it('an unreadable read is NOT the empty state', () => {
    expect(channelPanelState(0, 'analytics.per-channel failed: 502')).toBe('unreadable');
  });

  it('stays unreadable even if bars somehow survive from a prior tick', () => {
    // Stale bars beside a fresh failure would be a worse lie than none.
    expect(channelPanelState(3, 'boom')).toBe('unreadable');
  });

  it('a genuinely quiet window is empty — the claim this read earned', () => {
    expect(channelPanelState(0, null)).toBe('empty');
    expect(channelPanelState(0, undefined)).toBe('empty');
    // An empty-string reason is no reason at all.
    expect(channelPanelState(0, '')).toBe('empty');
  });

  it('renders bars when there are bars and no failure', () => {
    expect(channelPanelState(4, null)).toBe('bars');
  });
});
