// src/lib/components/observability/LivenessBadge.test.ts
//
// Unit tests for `snapshotToBadgeView` — the pure derivation backing the
// REST-polled `observability/LivenessBadge.svelte`. The component itself
// only renders the result; all status/label logic lives in
// `livenessLogic.ts` so we can test under the default vitest `node`
// environment without a jsdom mount harness (no @testing-library/svelte
// in this repo).
//
// Plan: docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
//   §"Open follow-ups" — global ActivityTray + LivenessBadge mount.

import { describe, it, expect } from 'vitest';
import { snapshotToBadgeView } from './livenessLogic';

describe('snapshotToBadgeView', () => {
  it('returns idle/Unknown when snapshot is null', () => {
    const v = snapshotToBadgeView(null);
    expect(v.bucket).toBe('idle');
    expect(v.rawStatus).toBe('unknown');
    expect(v.label).toBe('Unknown');
    expect(v.subscriberCount).toBe(0);
    expect(v.maxLagSeconds).toBe(0);
  });

  it('returns idle/Unknown when snapshot is undefined', () => {
    const v = snapshotToBadgeView(undefined);
    expect(v.bucket).toBe('idle');
    expect(v.rawStatus).toBe('unknown');
  });

  it('maps status=live to bucket=live with label "Live"', () => {
    const v = snapshotToBadgeView({
      status: 'live',
      subscribers: 3,
      max_lag_seconds: 2,
    });
    expect(v.bucket).toBe('live');
    expect(v.rawStatus).toBe('live');
    expect(v.label).toBe('Live');
    expect(v.subscriberCount).toBe(3);
    expect(v.maxLagSeconds).toBe(2);
  });

  it('maps status=stale to bucket=idle with "Stale Ns" label', () => {
    const v = snapshotToBadgeView({
      status: 'stale',
      subscribers: 1,
      max_lag_seconds: 32,
    });
    expect(v.bucket).toBe('idle');
    expect(v.rawStatus).toBe('stale');
    expect(v.label).toBe('Stale 32s');
  });

  it('rounds the stale lag in the label', () => {
    const v = snapshotToBadgeView({
      status: 'stale',
      subscribers: 1,
      max_lag_seconds: 32.6,
    });
    expect(v.label).toBe('Stale 33s');
  });

  it('maps status=disconnected to bucket=idle with label "Idle"', () => {
    const v = snapshotToBadgeView({
      status: 'disconnected',
      subscribers: 0,
      max_lag_seconds: 0,
    });
    expect(v.bucket).toBe('idle');
    expect(v.rawStatus).toBe('disconnected');
    expect(v.label).toBe('Idle');
  });

  it('lowercases unfamiliar statuses but keeps them visible', () => {
    const v = snapshotToBadgeView({
      status: 'WEIRD',
      subscribers: 5,
      max_lag_seconds: 1,
    });
    expect(v.bucket).toBe('idle');
    expect(v.rawStatus).toBe('weird');
    expect(v.label).toBe('weird');
  });

  it('defaults non-finite numeric fields to 0', () => {
    const v = snapshotToBadgeView({
      status: 'live',
      subscribers: Number.NaN,
      max_lag_seconds: Number.NaN,
    });
    expect(v.subscriberCount).toBe(0);
    expect(v.maxLagSeconds).toBe(0);
  });
});
