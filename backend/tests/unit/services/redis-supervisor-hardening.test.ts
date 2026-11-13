// tests/unit/services/redis-supervisor-hardening.test.ts
//
// Four defects found by adversarial review of #978 AFTER it merged. Each is
// pinned here, because a guard nobody can redden is not a guard.
//
//  1. `Number('')` is 0 and `Number.isFinite(0)` is true, so an EMPTY
//     `REDIS_TERMINAL_GRACE_MS` — an ordinary ConfigMap shape — configured a
//     ZERO grace window.
//  2. With a zero window, `isTerminal()`'s rate floor (expressed in `graceMs`)
//     is always true, so every failing command built a new client: the storm
//     `redis-connection-options.ts` rejects, reached by an empty string.
//  3. The header claimed detection was behavioural and "NOT dependent on any
//     Bun-internal state flag". It was: `disconnectedSince` was set only by the
//     `onclose` handler, so a client that wedged while still believing it was
//     connected would never be rebuilt.
//  4. `run()` awaited the command unbounded. Bun defaults to
//     `enableOfflineQueue: true`, so a command issued while disconnected is HELD
//     rather than rejected — and a held command means `run()` never returns,
//     `isTerminal()` is never consulted, and the client can never be rebuilt.
//     The wedge again, one level up.

import { test, expect, describe } from 'bun:test';
import { graceFromEnv, REDIS_TERMINAL_GRACE_MS } from '../../../src/services/redis-supervisor';

describe('grace window from the environment', () => {
  test('an EMPTY or blank variable is "not configured", not a zero window', () => {
    expect(graceFromEnv('')).toBe(REDIS_TERMINAL_GRACE_MS);
    expect(graceFromEnv('   ')).toBe(REDIS_TERMINAL_GRACE_MS);
  });

  test('junk and negatives fall back rather than configuring nonsense', () => {
    expect(graceFromEnv('abc')).toBe(REDIS_TERMINAL_GRACE_MS);
    expect(graceFromEnv('-5')).toBe(REDIS_TERMINAL_GRACE_MS);
    expect(graceFromEnv(undefined)).toBe(REDIS_TERMINAL_GRACE_MS);
  });

  test('an explicit value is honoured, including a deliberate 0', () => {
    expect(graceFromEnv('250')).toBe(250);
    // Deliberate 0 stays usable — a test collapses the window that way, and the
    // rebuild RATE is floored separately so it cannot become a storm.
    expect(graceFromEnv('0')).toBe(0);
  });
});

