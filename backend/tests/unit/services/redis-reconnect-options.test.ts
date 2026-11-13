// tests/unit/services/redis-reconnect-options.test.ts
//
// Both of fr's Redis clients must be constructed with a reconnect budget that
// outlasts a transport outage. This is a CONSTRUCTION-SITE pin only.
//
// The reconnect BEHAVIOUR needs a real socket to die; it was pinned by
// the redis-transport-loss suite until that file was removed under the
// no-test-doubles ruling (2026-10-29), so it is now verified live only.
//
// ── WHY (fr#947, measured 2026-09-04) ────────────────────────────────────
// fr served 503 for ~1h45m and only a manual `rollout restart` cleared it. An
// Istio ambient ztunnel pod was recreated under the running fr pod; 39s later
// BOTH Redis clients — fr-redis and billing-redis, disjoint clusters — logged
// disconnect in the same second, then ERR_REDIS_CONNECTION_CLOSED forever. A
// live TCP connect from inside the wedged container succeeded, so the mesh was
// fine and the defect was above the socket.
//
// ⚠️ The cause is NOT "never re-established". `Bun.RedisClient` DOES
// auto-reconnect; `maxRetries` just defaults to 10, and a ztunnel roll outlasts
// that. Once the budget is spent the client is dead for the life of the process.
//
// Reproduced locally against redis in docker, identical 45s outage, identical
// code, options the only variable:
//
//   defaults   connects=1  ping ok=13   err=107  finalConnected=false
//   hardened   connects=2  ping ok=120  err=0    finalConnected=true
//
// The default run never came back even though redis was answering PONG again.
// That is the production shape, down to the error string.

import { test, expect, describe } from 'bun:test';

import {
  REDIS_CONNECTION_OPTIONS,
  REDIS_MAX_RETRIES,
} from '../../../src/services/redis-connection-options';

/** The arguments of the `new Bun.RedisClient(...)` call in a source file. */
async function ctorArgs(rel: string): Promise<string> {
  const src = await Bun.file(new URL(rel, import.meta.url)).text();
  const ctor = src.match(/new Bun\.RedisClient\(([^)]*)\)/);
  expect(ctor).not.toBeNull();
  return ctor![1]!;
}

describe('the shared reconnect options', () => {
  test('the retry budget outlasts a transport outage, by a wide margin', () => {
    // Bun's default is 10. The measured failure is that 10 is spent during a
    // ztunnel roll, after which the client never tries again. The exact number
    // does not matter; that it is not a handful does.
    expect(REDIS_MAX_RETRIES).toBeGreaterThan(1_000_000);
    expect(REDIS_CONNECTION_OPTIONS.maxRetries).toBe(REDIS_MAX_RETRIES);
  });
});

// SOURCE pins, not runtime ones: constructing the clients under a stub
// `Bun.RedisClient` would be a test double (ruling 2026-10-29).
describe('every Redis client is constructed with them', () => {
  test('the cache client (fr-redis) passes the options', async () => {
    const args = await ctorArgs('../../../src/services/redis.ts');
    // The URL must still be the first argument — a "fix" that passed options
    // but lost the connection target would point at Bun's default localhost.
    expect(args).toMatch(/^\s*config\.redis\.url\s*,/);
    expect(args).toContain('REDIS_CONNECTION_OPTIONS');
  });

  test('the metering client (billing-redis) passes them too', async () => {
    // This one died in the SAME SECOND during the incident. Hardening only the
    // cache client would leave half the outage in place.
    const args = await ctorArgs('../../../src/services/metering-emit.ts');
    expect(args).toContain('REDIS_CONNECTION_OPTIONS');
  });
});
