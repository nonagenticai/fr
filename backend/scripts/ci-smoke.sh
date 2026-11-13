#!/usr/bin/env bash
# The ts-service archetype's `build_smoke` for fr-backend: boot the PUSHED image
# ($IMAGE_REF) against a throwaway postgres:18 + redis and require GET /health
# to answer 200. Boot applies the SQL migrations itself; drizzle-kit push lays
# the baseline schema they assume.
#
#   IMAGE_REF=<image> bash scripts/ci-smoke.sh
#
# Networking is the pattern the old ci-cd.yaml deploy-and-test job ran for
# months: every container on --network=host, postgres published on
# 127.0.0.1:<random>, redis on a high port. A user-defined bridge network hung
# drizzle-kit push at "Pulling schema" on the ARC dind runners (fr#1672), even
# with MTU 1230. Each runner pod is its own netns, so host ports cannot collide
# across runs.
#
# PG_IMAGE / REDIS_IMAGE default to the public images CI uses.
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF must name the image to smoke}"
REGISTRY="${REGISTRY:-docker.io}"
PG_IMAGE="${PG_IMAGE:-${REGISTRY}/library/postgres:18}"
REDIS_IMAGE="${REDIS_IMAGE:-${REGISTRY}/library/redis:7-alpine}"
REDIS_PORT="${REDIS_PORT:-63799}"
BACKEND_PORT="${BACKEND_PORT:-8888}"

TAG="fr-smoke-$$-${RANDOM}"
PG="${TAG}-pg"
REDIS="${TAG}-redis"
BE="${TAG}-backend"
PUSH="${TAG}-push"

cleanup() {
  docker rm -f "$PUSH" "$BE" "$REDIS" "$PG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$PG" -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fr \
  "$PG_IMAGE" >/dev/null
docker run -d --name "$REDIS" --network=host "$REDIS_IMAGE" \
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 >/dev/null

PG_PORT=""
for i in $(seq 1 30); do
  PG_PORT="$(docker port "$PG" 5432/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}')"
  [ -n "$PG_PORT" ] && break
  sleep 0.5
done
[ -n "$PG_PORT" ] || { echo "::error::could not resolve the smoke postgres host port"; exit 1; }
DB_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/fr?sslmode=disable"

# Probe over TCP: postgres' init phase runs a socket-only temp server that a
# socket probe already reports as ready.
for i in $(seq 1 60); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres -d fr -q && break
  [ "$i" -eq 60 ] && { echo "::error::smoke postgres not ready in 60s"; docker logs "$PG" 2>&1 | tail -30; exit 1; }
  sleep 1
done

echo "=== baseline schema (drizzle-kit push, from the image) ==="
# Retried: the published port can lag pg_isready inside the container, and
# drizzle-kit then exits 1 at "Pulling schema" with no error. Bounded, and
# --init + -k so the timeout really stops the container.
pushed=0
for attempt in 1 2 3 4 5; do
  if timeout -k 10 120 docker run --rm --init --name "$PUSH" --network=host \
       -e DATABASE_URL="$DB_URL" --entrypoint sh "$IMAGE_REF" \
       -c 'cd /app && echo y | bunx drizzle-kit push'; then
    pushed=1; break
  fi
  docker rm -f "$PUSH" >/dev/null 2>&1 || true
  echo "::warning::smoke drizzle-kit push attempt ${attempt} failed; retrying in 3s"
  sleep 3
done
[ "$pushed" -eq 1 ] || { echo "::error::smoke drizzle-kit push failed after 5 attempts"; docker logs "$PG" 2>&1 | tail -30; exit 1; }

echo "=== boot $IMAGE_REF ==="
docker run -d --name "$BE" --network=host \
  -e DATABASE_URL="$DB_URL" \
  -e REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
  -e KEYCLOAK_URL=https://auth.invalid \
  -e KEYCLOAK_REALM=fr \
  -e KEYCLOAK_CLIENT_ID=fr-backend \
  -e KEYCLOAK_CLIENT_SECRET=ci-placeholder \
  -e SECRET_ENCRYPTION_KEY=ci-test-key-0000000000000000000000000000000000000000000000000000 \
  -e JWT_SECRET_KEY=ci-test-jwt-000000000000000000000000000000000000000000000000000 \
  -e PORT="$BACKEND_PORT" -e HOST=127.0.0.1 \
  -e N8N_WEBHOOK_URL=http://n8n.invalid:5678/webhook \
  -e PLANKA_AGENT_PASSWORD=ci-smoke \
  -e ARTIFACTS_DOWNLOAD_SIGNING_KEY=ci-smoke-signing-key-00000000000000000000000000 \
  -e N8N_API_KEY=ci-smoke \
  -e N8N_WEBHOOK_SECRET=ci-smoke \
  "$IMAGE_REF" >/dev/null

PROBE="fetch('http://127.0.0.1:${BACKEND_PORT}/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) }).catch(() => process.exit(1))"
for i in $(seq 1 90); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$BE" 2>/dev/null)" != "true" ]; then
    echo "::error::fr-backend exited during boot"; docker logs "$BE" 2>&1 | tail -80; exit 1
  fi
  if docker exec "$BE" bun -e "$PROBE"; then
    echo "fr-backend /health OK after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "::error::fr-backend /health did not answer 200 within 90s"
docker logs "$BE" 2>&1 | tail -80
exit 1
