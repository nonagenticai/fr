#!/usr/bin/env bash
# CI must never authenticate against production Keycloak. Scans every place a
# CI backend-runtime environment is declared: the workflows and the ci-*.sh
# scripts the archetype runs. VITE_KEYCLOAK_URL is the browser bundle's public
# value and is exempt. Use https://auth.invalid (RFC 6761 reserved) in CI.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

existing=()
for t in .github/workflows backend/scripts/ci-*.sh frontend/scripts/ci-*.sh; do
  [ -e "$t" ] && existing+=("$t")
done
if [ "${#existing[@]}" -eq 0 ]; then
  echo "::error::check-ci-no-prod-keycloak: no scan targets exist — refusing to pass vacuously"
  exit 2
fi

set +e
hits=$(grep -rnE '(^|[^A-Z_])KEYCLOAK[A-Z_]*URL[=:][[:space:]]*"?https://[^"[:space:]]*nonagentic\.ai' \
  "${existing[@]}" | grep -v 'VITE_KEYCLOAK_URL')
set -e
if [ -n "$hits" ]; then
  echo "$hits"
  echo "::error::A backend-runtime KEYCLOAK_URL above points at production Keycloak."
  echo "CI must never mint client_credentials against the live realm — use https://auth.invalid."
  exit 1
fi
echo "ok: no CI backend-runtime KEYCLOAK_URL targets a nonagentic.ai host (${existing[*]})"
