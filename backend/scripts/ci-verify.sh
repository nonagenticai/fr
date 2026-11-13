#!/usr/bin/env bash
# `bun run ci:verify` — every static check the backend CI runs (the ts-service
# archetype's "Lint and type-check" step calls this). No database needed.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { echo; echo "=== $* ==="; }

step "CI must not authenticate against production Keycloak"
bash scripts/check-ci-no-prod-keycloak.sh
step "No private keys tracked (tree scan, fr#1266)"
bash scripts/check-no-private-keys.sh
step "Type check"
NODE_OPTIONS=--max-old-space-size=4096 bun run typecheck
step "Generated service clients match their committed snapshots"
bun run clients:generate --check
step "Every RM operation fr calls is baselined and still in the snapshot"
bun run ../tooling/openapi/drift.ts --check-baseline
step "No duplicate migration numeric prefixes"
bun run check-migration-numbers
step "A data-changing migration must be probed or say it isn't"
bun run scripts/check-migration-dml-probed.ts
step "No test doubles (fetch stubs, mocks, spies, injected fakes, route interception)"
bun run scripts/check-no-test-doubles.ts
step "No JS array bound into a drizzle ANY(...)"
bun run scripts/check-any-bound-array.ts
step "No non-tenant value written to a tenant field"
bun run scripts/check-tenant-field-misuse.ts
step "No authorization decided from the raw admin claim"
bun run scripts/check-admin-claim-only.ts
step "Every route is declared in the OpenAPI spec (both directions)"
bun run scripts/check-route-spec-coverage.ts
step "The served OpenAPI document equals its committed lock"
bun run scripts/check-served-spec.ts
step "Every table is TRUNCATE/bulk-DELETE guarded, or exempt on the record"
bun run scripts/check-destructive-guard-coverage.ts
step "Credential-absence assertions are armed"
bun run scripts/check-credential-absence-armed.ts
step "A caller's bad input is not an upstream failure"
bun run scripts/check-client-input-not-upstream.ts
step "An approval addressed to nobody must not be mintable"
bun run scripts/check-approval-mint-guard.ts
echo
echo "ci:verify OK"
