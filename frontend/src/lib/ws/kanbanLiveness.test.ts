// src/lib/ws/kanbanLiveness.test.ts
//
// Unit tests for the socket-open TIMESTAMP added alongside the existing
// socket-open flag in kanbanLiveness.svelte.ts.
//
// Why it exists: `computeLiveness` can only bound the "Connecting" state if
// something records WHEN the socket opened. Before this, the module held a
// bare boolean, so an open socket that never received a `kanban:heartbeat`
// (Planka undeployed — the socket is to fr, not to Planka) left the badge on
// "Connecting" with nothing able to age it out.
//
// ⚠️ The stamp is taken on the false→true TRANSITION. A stamp refreshed on
// every `setSocketOpen(true)` would silently restart the deadline, so a
// never-heartbeating socket would read as perpetually fresh — i.e. it would
// reintroduce the exact bug through the fix. That is what the "does not
// restart" case below pins.
//
// The file is named `.test.ts`, not `.svelte.test.ts`: the subject is a rune
// module but the test itself uses no runes, and vitest's include glob
// (`src/**/*.test.ts`) picks it up either way.

// Real clock, no fake timers (no-test-doubles ruling 2026-10-29): stamps are
// bracketed by Date.now() read before and after, and the "later" cases wait a
// few real milliseconds so a restarted stamp is distinguishable.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSocketOpen,
  getSocketOpen,
  getSocketOpenedAtTs,
  setLastHeartbeatTs,
  clearLastHeartbeatTs,
  getLastHeartbeatTs,
} from './kanbanLiveness.svelte';

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  // Module state is a singleton shared across this file — reset it explicitly
  // rather than relying on import order.
  setSocketOpen(false);
  clearLastHeartbeatTs();
});

describe('kanbanLiveness socket-open timestamp', () => {
  it('starts null with no socket open', () => {
    expect(getSocketOpen()).toBe(false);
    expect(getSocketOpenedAtTs()).toBeNull();
  });

  it('stamps the current time when the socket opens', () => {
    const before = Date.now();
    setSocketOpen(true);
    const after = Date.now();
    expect(getSocketOpen()).toBe(true);
    const ts = getSocketOpenedAtTs()!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('does NOT restart the stamp on a redundant setSocketOpen(true)', async () => {
    setSocketOpen(true);
    const first = getSocketOpenedAtTs();
    await tick();
    setSocketOpen(true);
    // Still the ORIGINAL open time — otherwise the connecting deadline could
    // be pushed out indefinitely and never expire.
    expect(getSocketOpenedAtTs()).toBe(first);
  });

  it('clears the stamp when the socket closes', () => {
    setSocketOpen(true);
    setSocketOpen(false);
    expect(getSocketOpen()).toBe(false);
    expect(getSocketOpenedAtTs()).toBeNull();
  });

  it('gives a reconnected socket its own deadline rather than the old one', async () => {
    setSocketOpen(true);
    const first = getSocketOpenedAtTs()!;
    await tick();
    setSocketOpen(false); // onclose
    setSocketOpen(true); // reconnect
    expect(getSocketOpenedAtTs()!).toBeGreaterThan(first);
  });

  it('leaves the heartbeat ts untouched — they are independent signals', () => {
    const hb = Date.now() + 5_000;
    setLastHeartbeatTs(hb);
    setSocketOpen(true);
    expect(getLastHeartbeatTs()).toBe(hb);
    expect(getSocketOpenedAtTs()).not.toBeNull();
  });
});
