// tests/unit/lib/readiness-policy.test.ts
//
// A CACHE must not take a working pod out of rotation.
//
// On 2026-09-06 fr and kag-frontend/kag (the same image digest) served zero
// endpoints for 2h45m answering `{"status":"degraded","db":"ok","redis":"error"}`.
// Postgres was fine and had self-recovered at 02:14; the app was fine. The
// readiness policy did the rest. The full argument — including the
// cache-miss-storm counter-argument and why it is rejected — is in the header
// of `src/lib/readiness.ts`.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FATAL_DEPENDENCIES, readinessVerdict } from '../../../src/lib/readiness';

describe('the readiness policy', () => {
  test('everything up is plain ok', () => {
    expect(readinessVerdict({ db: 'ok', redis: 'ok' })).toEqual({
      ready: true,
      status: 'ok',
      degraded: [],
    });
  });

  test('Redis down degrades a field — it does NOT deschedule the pod', () => {
    // THE REGRESSION. Under the old policy this was `ready: false` / 503, and
    // that is the 2h45m outage.
    const v = readinessVerdict({ db: 'ok', redis: 'error' });
    expect(v.ready).toBe(true);
    expect(v.status).toBe('degraded');
    expect(v.degraded).toEqual(['redis']);
  });

  test('Postgres down IS fatal', () => {
    // The negative control. "Nothing is ever fatal" would pass the test above
    // and would be a pod happily serving wrong answers with no system of record.
    const v = readinessVerdict({ db: 'error', redis: 'ok' });
    expect(v.ready).toBe(false);
    expect(v.status).toBe('unhealthy');
  });

  test('both down is still fatal, and still names the cache', () => {
    const v = readinessVerdict({ db: 'error', redis: 'error' });
    expect(v.ready).toBe(false);
    expect(v.degraded).toEqual(['redis']);
  });

  test('the fatal set is exactly the system of record', () => {
    // Re-adding `redis` here reinstates the outage. If that is ever the right
    // call, the argument in lib/readiness.ts has to be answered first.
    expect([...FATAL_DEPENDENCIES]).toEqual(['db']);
  });
});

describe('GET /health actually uses the policy', () => {
  // Source-level, like `liveness-is-not-readiness.test.ts` and for the same
  // reason: `server.ts` starts a listener on import, so there is no handler to
  // call in isolation.
  const SERVER = readFileSync(join(import.meta.dir, '../../../src/server.ts'), 'utf8');

  function readinessBranch(): string {
    const start = SERVER.indexOf("url.pathname === '/health'");
    expect(start).toBeGreaterThan(-1);
    const end = SERVER.indexOf("url.pathname === '/api/metrics/prom'", start);
    expect(end).toBeGreaterThan(start);
    return SERVER.slice(start, end);
  }

  test('it delegates the verdict rather than re-deciding inline', () => {
    expect(readinessBranch()).toContain('readinessVerdict(');
  });

  test('the HTTP status is not gated on Redis', () => {
    const branch = readinessBranch();
    expect(branch).toContain('status: verdict.ready ? 200 : 503');
    // The exact shape that shipped the outage.
    expect(branch).not.toContain("redisStatus === 'ok'");
  });

  test('it still reports Redis, so the outage stays visible', () => {
    const branch = readinessBranch();
    expect(branch).toContain('[health] redis error');
    expect(branch).toContain('redis: redisStatus');
    expect(branch).toContain('degraded: verdict.degraded');
  });
});
