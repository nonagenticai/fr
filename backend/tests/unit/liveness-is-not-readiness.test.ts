// tests/unit/liveness-is-not-readiness.test.ts
//
// A dependency being down must not get this process KILLED.
//
// `/health` validates Postgres and Redis and answers 503 when either is
// unreachable — correct for readiness, and it was also wired as the LIVENESS
// probe. Measured in production on 2026-08-14, not hypothesised: `fr-redis` was
// replaced at 18:00:10, `[health] redis error` repeated in the log, and kubelet
// SIGTERMed fr-backend at 18:01:02 — three failures at a 20s period, to the
// second. The pod came back about a minute later having lost every in-flight
// request, and restarting fr does nothing whatsoever to repair Redis.
//
// This is a SOURCE-LEVEL guard rather than a request test, deliberately.
// `server.ts` starts a listener on import, so there is no handler to call in
// isolation; and the regression this protects against is somebody adding a
// dependency check to the liveness branch "for completeness", which is a
// property of the source, not of one response. The live 200 is checked in the
// pod after rollout.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = readFileSync(join(import.meta.dir, '../../src/server.ts'), 'utf8');

/**
 * The liveness branch, and ONLY it.
 *
 * Bounded by the start of the `/health` branch that follows rather than by a
 * character count — a fixed slice ran past the end of the block and picked up
 * `/health`'s own `validateConnection`, so the "touches no dependency"
 * assertion failed against correct code. A test whose extent is a guess is a
 * test about the guess.
 */
function livenessBranch(): string {
  const start = SERVER.indexOf("url.pathname === '/health/live'");
  expect(start).toBeGreaterThan(-1);
  const end = SERVER.indexOf("url.pathname === '/health'", start);
  expect(end).toBeGreaterThan(start);
  return SERVER.slice(start, end);
}

describe('liveness is not readiness', () => {
  test('/health/live exists', () => {
    expect(SERVER).toContain("url.pathname === '/health/live'");
  });

  test('it answers 200 and nothing else', () => {
    const branch = livenessBranch();
    expect(branch).toContain('status: 200');
    expect(branch).not.toContain('503');
  });

  test('it touches no dependency', () => {
    // The whole point. A liveness probe that can fail because Postgres or Redis
    // is unreachable is a restart loop wearing a health check.
    const branch = livenessBranch();
    expect(branch).not.toContain('validateConnection');
    expect(branch).not.toContain('redis');
    expect(branch).not.toContain('await');
  });

  test('/health still DOES check its dependencies', () => {
    // The negative control. If this ever stops being true the split has been
    // "simplified" into one endpoint again, and the tests above would keep
    // passing while readiness silently stopped meaning anything.
    const start = SERVER.indexOf("url.pathname === '/health'");
    const branch = SERVER.slice(start, start + 1200);
    expect(branch).toContain('validateConnection');
    expect(branch).toContain('redis');
    expect(branch).toContain('503');
  });
});
