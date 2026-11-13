// tests/setup-env.ts
// Bun test preload — runs FIRST, before any other preload file or test
// module. Sets process.env defaults that downstream modules capture eagerly
// at import time.
//
// Why a separate file? ESM hoists `import` statements to the top of a file,
// regardless of textual position. `tests/setup.ts` has both env assignments
// AND side-effect imports (e.g. `import '../src/middleware/auth'`). Those
// imports transitively load `src/config.ts`, which reads
// `process.env.KEYCLOAK_CLIENT_SECRET` once and freezes it on the
// `config.keycloak` object. Setting the env var inside `setup.ts` *after*
// the imports is too late: config has already captured the empty default,
// and `getAdminAuth()` / `ServiceAuthenticator` then throw
// "clientSecret is required".
//
// This file has zero imports, so its top-level assignments are guaranteed
// to run before any module evaluation. Configured in `bunfig.toml` under
// `[test] preload` BEFORE `./tests/setup.ts`.

// ⛔ fr-agui P4d-2e — NO DATABASE_URL OUTSIDE CI = NO DATABASE, never devbox's local one.
// Since 2026-10-21 neither src/config.ts nor services/agent-session.ts has a DSN default: an
// unset DATABASE_URL refuses on first use. This preload stays as the TEST backstop (it predates
// that, from when config fell back to a localhost:5432 database). On a developer
// Mac that was a REAL local database: on 2026-10-17 a unit run without DATABASE_URL reached it
// and ran a scoped DELETE (memory fr-tests-without-database-url-hit-devbox-local-fr-db). So a
// test run with no DATABASE_URL and CI != 'true' gets an unconnectable sentinel URL instead, and
// FR_TEST_DATABASE_URL_REFUSED=1 makes src/db/client.ts refuse every connection with
// TEST_DATABASE_URL_REFUSED_MESSAGE below (DB-free tests are unaffected; anything that queries
// throws that message). In CI (CI=true) nothing changes: the CI steps set DATABASE_URL to their
// ephemeral postgres:18. Set DATABASE_URL to a throwaway database to run DB-backed tests locally.
if ((process.env.DATABASE_URL ?? '').trim() === '' && process.env.CI !== 'true') {
  process.env.DATABASE_URL = 'postgresql://fr-tests:refused@127.0.0.1:9/database_url_unset_outside_ci';
  process.env.FR_TEST_DATABASE_URL_REFUSED = '1';
}

// Keycloak admin client secret — `ServiceAuthenticator` (constructed by
// `getAdminAuth()` in src/services/keycloak.ts via `config.keycloak.clientSecret`)
// hard-throws when this is empty. CI never reaches a real Keycloak
// (KEYCLOAK_URL is unroutable), so the placeholder is never accepted anywhere.
process.env.KEYCLOAK_CLIENT_SECRET ||= 'test-only-keycloak-client-secret';

// KEYCLOAK_URL — formerly defaulted to `http://localhost:8080` in
// src/config.ts. Removed per config-externalization-policy.md (no
// hardcoded URLs in source). Pin a localhost placeholder for tests so
// `ServiceAuthenticator`'s "keycloakUrl is required" guard doesn't fire
// when `getAdminAuth()` is constructed during test boot. Tests stub
// `authenticatedFetch` / `globalThis.fetch`, so the URL is never dialed.
process.env.KEYCLOAK_URL ||= 'http://localhost:8080';

// Spec 2 §7 — disable the scheduled-trigger periodic worker during tests.
// Without this gate the periodic worker would fire on its own cadence and
// claim test fixtures mid-assertion.
process.env.SCHEDULED_TRIGGER_TICK_DISABLED ||= 'true';

// Phase 4 — credential encryption at rest. Pin a deterministic 32-byte
// test key so `encryption.initialize()` can produce a real AES-GCM key
// without requiring real env override during local/CI test runs. The
// production default in `src/config.ts` ('your-32-byte-encryption-key-here',
// exactly 32 bytes) would also work, but pinning a different value here
// makes the test boundary explicit. Must be exactly 32 ASCII bytes.
process.env.SECRET_ENCRYPTION_KEY ||= 'fr-test-encryption-key-32-bytes!';

// PLATFORM_BUDGET_WEBHOOK_SECRET — HMAC key for the billing budget-threshold
// webhook. The receiver no longer treats an empty secret as "skip
// verification" outside a deliberate dev posture, so the integration test signs
// its requests and needs a deterministic key. It MUST live in this file, not
// `tests/setup.ts`: `config.services.billing.budgetWebhookSecret` is captured
// once at `src/config.ts` evaluation, which setup.ts's ESM-hoisted imports
// trigger BEFORE any of its own top-level assignments run (same reason
// KEYCLOAK_CLIENT_SECRET lives here).
process.env.PLATFORM_BUDGET_WEBHOOK_SECRET ||= 'test-budget-webhook-secret-do-not-use-in-prod';

// Service URL placeholders — production code now reads service URLs
// strictly from env (no hardcoded cluster-DNS fallbacks). The
// http-client + integration adapters concatenate `baseUrl + path` and
// many test files pass the result into `new URL(...)`, which requires
// an absolute origin. Pin a deterministic test host so all integration
// adapters see a parseable URL (`.test` never resolves, so nothing
// here can reach a real upstream by accident).
process.env.N8N_WEBHOOK_URL ||= 'http://n8n.test/webhook';
process.env.N8N_API_URL ||= 'http://n8n.test/api/v1';
process.env.PLANKA_BASE_URL ||= 'http://planka.test';
process.env.WORKERS_API_URL ||= 'http://workers.test';
process.env.REQUIREMENTS_API_URL ||= 'http://requirements.test';
// R351 (7): every RM client refuses to send without fr's RM token
// (`tenantBearerRequired`), so the suite presents one, as prod does. A test of
// the refusal deletes it for its own scope.
process.env.REQUIREMENTS_SERVICE_TOKEN ||= 'test-requirements-service-token';
// kanban URL builders emit bare paths like `/projects`; the baseUrl
// must end with `/api` so the resulting absolute URL is `…/api/projects`.
process.env.KANBAN_API_URL ||= 'http://kanban.test/api';
process.env.CODING_GATEWAY_URL ||= 'http://coding-gateway.test';
process.env.KAG_API_URL ||= 'http://kag.test';
process.env.SECRETS_API_URL ||= 'http://secrets.test';
process.env.ARTIFACTS_API_URL ||= 'http://artifacts.test';
process.env.METERING_BASE_URL ||= 'http://metering.test';
process.env.METERING_SERVICE_URL ||= 'http://metering.test';
process.env.BILLING_BASE_URL ||= 'http://billing.test';
process.env.LICENSES_SERVICE_URL ||= 'http://licenses.test';
process.env.LICENSES_URL ||= 'http://licenses.test';
process.env.PROMETHEUS_URL ||= 'http://prometheus.test';
process.env.PUSHGATEWAY_URL ||= 'http://pushgateway.test';
process.env.GRAFANA_URL ||= 'https://grafana.test';
process.env.TEAMS_CALLBACK_URL ||= 'https://fr.test/api/webhooks/teams';
