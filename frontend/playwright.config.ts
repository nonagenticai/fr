import { defineConfig, devices } from '@playwright/test';

/**
 * Single Playwright config for fr. Replaces the former three-config split
 * (playwright.config.ts + .license.config.ts + .cockpit.config.ts), which
 * overlapped: the old default config's bare `testDir: './e2e'` swept up the
 * license/cockpit specs too and ran them against :5173 with no webServer.
 *
 * Each lane is a PROJECT with its own testDir, so a lane can only ever run the
 * specs that belong to it. See e2e/README.md for the per-lane bring-up.
 *
 *   dev-cluster  — drives the LIVE stack (fr backend under AUTH_BYPASS + the
 *                  in-cluster KAG gateway). Assumes the stack is ALREADY up.
 *
 * Retries/workers live HERE, per project — never on the CI command line, so the
 * same command reproduces CI locally.
 */

// Dedicated, uncommon port + --strictPort so a busy port FAILS LOUDLY rather
// than vite silently bumping to the next free one — which, on a shared dev box,
// would serve a DIFFERENT app and silently test the wrong UI.
const MOCK_PORT = 5198;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}`;

// The live lanes target an already-running stack. Playwright's `webServer` is
// global (it starts regardless of --project), so it must be suppressed when a
// live lane is selected. The npm scripts set FR_E2E_LIVE for those lanes.
//
// FR_E2E_LIVE alone is NOT sufficient for the production sweep lanes: their
// documented invocation is a bare `playwright test --project=sweep-live`, with
// no env var, so an env-only gate would start vite on 5198 and pay a 120s
// dev-server boot for a lane that never touches localhost. The gate therefore
// also reads argv for those two project names. Existing lanes are untouched:
// `sweep` and `dev-cluster` never match PROD_LANES, so
// they keep exactly the webServer behaviour they had before.
const PROD_LANES = ['sweep-auth', 'sweep-live'];

// ⛔ FAIL-CLOSED: the two production lanes are not even PRESENT in the config
// unless FR_SWEEP_LIVE=1 is set explicitly. Without this, a bare
// `playwright test` — no --project, which is what a newcomer and most CI
// templates type — would run sweep-live against https://fr.nonagentic.ai as a
// super_admin. Absent-by-default is the only version of this that cannot be
// reached by accident; a runtime check inside the spec would still have let
// Playwright boot the lane and authenticate first.
const ALLOW_PROD_SWEEP = process.env.FR_SWEEP_LIVE === '1';
const selectsProdLane = process.argv.some(
  (arg, i) =>
    PROD_LANES.some((n) => arg === `--project=${n}`) ||
    (arg === '--project' && PROD_LANES.includes(process.argv[i + 1])),
);
const isLiveLane = !!process.env.FR_E2E_LIVE || selectsProdLane;

if (selectsProdLane && !ALLOW_PROD_SWEEP) {
  throw new Error(
    'The sweep-auth / sweep-live lanes target PRODUCTION (https://fr.nonagentic.ai) and are ' +
      'omitted from this config unless FR_SWEEP_LIVE=1 is set. Re-run as: ' +
      'FR_SWEEP_LIVE=1 npx playwright test --project=sweep-live',
  );
}

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  // The `json` reporter is ADDITIVE: `list` and `html` are untouched, so
  // everything that reads the existing output still reads it.
  //
  // Path note: `test-results/` is Playwright's own outputDir. It is cleared at
  // the START of a run and the json reporter writes at the END, so the file
  // always survives the run that produced it. It is gitignored already
  // (frontend/.gitignore), so nothing new can be committed by accident.
  // Local runs keep the bare `list` reporter — no stray file on a dev box.
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
      ]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'dev-cluster',
      testDir: './e2e/lanes/dev-cluster',
      // Live upstreams (search -> ingest -> graph) are slow; give each test room.
      timeout: 90_000,
      expect: { timeout: 30_000 },
      // Never retry against live upstreams: a retry here hides real flake in the
      // cluster, which is exactly what this lane exists to surface.
      retries: 0,
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
        video: 'retain-on-failure',
      },
    },
    {
      // Structural sweep of every page route. NOT run by CI: a 168-route walk costs minutes that every PR should
      // not pay. This is an instrument you run deliberately, before and after a
      // UI fix, and diff:
      //   npx playwright test --project=sweep
      name: 'sweep',
      testDir: './e2e/lanes/sweep',
      // ⚠️ This lane shares a testDir with the production sweep lanes below.
      // Without this testMatch it would also pick up auth.setup.ts, interact
      // and forms — running a production login and a write pass against the
      // mocked vite server on 5198, which is not what any of them mean.
      testMatch: /route-sweep\.spec\.ts$/,
      timeout: 900_000,
      expect: { timeout: 10_000 },
      retries: 0,
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: MOCK_BASE_URL },
    },
    ...(ALLOW_PROD_SWEEP
      ? [
      {
        // Targets PRODUCTION (https://fr.nonagentic.ai) — no webServer, no local
        // vite. Read-only by default, enforced at runtime by
        // e2e/lanes/sweep/live-guard.ts. Opt-in: no CI workflow references it.
        // Logs in once and writes the storage state the sweep-live lane reuses.
        name: 'sweep-auth',
        testDir: './e2e/lanes/sweep',
        testMatch: /auth\.setup\.ts$/,
        timeout: 120_000,
        retries: 0,
        workers: 1,
        use: {
          ...devices['Desktop Chrome'],
          baseURL: process.env.E2E_BASE_URL ?? 'https://fr.nonagentic.ai',
        },
      },
      {
        // Targets PRODUCTION (https://fr.nonagentic.ai) — no webServer, no local
        // vite. Read-only by default, enforced at runtime by
        // e2e/lanes/sweep/live-guard.ts. Opt-in: no CI workflow references it.
        name: 'sweep-live',
        testDir: './e2e/lanes/sweep',
        testMatch: /(route-sweep|interact|forms)\.spec\.ts$/,
        dependencies: ['sweep-auth'],
        timeout: 900_000,
        retries: 0,
        workers: Number(process.env.FR_SWEEP_WORKERS ?? 4),
        use: {
          ...devices['Desktop Chrome'],
          baseURL: process.env.E2E_BASE_URL ?? 'https://fr.nonagentic.ai',
          storageState: process.env.FR_SWEEP_STATE,
          ignoreHTTPSErrors: false,
        },
      },
        ]
      : []),
  ],

  // VITE_AUTH_BYPASS makes auth.initialize() resolve to a mock identity
  // (lib/services/keycloak.ts) so the authenticated shell renders without
  // Keycloak (used by the local `sweep` instrument lane).
  // reuseExistingServer:false guarantees we never attach to a foreign server.
  webServer: isLiveLane
    ? undefined
    : {
        command: `npm run dev -- --port ${MOCK_PORT} --strictPort`,
        url: MOCK_BASE_URL,
        timeout: 120_000,
        reuseExistingServer: false,
        // FR_BACKEND_URL=none: the lane has NO backend, so vite must not proxy
        // unstubbed /api calls to localhost:8888 — on a dev box another
        // worktree's backend may hold that port and hang them (vite.config.ts).
        env: { VITE_AUTH_BYPASS: 'true', FR_BACKEND_URL: 'none' },
      },
});
