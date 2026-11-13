// tests/unit/server-json-body-wiring.test.ts
//
// ⚠️ Like tests/unit/server-error-boundary.test.ts, this file needs a real,
// MIGRATED Postgres at `DATABASE_URL`: it spawns the actual
// `bun run src/server.ts`, which validates the DB and applies migrations
// before it listens. CI's "Run backend tests" step already provides one. With
// no DB it fails closed ("server did not come up within 15s"), never a false
// pass.
//
// WHY THIS FILE EXISTS. tests/unit/utils/errors-json-body.test.ts proves the
// helpers (`tagInboundJsonParseErrors` + `handleError`) map a malformed inbound
// body to 400 — but it REPLICATES server.ts's dispatch, so deleting the one
// `tagInboundJsonParseErrors(req)` call in server.ts left every one of its
// assertions green while production went back to a 500. This file drives a real
// HTTP request through the real router + central catch.
//
// Route: POST /api/secrets (src/routes/secrets.ts handleCreateSecret). Under
// AUTH_BYPASS=true `validateAuth` returns the synthetic user without a DB or
// Keycloak round-trip, and the very next line is a bare `await req.json()` —
// so a malformed body reaches the central catch before anything is written.
//
// MUTATION-VERIFIED (2026-10-05): deleting `tagInboundJsonParseErrors(req);`
// from server.ts turns the `{bad` and empty-body tests red (500
// "Internal server error"); the CONTROL stays green.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const PORT = 8896;
const BASE = `http://127.0.0.1:${PORT}`;

function bootEnv(): Record<string, string> {
  return {
    ...process.env,
    AUTH_BYPASS: 'true',
    PORT: String(PORT),
    AGENT_SESSION_SIGNING_KEY: 'ci-json-body-test-signing-key-must-be-32-chars',
    N8N_API_KEY: 'ci-test-key',
    WORKFLOWS_CACHE_REFRESH_DISABLED: 'true',
    N8N_WEBHOOK_SECRET: 'ci-test-secret',
    PLANKA_AGENT_PASSWORD: 'ci-test',
    ARTIFACTS_DOWNLOAD_SIGNING_KEY: 'ci-test',
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5488/fr',
    KEYCLOAK_REALM: 'portal',
    KEYCLOAK_URL: 'https://example.invalid',
    KEYCLOAK_CLIENT_ID: 'fr',
    KEYCLOAK_CLIENT_SECRET: 'ci-noop',
  } as Record<string, string>;
}

async function waitUntilUp(base: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      // Unregistered path → router-miss 404 before any handler: the fastest
      // true readiness signal (see server-error-boundary.test.ts).
      const r = await fetch(`${base}/__readiness_probe__`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 404) return;
    } catch {
      /* not yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`server at ${base} did not come up within 15s`);
}

let server: Bun.Subprocess | null = null;

beforeAll(async () => {
  server = Bun.spawn({
    cmd: ['bun', 'run', 'src/server.ts'],
    env: bootEnv(),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await waitUntilUp(BASE);
}, 30_000);

afterAll(() => {
  server?.kill();
});

const post = (body: string) =>
  fetch(`${BASE}/api/secrets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('server.ts dispatch: a malformed inbound JSON body is a 400, not a 500', () => {
  test('POST /api/secrets with `{bad` → 400 {error: "invalid JSON body"}', async () => {
    const res = await post('{bad');
    expect(await res.json()).toEqual({ error: 'invalid JSON body' });
    expect(res.status).toBe(400);
  });

  test('POST /api/secrets with an empty body → 400', async () => {
    const res = await post('');
    expect(res.status).toBe(400);
  });

  test('CONTROL — well-formed JSON that fails validation is NOT reported as invalid JSON', async () => {
    // Proves the route really runs past `req.json()` on a good body: the
    // invalid-JSON branch above is specific to the parse failure.
    const res = await post('{}');
    const text = await res.text();
    expect(text).not.toContain('invalid JSON body');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
