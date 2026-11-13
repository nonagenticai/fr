// The ANDON case, tested at the layer that can actually be tested.
//
// `ActivityTray` is the surface a person looks at to answer "is the system
// alive?". Its liveness read used to degrade to `snapshot = null` on BOTH a
// failed read and a 200 carrying no data, and `snapshotToBadgeView(null)`
// renders `{ rawStatus:'unknown', subscriberCount: 0, maxLagSeconds: 0 }` —
// i.e. the ordinary pill, with a tooltip asserting "0 subscribers, max lag 0s"
// about a WS pool it had just failed to reach. An andon that is quietest
// exactly when it is blindest converts "we cannot see" into "there is nothing
// to see".
//
// SCOPE. These cases pin the DERIVATION — that a failed read and an
// honest-empty read produce two DIFFERENT badge views. They do NOT prove the
// template renders `data-testid="liveness-unreadable"`; that needs the
// component mounted. See the note at the bottom of this file.

import { describe, it, expect } from 'vitest';
import { unreadableBadgeView, snapshotToBadgeView } from './livenessLogic';

describe('a failed liveness read is not an idle system', () => {
  it('unreadable and honest-empty are DIFFERENT views', () => {
    const unreadable = unreadableBadgeView();
    const empty = snapshotToBadgeView(null);
    // The whole defect in one assertion: these two used to be identical.
    expect(unreadable.rawStatus).not.toBe(empty.rawStatus);
    expect(unreadable.rawStatus).toBe('unreadable');
    expect(empty.rawStatus).toBe('unknown');
  });

  it('the unreadable view carries a label the template can show', () => {
    // Without a distinct label the branch is invisible to a reader even when
    // the code takes it.
    expect(unreadableBadgeView().label).toBe('Unreadable');
  });

  it('reuses the idle bucket, so no new colour token is introduced', () => {
    // Deliberate: `LivenessPill.badgeStatus` falls through to the `unknown`
    // palette. The point is to stop CLAIMING a measurement, not to repaint.
    expect(unreadableBadgeView().bucket).toBe('idle');
  });

  it('its zeroed counts are placeholders, never a measurement to display', () => {
    // They are zero because nothing was counted. The template must branch on
    // `rawStatus`, never render these as facts — that WAS the bug.
    const v = unreadableBadgeView();
    expect(v.subscriberCount).toBe(0);
    expect(v.maxLagSeconds).toBe(0);
    expect(v.rawStatus).toBe('unreadable');
  });

  it('a REAL snapshot is unaffected — the guard did not blanket everything', () => {
    // The positive control. Without it, "always unreadable" would pass above.
    const live = snapshotToBadgeView({
      subscribers: [{ status: 'connected', lagSeconds: 1 }],
    } as never);
    expect(live.rawStatus).not.toBe('unreadable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MOUNTED ActivityTray TEST.
//
// It was deleted in 0d5b3074 because it HUNG the vitest worker outright: no
// test output, `--testTimeout` never fired (so the event loop itself was
// blocked, not merely slow), and on CI
//   FATAL ERROR: Ineffective mark-compacts near heap limit — heap out of memory
//   [vitest-pool]: Timeout terminating forks worker for … ActivityTray.unreadable
// after 968s, reported as "2956/2961 passed" with an unhandled error — a suite
// that looks almost-green while a worker died.
//
// That commit's bisection was right about WHERE (import fine, mount hangs) and
// wrong about WHO: it concluded "this is a defect in the test's approach, not a
// leak in the code under test". It was the component. `ActivityTray`'s poll
// `$effect` READ `loading` — `refresh()`'s re-entrancy guard — and WROTE it in
// the same tracked run, so every settle re-dirtied the effect and called
// `refresh()` again. The re-entry crosses a microtask boundary, so Svelte's
// `effect_update_depth_exceeded` guard never trips and nothing is reported.
// Measured: 368,800 `listExecutions` calls in 60s under jsdom with a
// `setTimeout(…, 0)` that never ran, and — the part that was never only a test
// problem — 1,674 refreshes in 3s (~1,100 req/s) under browser-shaped I/O with
// `pollIntervalMs = 10_000_000`. Production was storming the whole time.
//
// Fixed by running the effect body inside `untrack()` while keeping `open` and
// `pollIntervalMs` as its tracked reads.
