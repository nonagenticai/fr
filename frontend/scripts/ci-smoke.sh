#!/usr/bin/env bash
# The ts-service archetype's `build_smoke` for fr-frontend: start the PUSHED
# image ($IMAGE_REF) and require GET / to answer 200 from inside the container.
#
#   IMAGE_REF=<image> bash scripts/ci-smoke.sh
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF must name the image to smoke}"
FE="fr-frontend-smoke-$$-${RANDOM}"
trap 'docker rm -f "$FE" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$FE" "$IMAGE_REF" >/dev/null

PROBE="require('http').get('http://127.0.0.1:3000/', r => { console.log(r.statusCode); process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"
for i in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$FE" 2>/dev/null)" != "true" ]; then
    echo "::error::fr-frontend exited during boot"; docker logs "$FE" 2>&1 | tail -60; exit 1
  fi
  if docker exec "$FE" node -e "$PROBE"; then
    echo "fr-frontend / OK after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "::error::fr-frontend / did not answer 200 within 60s"
docker logs "$FE" 2>&1 | tail -60
exit 1
