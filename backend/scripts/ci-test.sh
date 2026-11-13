#!/usr/bin/env bash
# `bun run ci:test` — the backend's full CI test run. The ts-service archetype's
# Test step calls it with DATABASE_URL + REDIS_URL pointing at its sidecars.
#
#   1. bootstrap schema + seed + migrations on $DATABASE_URL
#   2. a FRESH database on the same server (and redis logical db 1) for the
#      whole tests/integration tree
#   3. unit + auth + src suites and the integration tree run CONCURRENTLY, one
#      database each, so neither sees the other's rows
#
# Every `bun test` here passes --timeout 60000: bunfig's [test] timeout is
# inert for bodies and hooks (fr#1347); only the CLI flag reaches them.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must point at a disposable postgres:18}"
: "${REDIS_URL:?REDIS_URL must point at a disposable redis}"

export CI=true
export FR_TEST_REQUIRE_DB=1
export TEST_POSTGRES_IMAGE="${TEST_POSTGRES_IMAGE:-postgres:18}"
# Unroutable on purpose: CI never talks to a real Keycloak.
export KEYCLOAK_URL=http://test-keycloak.invalid
export KEYCLOAK_REALM=test-realm
export KEYCLOAK_CLIENT_ID=test-client
export KEYCLOAK_CLIENT_SECRET=test-secret
export KEYCLOAK_ISSUER=http://test-keycloak.invalid/realms/test-realm

step() { echo; echo "=== $* ==="; }

step "Bootstrap schema + seed + migrations"
echo y | bunx drizzle-kit push
bun run scripts/ci-seed.ts
bun run migrate

step "Fresh database + redis db 1 for the integration tree (same servers)"
INT_DATABASE_URL="$(bun run scripts/ci-create-db.ts fr_ci_integration)"
INT_REDIS_URL="$(printf '%s' "$REDIS_URL" | sed -E 's#^(rediss?://[^/?]+).*#\1/1#')"

step "Unit + auth + src suites, integration tree concurrently"
bun run scripts/require-db-reachable.ts
INT_LOG="$(mktemp -t fr-ci-integration.XXXXXX)"
(
  set -e
  export DATABASE_URL="$INT_DATABASE_URL" REDIS_URL="$INT_REDIS_URL"
  echo y | bunx drizzle-kit push --force
  bun run migrate
  bun run scripts/require-db-reachable.ts
  bun test --timeout 60000 tests/integration \
    '--path-ignore-patterns=tests/integration/planka/{boards,cards,comments,intake,labels,lists,members,projects,tasks}.test.ts' \
    '--path-ignore-patterns=tests/integration/routes/kanban/{cards,comments,labels,lists,members,tasks}.test.ts'
) > "$INT_LOG" 2>&1 &
INT_PID=$!
set +e
bun test --timeout 60000 tests/unit/ tests/auth/ src/
unit_rc=$?
wait "$INT_PID"
int_rc=$?
set -e
step "Integration tree output (rc=$int_rc)"
cat "$INT_LOG"
rm -f "$INT_LOG"
echo "unit rc=$unit_rc integration rc=$int_rc"
# An explicit exit: under `set -e` a failing NON-LAST command of an `&&` list
# does not stop the script, so `[ unit ] && [ int ]` with a red unit run fell
# through to "ci:test OK" and exit 0 (measured 2026-10-30: unit rc=1 → ci:test OK).
if [ "$unit_rc" -ne 0 ] || [ "$int_rc" -ne 0 ]; then
  echo "ci:test FAILED"
  exit 1
fi

echo
echo "ci:test OK"
