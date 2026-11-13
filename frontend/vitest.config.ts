import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Kit 3 removed the built-in `$lib` alias; the app restores it (plus the shared
  // service-client type alias) in `vite.config.ts`, but vitest builds its own plugin
  // instance, so the same aliases have to be declared here too.
  plugins: [
    sveltekit({
      alias: {
        $lib: 'src/lib',
        '@fr/service-client-requirements': '../packages/service-clients/requirements/src/index.ts',
      },
    }),
  ],
  resolve: {
    // Svelte's package exports route `default` to `index-server.js`. Tests
    // that mount components into jsdom need the client runtime, so prefer
    // the `browser` export condition. Pure-logic tests are unaffected.
    conditions: ['browser'],
  },
  test: {
    // `e2e/**/*.unit.test.ts` are PURE-logic tests for the e2e harness itself
    // (FailureGate classification rules, optional-stage decisions). They need no
    // browser and must run in CI: those rules are allow-lists, and an allow-list
    // that is only ever hand-verified drifts into a blanket suppressor.
    // The `.unit.` infix keeps them from being collected by Playwright, whose
    // lanes match `*.spec.ts`.
    include: ['src/**/*.test.ts', 'e2e/**/*.unit.test.ts'],
    environment: 'node',
    // No test mocks a module, a global or the clock (backend/scripts/check-no-test-doubles.ts),
    // so files share workers: ~3.5x faster than one isolated worker per file.
    isolate: false,
    // Mirror the runtime build-time env var the production frontend
    // bundle would pick up from the gitops fr-frontend ConfigMap. Tests
    // use this to exercise the default Grafana host without requiring
    // every spec to pass `grafanaBase` explicitly.
    env: {
      VITE_GRAFANA_URL: 'https://grafana.nonagentic.ai',
      // Short-circuit `ensureFreshToken` in $lib/services/keycloak.ts so
      // unit tests that exercise authFetch never call keycloak-js's
      // init() (which assumes a real browser and fails in jsdom/node).
      // Tests that need to assert Bearer-header behavior should override
      // this locally.
      VITE_AUTH_BYPASS: 'true',
    },
  },
});
