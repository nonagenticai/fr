// tests/unit/server-error-boundary.test.ts
//
// ⚠️ UNLIKE the rest of tests/unit/, this file needs a real, MIGRATED
// Postgres reachable at `DATABASE_URL` — it spawns the actual
// `bun run src/server.ts` process, which retries DB connectivity at boot and
// never starts listening without one (see "WHY THIS FILE BOOTS THE REAL
// SERVER" below for why that trade is deliberate). CI's "Run backend tests"
// step (scripts/ci-test.sh) already sets `DATABASE_URL` to the job's migrated
// ephemeral postgres:18 container for this exact step, so this passes there
// unmodified. Running it locally with no DB configured fails closed with a
// clear "server did not come up within 15s" — not a false pass — after ~30s;
// point `DATABASE_URL` at a migrated Postgres (`bunx drizzle-kit push` +
// `bun run scripts/ci-seed.ts` + `bun run migrate`, same recipe CI uses) to
// run it locally.
//
// The request boundary must not throw away a structured error.
//
// MEASURED 2026-08-30 by sweeping all 129 parameterless GET routes against a
// locally-run fr with unreachable upstreams: FOUR returned a bare
// `{"error":"Internal server error"}` 500 — no code, no service, no cause —
// including `/api/admin/usage/system`, the admin metering page. Two distinct
// causes, both at the boundary in server.ts:
//
//   1. `IntegrationError extends Error`, NOT `AppError`, so an uncaught one
//      matched no branch and was demoted to 500. The route had already built a
//      correct structured error; the boundary discarded it. This matters far
//      beyond four routes: only 41 of 636 registrations use the `handle()`
//      wrapper, so every other route that throws one hit this path.
//   2. `AuthenticationError` (a service-account TOKEN MINT failure — Keycloak
//      unreachable or refusing) is its own class and likewise fell through,
//      reporting a credential problem as an fr code bug.
//
// ⛔ WHY THIS FILE BOOTS THE REAL SERVER, NOT `integrationErrorResponse` DIRECTLY
// ---------------------------------------------------------------------------
// An adversarial audit of #895 found that the version of this file that
// shipped with the fix imported `integrationErrorResponse` / `AuthenticationError`
// and asserted on their output DIRECTLY — but NO test file in tests/ imported
// `src/server.ts`. That means the actual dispatch code in server.ts (the two
// `else if` blocks below) was never executed by any test: deleting either
// block left all 4 assertions green, because the tests were hand-rebuilding
// what the boundary *should* produce rather than driving requests through the
// boundary itself. One of the four assertions
// (`err instanceof Error === true`) was even true on `main` BEFORE the fix.
//
// This file instead spawns the actual `bun run src/server.ts` process (same
// pattern as tests/integration/prod-boot-shape.integration.test.ts) and drives
// real HTTP requests at two routes MEASURED (2026-08-30) to throw these two
// error types uncaught, so the code under test is the literal branch dispatch
// in server.ts's central catch, not a mirror of it.
//
// One boot: KEYCLOAK_SECURE_APPS_URL points at a port nothing listens on, so
// the token POST fails at the network layer (AuthenticationError with no
// statusCode -> UPSTREAM_UNREACHABLE -> 502). The same boot also carries the
// IntegrationError trigger (no tenant context), which needs no upstream.
// (The refused-grant SERVICE_AUTH_FAILED path needed a fake Keycloak and was
// removed under the no-test-doubles ruling.)
//
// ⛔ MUTATION-VERIFIED, and one honest result to record
// ------------------------------------------------------
// Deleting server.ts's `else if (error instanceof AuthenticationError)` block
// turns the AuthenticationError test below genuinely red — real assertion
// failures (`Expected to not contain: "Internal server error" / Received:
// {"error":"Internal server error"}`), not a crash or an import error.
//
// Deleting server.ts's `else if (error instanceof IntegrationError)` block
// does NOT turn the IntegrationError test red. This is not a gap in this
// test: PR #908 ("an IntegrationError that escapes its wrapper was a 500"),
// merged the same day as #895 and already an ancestor of this branch, added
// its OWN `isIntegrationError(error)` check inside the generic
// `handleError()` fallback (src/utils/errors.ts) that server.ts's final
// `else` branch already calls. Both the dedicated branch and the fallback
// call the exact same `integrationErrorResponse(error)` on the exact same
// error object, so they are response-identical for every IntegrationError —
// there is no HTTP-observable difference to assert on. The dedicated
// `else if (error instanceof IntegrationError)` block in server.ts is
// provably dead code today; that is a finding about the code, not a
// weakness in this test, and no behavioral test (this one or any other)
// can make that specific deletion fail. `AuthenticationError` has no such
// sibling fallback, which is exactly why its branch above IS killable.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const PORT_A = 8891;
const UNREACHABLE_PORT = 8893; // nothing binds here, on purpose

const BASE_A = `http://127.0.0.1:${PORT_A}`;

const DECOMPOSITION_DECISIONS_PATH =
  '/api/decompositions/00000000-0000-4000-8000-000000000000/decisions';
const ADMIN_SYSTEM_USAGE_PATH = '/api/admin/usage/system';

function bootEnv(port: number, secureAppsUrl: string): Record<string, string> {
  return {
    ...process.env,
    AUTH_BYPASS: 'true',
    PORT: String(port),
    AGENT_SESSION_SIGNING_KEY: 'ci-boundary-test-signing-key-must-be-32-chars',
    N8N_API_KEY: 'ci-test-key',
    WORKFLOWS_CACHE_REFRESH_DISABLED: 'true',
    N8N_WEBHOOK_SECRET: 'ci-test-secret',
    PLANKA_AGENT_PASSWORD: 'ci-test',
    ARTIFACTS_DOWNLOAD_SIGNING_KEY: 'ci-test',
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5488/fr',
    KEYCLOAK_REALM: 'portal',
    KEYCLOAK_URL: 'https://example.invalid',
    KEYCLOAK_CLIENT_ID: 'fr',
    KEYCLOAK_CLIENT_SECRET: 'ci-noop',
    // getSecureAppsAuthenticator() (src/lib/service-authenticators.ts) reads
    // these four; all default to the portal-realm values above when unset.
    KEYCLOAK_SECURE_APPS_URL: secureAppsUrl,
    KEYCLOAK_SECURE_APPS_REALM: 'secure-apps',
    KEYCLOAK_SECURE_APPS_CLIENT_ID: 'fr-backend',
    KEYCLOAK_SECURE_APPS_CLIENT_SECRET: 'ci-noop',
  } as Record<string, string>;
}

async function waitUntilUp(base: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      // A deliberately unregistered path. Under AUTH_BYPASS=true every real
      // route's handler runs for real (bypass skips only the auth check, not
      // upstream calls), so probing a real asset route here risks blocking on
      // a slow/failing upstream retry loop instead of proving the server is
      // up. An unmatched path 404s from the router-miss branch, BEFORE any
      // handler or upstream call, so it is the fastest true readiness signal.
      const r = await fetch(`${base}/__readiness_probe__`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.status === 404) return;
    } catch {
      /* not yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`server at ${base} did not come up within 15s`);
}

let serverA: Bun.Subprocess | null = null;

beforeAll(async () => {
  serverA = Bun.spawn({
    cmd: ['bun', 'run', 'src/server.ts'],
    env: bootEnv(PORT_A, `http://127.0.0.1:${UNREACHABLE_PORT}`),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await waitUntilUp(BASE_A);
}, 30_000);

afterAll(() => {
  serverA?.kill();
});

describe('server.ts boundary: an uncaught IntegrationError is not demoted to a bare 500', () => {
  test('GET /api/decompositions/:familyId/decisions with no bearer (so no tenant) returns the structured MISSING_TENANT error', async () => {
    // No Authorization header: AUTH_BYPASS=true still lets validateAuth()
    // succeed inside the handler (it never inspects the token), but
    // buildRequestContext() in server.ts does its OWN unconditional bearer
    // verification to derive ctx.tenantId — with no bearer at all there is no
    // tenant, so requireTenant() throws an IntegrationError('MISSING_TENANT')
    // before any DB read, straight into
    // server.ts's central catch. This is a real regression guard on the
    // OBSERVABLE behavior, but the specific `else if (error instanceof
    // IntegrationError)` block cannot be mutation-killed by it: see the
    // "MUTATION-VERIFIED" note at the top of this file for why (PR #908's
    // fallback in handleError() already converts the same error the same
    // way).
    const res = await fetch(`${BASE_A}${DECOMPOSITION_DECISIONS_PATH}`);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(JSON.stringify(body)).not.toContain('Internal server error');
    expect(body.error.code).toBe('MISSING_TENANT');
    expect(res.status).toBe(409);
  });
});

describe('server.ts boundary: an uncaught AuthenticationError is not demoted to a bare 500', () => {
  test('an unreachable secure-apps token endpoint reports UPSTREAM_UNREACHABLE (502), not a bare 500', async () => {
    // BOOT A's KEYCLOAK_SECURE_APPS_URL points at a closed port, so
    // ServiceAuthenticator.fetchNewToken()'s `fetch()` throws a network error,
    // which service-auth.ts wraps as `AuthenticationError(..., undefined, ...)`.
    // handleGetAdminSystemUsage only catches IntegrationError inline
    // (src/routes/me/usage.ts) and rethrows anything else, so this reaches
    // server.ts's central catch uncaught.
    const res = await fetch(`${BASE_A}${ADMIN_SYSTEM_USAGE_PATH}`);
    const body = (await res.json()) as {
      error: { code: string; service?: string };
    };
    expect(JSON.stringify(body)).not.toContain('Internal server error');
    expect(body.error.code).toBe('UPSTREAM_UNREACHABLE');
    // This request carries no super-admin bearer, so the internal service name
    // is withheld (integrations/_lib/errors.ts redaction); the operator reads
    // it on the integration_error log line.
    expect(body.error.service).toBeUndefined();
    expect(res.status).toBe(502);
  });
});
