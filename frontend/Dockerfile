# Build stage
ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/node:26-alpine AS builder

# Build arguments for Vite (these become env vars during build)
ARG VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID
ARG VITE_KAG_URL
ARG VITE_CODE_GRAPH_URL
ARG VITE_ORCHESTRATOR_URL
ARG VITE_LICENSES_URL
ARG VITE_AUTH_BYPASS
# Optional heap ceiling for `vite build` (an ARG is visible to RUN as an env
# var). Unset in CI = unchanged. Raise it for a local image build, because a
# small Docker Desktop VM (1 GiB) OOMs the build at node's default heap limit.
ARG NODE_OPTIONS

# Export as environment variables for Vite
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_KAG_URL=$VITE_KAG_URL
ENV VITE_CODE_GRAPH_URL=$VITE_CODE_GRAPH_URL
ENV VITE_ORCHESTRATOR_URL=$VITE_ORCHESTRATOR_URL
ENV VITE_LICENSES_URL=$VITE_LICENSES_URL
ENV VITE_AUTH_BYPASS=$VITE_AUTH_BYPASS

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for build)
#
# `npm ci` is NOT sufficient on its own, and this is the failure it hides.
# Vite 8 bundles with rolldown, whose platform binding ships as a set of
# OPTIONAL dependencies gated on os/cpu/libc — on this base image that is
# `@rolldown/binding-linux-x64-musl`. npm treats a failure to fetch an OPTIONAL
# dependency as non-fatal: it prints nothing useful and **exits 0**. The build
# then runs to the next layer and dies inside `npm run build` with
# `Cannot find module '@rolldown/binding-linux-x64-musl'`, which reads as a
# code fault in a layer that has nothing to do with the cause.
#
# That is exactly what happened to `main` on 2026-08-18: run 32108539615 failed
# this way, `Deploy & Smoke Test` and `Promote to Latest` were skipped, and PR
# #828 sat merged-but-not-deployed for hours while the SERVED bundle still
# carried the literal the PR existed to delete. The same commit had built green
# on its own branch 23 minutes earlier, so nothing in the source had changed —
# a transient registry read is enough to produce it.
#
# The binding name follows the BUILD platform (`process.arch`): x64 in CI
# (`@rolldown/binding-linux-x64-musl`, unchanged), arm64 for a local build on
# Apple silicon, where a hardcoded x64 name made the
# check fail a correct install.
#
# So assert the binding is actually on disk, in the same layer that installed
# it. A missing binding now fails HERE, naming itself, instead of four layers
# and (on a saturated runner) four hours later.
RUN npm ci && \
    node -e "require.resolve('rolldown')" && \
    node -e "const b='@rolldown/binding-linux-'+process.arch+'-musl';try{require(b)}catch(e){console.error('\nFATAL: npm ci exited 0 but the rolldown native binding for this platform is absent.\nThis is npm silently tolerating a failed OPTIONAL dependency, not a source fault.\nRe-run the build; if it recurs, the npm registry is failing to serve\n'+b+'.\n');process.exit(1)}"

# Copy documentation
COPY README.md ./

# Copy source code
COPY . .

# Run prepare script for SvelteKit sync
RUN npm run prepare

# Build the application
RUN npm run build

# Production stage
FROM ${BASE_REGISTRY}/library/node:26-alpine

WORKDIR /app

# Copy built application + custom server that proxies /api/* (HTTP+WS)
# to fr-backend in-cluster.
COPY --from=builder /app/build ./build
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Health check using node-based HTTP check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the custom Node server (SvelteKit handler + /api/* proxy)
CMD ["node", "server.js"]
