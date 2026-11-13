// src/lib/components/LivenessBadge.test.ts
//
// Unit tests for the pure `computeLiveness` derivation backing
// LivenessBadge.svelte. The component itself only renders the result; all
// threshold/boundary logic lives in livenessLogic.ts so we can test in node.
//
// Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
//   §"Frontend"  — green <20s, amber 20–60s, red >60s or socket closed

import { describe, it, expect } from 'vitest';
import { computeLiveness, CONNECTING_DEADLINE_SECONDS } from './LivenessBadge.svelte';

const NOW = 1_700_000_000_000;

describe('computeLiveness', () => {
  it('returns disconnected when lastHeartbeatTs is null', () => {
    const r = computeLiveness(null, NOW);
    expect(r.status).toBe('disconnected');
    expect(r.lagSeconds).toBe(0);
    expect(r.label).toBe('Disconnected');
  });

  it('returns disconnected when lastHeartbeatTs is null and socket explicitly closed', () => {
    const r = computeLiveness(null, NOW, false);
    expect(r.status).toBe('disconnected');
    expect(r.label).toBe('Disconnected');
  });

  it('returns connecting when socket is open but no heartbeat yet', () => {
    const r = computeLiveness(null, NOW, true);
    expect(r.status).toBe('connecting');
    expect(r.lagSeconds).toBe(0);
    expect(r.label).toBe('Connecting');
  });

  it('socketOpen flag is ignored once a heartbeat ts has been recorded', () => {
    // Even with socketOpen=true, an actual heartbeat takes precedence and
    // produces "live" / "stale" / "disconnected" by lag.
    const r = computeLiveness(NOW - 5_000, NOW, true);
    expect(r.status).toBe('live');
    expect(r.lagSeconds).toBe(5);
    expect(r.label).toBe('Live');
  });

  it('treats lag = 0s as live', () => {
    const r = computeLiveness(NOW, NOW);
    expect(r.status).toBe('live');
    expect(r.lagSeconds).toBe(0);
    expect(r.label).toBe('Live');
  });

  it('treats lag = 19s as live (just below stale threshold)', () => {
    const r = computeLiveness(NOW - 19_000, NOW);
    expect(r.status).toBe('live');
    expect(r.lagSeconds).toBe(19);
  });

  it('treats lag = 20s as stale (lower stale boundary)', () => {
    const r = computeLiveness(NOW - 20_000, NOW);
    expect(r.status).toBe('stale');
    expect(r.lagSeconds).toBe(20);
    expect(r.label).toBe('Stale 20s');
  });

  it('treats lag = 45s as stale (interior)', () => {
    const r = computeLiveness(NOW - 45_000, NOW);
    expect(r.status).toBe('stale');
    expect(r.label).toBe('Stale 45s');
  });

  it('treats lag = 60s as stale (upper inclusive boundary)', () => {
    const r = computeLiveness(NOW - 60_000, NOW);
    expect(r.status).toBe('stale');
    expect(r.lagSeconds).toBe(60);
    expect(r.label).toBe('Stale 60s');
  });

  it('treats lag = 61s as disconnected (above stale threshold)', () => {
    const r = computeLiveness(NOW - 61_000, NOW);
    expect(r.status).toBe('disconnected');
    expect(r.lagSeconds).toBe(61);
    expect(r.label).toBe('Disconnected');
  });

  it('treats very large lag as disconnected', () => {
    const r = computeLiveness(NOW - 3_600_000, NOW);
    expect(r.status).toBe('disconnected');
    expect(r.lagSeconds).toBe(3600);
  });

  it('clamps future-clock-skew to lag 0 → live', () => {
    // last heartbeat is 5s in the FUTURE (ntp drift, daylight savings, etc.)
    const r = computeLiveness(NOW + 5_000, NOW);
    expect(r.status).toBe('live');
    expect(r.lagSeconds).toBe(0);
    expect(r.label).toBe('Live');
  });
});

// ---------------------------------------------------------------------------
// The connecting DEADLINE (added 2026-09-09).
//
// Reported defect: on /kanban with Planka undeployed, the pill read
// "Connecting" forever. The WebSocket is to fr, not to Planka, so it opens
// normally and `socketOpen` stays true; the first `kanban:heartbeat` never
// arrives, so `lastHeartbeatTs` stays null. The old branch returned
// `connecting` on exactly that pair with no time bound, so nothing could ever
// move it. These cases pin the bound. They fail against the pre-fix
// three-argument implementation, which returns `connecting` for every one of
// them regardless of elapsed time.
// ---------------------------------------------------------------------------
describe('computeLiveness — connecting deadline', () => {
  const DEADLINE_MS = CONNECTING_DEADLINE_SECONDS * 1_000;

  it('pins the deadline to the same 60s the heartbeat path uses for red', () => {
    // Not a tautology restating the constant: it asserts the two thresholds are
    // the SAME number. The header justifies 60s by that symmetry, so a future
    // edit that moves one without the other should have to face this line.
    expect(CONNECTING_DEADLINE_SECONDS).toBe(60);
    // The heartbeat side: 60s lag is still amber, 61s is red.
    expect(computeLiveness(NOW - DEADLINE_MS, NOW).status).toBe('stale');
    expect(computeLiveness(NOW - DEADLINE_MS - 1_000, NOW).status).toBe('disconnected');
  });

  it('stays connecting 1s after the socket opened', () => {
    const r = computeLiveness(null, NOW, true, NOW - 1_000);
    expect(r.status).toBe('connecting');
    expect(r.label).toBe('Connecting');
    expect(r.lagSeconds).toBe(1);
  });

  it('stays connecting across the ~15s first-heartbeat window the state exists for', () => {
    const r = computeLiveness(null, NOW, true, NOW - 15_000);
    expect(r.status).toBe('connecting');
    expect(r.lagSeconds).toBe(15);
  });

  it('is still connecting at exactly the deadline (inclusive boundary)', () => {
    const r = computeLiveness(null, NOW, true, NOW - DEADLINE_MS);
    expect(r.status).toBe('connecting');
    expect(r.lagSeconds).toBe(CONNECTING_DEADLINE_SECONDS);
  });

  it('flips to disconnected one second past the deadline', () => {
    const r = computeLiveness(null, NOW, true, NOW - DEADLINE_MS - 1_000);
    expect(r.status).toBe('disconnected');
    expect(r.label).toBe('Disconnected');
    expect(r.lagSeconds).toBe(CONNECTING_DEADLINE_SECONDS + 1);
  });

  it('reports the Planka-undeployed case as disconnected, not Connecting forever', () => {
    // The literal reported bug: socket open ten minutes, zero heartbeats.
    const r = computeLiveness(null, NOW, true, NOW - 600_000);
    expect(r.status).toBe('disconnected');
    expect(r.lagSeconds).toBe(600);
  });

  it('a heartbeat that finally arrives beats an already-expired deadline', () => {
    // Socket has been open 10 min (deadline long gone) but a heartbeat landed
    // 2s ago — the badge must go green, not stay red on the stale open ts.
    const r = computeLiveness(NOW - 2_000, NOW, true, NOW - 600_000);
    expect(r.status).toBe('live');
    expect(r.lagSeconds).toBe(2);
  });

  it('keeps the unbounded connecting when no socket-open ts is supplied', () => {
    // A null open-ts is a MISSING INPUT, not a measurement that the socket is
    // healthy. Callers that cannot supply one keep the old behaviour rather
    // than being reddened by a clock nobody read.
    const r = computeLiveness(null, NOW, true, null);
    expect(r.status).toBe('connecting');
    expect(r.lagSeconds).toBe(0);
  });

  it('a closed socket is disconnected even inside the deadline window', () => {
    const r = computeLiveness(null, NOW, false, NOW - 1_000);
    expect(r.status).toBe('disconnected');
    expect(r.lagSeconds).toBe(0);
  });

  it('clamps a future-skewed socket-open ts to 0 → connecting', () => {
    const r = computeLiveness(null, NOW, true, NOW + 5_000);
    expect(r.status).toBe('connecting');
    expect(r.lagSeconds).toBe(0);
  });
});
