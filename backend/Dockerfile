ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/oven/bun:1.3.13

WORKDIR /app

# Build context is the repo root so monorepo packages are reachable.
# Copy backend deps first for layer caching
COPY backend/package.json backend/bun.lock ./

RUN bun install --frozen-lockfile

# Copy monorepo service-client packages as siblings — tsconfig paths
# resolve "@fr/service-client-*" to ../packages/service-clients/*/src/index.ts,
# so from /app this must be /packages/service-clients/*
COPY packages /packages

# Copy backend source last (changes most often)
COPY backend/README.md ./
COPY backend/src ./src
COPY backend/migrations ./migrations
# ⛔ NOT OPTIONAL, AND NOT A DEV CONVENIENCE. The one-time operator repairs in
# here (e.g. scripts/repair-legacy-deblock-delivered-stamp.ts, merged in #1088)
# document themselves as "run it inside the fr-backend pod, which carries
# DATABASE_URL and the Planka credentials" — and that instruction was
# unrunnable, because this directory has never been in any image. Verified in the
# running pod 2026-09-11: /app/scripts did not exist, and / is a read-only
# filesystem, so it could not be staged at runtime either. A merged repair
# nobody can execute is not a repair.
#
# Placement is load-bearing: the scripts import '../src/...', so /app/scripts
# resolves to /app/src. This is a single-stage build, so a COPY here IS the final
# image — there is no runtime stage that has to carry it forward. Nothing in
# .dockerignore excluded scripts/; the omission was an omission. (Its **/*.md and
# **/tests rules still apply inside the directory.)
COPY backend/scripts ./scripts
COPY backend/index.ts backend/tsconfig.json backend/drizzle.config.ts backend/bunfig.toml ./

RUN mkdir -p uploads

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD bun run -e "fetch('http://localhost:8888/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

CMD ["bun", "run", "start"]
