import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

// Boots fr-backend WITHOUT AUTH_BYPASS=true, hits each asset list endpoint
// with a bogus bearer, asserts response is NOT 404. Acceptable: 401/403/502.
// Catches: missing router.add() (workers 404), placeholder env-var crashes,
// broken AGENT_SESSION_SIGNING_KEY checks.
//
// DEPENDENCY: /api/assets/workers* will 404 until Task 2 (register workers
// routes) merges. That is the INTENDED guard — this test must fail on workers
// until that branch lands. Merge Task 2 before merging this one.

const PORT = 8889;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProcess: Bun.Subprocess | null = null;

beforeAll(async () => {
  serverProcess = Bun.spawn({
    cmd: ['bun', 'run', 'src/server.ts'],
    env: {
      ...process.env,
      AUTH_BYPASS: 'false',
      PORT: String(PORT),
      AGENT_SESSION_SIGNING_KEY: 'ci-boot-shape-test-signing-key-must-be-32-chars',
      N8N_API_KEY: 'ci-test-key',
      // No N8N_API_URL is set here, so the workflows-cache worker's boot prime
      // would fire a crawl against `baseUrl: ''`. Nothing in this test reads
      // the workflow catalogue — it asserts route SHAPE — so switch the worker
      // off rather than let it log a failed refresh on every boot.
      WORKFLOWS_CACHE_REFRESH_DISABLED: 'true',
      N8N_WEBHOOK_SECRET: 'ci-test-secret',
      PLANKA_AGENT_PASSWORD: 'ci-test',
      ARTIFACTS_DOWNLOAD_SIGNING_KEY: 'ci-test',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5488/fr',
      // Licence path OFF: the probes below use a NON-JWT bogus bearer so auth
      // answers 401 without a network call. With a licences URL set, that bearer
      // is introspected instead (unreachable here ⇒ 502). Empty URL = the
      // licence path is disabled (licence-introspect.ts licencePathEnabled).
      LICENSES_SERVICE_URL: '',
      LICENSES_URL: '',
      KEYCLOAK_REALM: 'portal',
      KEYCLOAK_URL: 'https://example.invalid',
      KEYCLOAK_CLIENT_ID: 'fr',
      KEYCLOAK_CLIENT_SECRET: 'ci-noop',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  // Poll an asset endpoint with a bogus bearer instead of /health.
  // /health validates the Keycloak JWKS endpoint and HANGS when KEYCLOAK_URL
  // is unreachable (which it intentionally is here). The asset endpoints'
  // auth middleware short-circuits on a non-JWT bearer and returns 401 in
  // milliseconds — perfect readiness signal for this test.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/assets/decisions`, {
        headers: { Authorization: 'Bearer readiness-probe' },
        signal: AbortSignal.timeout(2000),
      });
      if (r.status === 401 || r.status === 403) return;
    } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('Server did not come up within 15s');
}, 30_000);

afterAll(() => { serverProcess?.kill(); });

// Every path in this list must have a registered router.add() in server.ts.
// /api/assets/workers is intentionally absent here — it 404s until Task 2
// (workers route registration) merges; see DEPENDENCY comment at the top.
const ASSET_LIST_PATHS = [
  '/api/assets/workers',
  '/api/assets/workers/providers',
  '/api/assets/secrets',
  '/api/assets/decisions',
  '/api/assets/principles',
  '/api/assets/requirements',
  '/api/assets/artifacts',
  '/api/assets/kag/graph/stats',
  // KAG ingestion tool routes — registered via routes/tools/index.ts.
  // Listed here so the boot-shape smoke catches a regression where the
  // tools aggregator import goes missing.
  '/api/tools/kag/scrape/sessions',
  // Coding spine reads — capability-derived (capabilities/platform/coding.ts; was routes/coding/index.ts). Listed here so
  // the smoke catches a regression where the coding aggregator import goes
  // missing (the 2026-04-26 missing-router.add outage class).
  '/api/coding/containers',
  '/api/coding/graphs/some-container/augmented',
  '/api/coding/quality/some-container/gate',
  '/api/coding/dependencies/some-container/report',
  '/api/coding/dependencies/some-container/snapshot',
];

// The INVERSE list: paths that must NOT resolve to a handler.
//
// The router keeps its route table private, so "this route is gone" cannot be
// asserted in-process. It CAN be asserted here, because a booted server with
// AUTH_BYPASS=false discriminates cleanly between the two cases:
//
//   registered route + bogus bearer -> 401 (validateAuth rejects in the handler)
//   unregistered path               -> 404 (the router never finds a handler)
//
// So 401 on any path below is proof the route came BACK.
const REMOVED_PATHS = [
  // GET /api/licenses/user/:userId — deleted. It derived its upstream URL with
  // `secrets.baseUrl.replace('secrets','licenses')`, which (String.replace on a
  // string pattern replaces only the FIRST match) produced
  // http://licenses.example.com:8543 — wrong namespace AND wrong
  // port, unresolvable. Its bare `catch` then returned a FABRICATED active
  // 'free' licence with features on EVERY production request. The SPA reads
  // GET /api/license/status instead; nothing called this.
  '/api/licenses/user/00000000-0000-0000-0000-000000000000',
];

// Control for the block above. Without it a regression that 404s EVERY path
// (bad router wiring, server not actually up) would make REMOVED_PATHS pass
// while proving nothing. This live route must still answer 401, not 404.
const LIVE_ROUTE_CONTROL = '/api/auth/me';

const BOGUS_BEARER = {
  Authorization: 'Bearer this-is-a-bogus-token-the-server-must-still-route',
};

describe('prod boot shape — every asset list endpoint resolves', () => {
  it.each(ASSET_LIST_PATHS)('GET %s does NOT 404', async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: BOGUS_BEARER });
    expect(r.status).not.toBe(404);
  });
});

describe('prod boot shape — removed routes stay removed', () => {
  it(`control: ${LIVE_ROUTE_CONTROL} is routed (401, not 404)`, async () => {
    const r = await fetch(`${BASE}${LIVE_ROUTE_CONTROL}`, { headers: BOGUS_BEARER });
    expect(r.status).toBe(401);
  });

  it.each(REMOVED_PATHS)('GET %s is NOT routed (404, not 401)', async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: BOGUS_BEARER });
    expect(r.status).toBe(404);
  });
});
