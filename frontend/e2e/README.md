# Playwright lanes

The Playwright suites are opt-in. They are not part of `npm run test` (Vitest)
and are not run by CI; each lane expects a running stack.

| Project | What it drives |
|---|---|
| `dev-cluster` | The live application: backend + frontend + the KAG gateway. |
| `sweep` | Repeated UI sweep against a stack the caller supplies. |
| `sweep-auth` | Auth bootstrap for the sweep lanes. |
| `sweep-live` | The production-shaped sweep. Only present when `FR_SWEEP_LIVE=1` is set explicitly. |

The live lanes target an already-running stack, so Playwright's `webServer` is
suppressed for them (`FR_E2E_LIVE=1`, set by the npm scripts). Without that
variable the harness starts a local mock server on port 5198 instead.

Bring-up is environment-specific: point `FR_E2E_BASE_URL` (and the other
variables in `frontend/.env.example`) at your stack, make sure the backend is
reachable from the machine running Playwright, then run:

```sh
npm run test:e2e:dev-cluster   # FR_E2E_LIVE=1 playwright test --project=dev-cluster
FR_SWEEP_LIVE=1 npx playwright test --project=sweep-live
```

The pure-logic tests for the harness itself (`e2e/**/*.unit.test.ts`) DO run
under Vitest.
