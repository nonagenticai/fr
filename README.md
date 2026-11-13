# FR — Control Plane & Communication Hub

[![CI](https://github.com/nonagenticai/fr/actions/workflows/ci.yml/badge.svg)](https://github.com/nonagenticai/fr/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nonagenticai/fr)](https://github.com/nonagenticai/fr/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

FR is the portal, control plane and communication hub for an autonomous-agent
workflow system built on n8n and Planka. Humans and agents use it to submit and
govern projects, manage a multi-dimensional asset library, run card lifecycles,
converse with agents over AG-UI, reason with Theory-of-Constraints trees, and fan
notifications out across channels. It is multi-tenant by design.

This repository is the source of a production system, published as a snapshot.
The estate-specific deployment (Kubernetes manifests, Flux, private registries)
is intentionally not included: everything here builds, lints and tests on a
stock machine with Docker.

## What's inside

| Path | What |
|---|---|
| `backend/` | Bun + TypeScript API. Unversioned routes under `/api/<resource>`, Drizzle ORM over PostgreSQL 18, Redis, Zod validation, an OpenAPI document derived from the capability registry, and the AG-UI agent protocol. |
| `frontend/` | SvelteKit 5 / Svelte 5 runes UI: dashboard, kanban, asset library, knowledge graph, decisions, channels, approvals, governance, admin metering. |
| `packages/service-clients/` | Typed clients for the services FR integrates with (artifacts, kag, kanban, n8n, requirements, secrets, workers). |
| `tooling/openapi/` | OpenAPI snapshots, client generation, and drift baselines. |

## Stack

- **Backend**: Bun 1.3, TypeScript, Drizzle ORM, PostgreSQL 18, Redis 7.
- **Frontend**: SvelteKit 5, Svelte 5 runes, Tailwind CSS, Vite, Vitest.
- **Auth**: Keycloak (OIDC, JWT validation). An optional licence-token
  introspection path exists for machine callers and is disabled when
  `LICENSES_URL` is empty (the default here).

## Local development

Prerequisites: Bun 1.3.13, Node 26, Docker.

```bash
# Postgres 18 + Redis 7
docker compose up -d

# Backend
cd backend
bun install --frozen-lockfile
bun run ci:verify      # static checks, no database needed
bun run ci:test        # unit + integration suites against the compose services

# Frontend
cd ../frontend
npm ci
npm run check          # svelte-check
npm run test           # vitest
npm run build
```

`backend/scripts/ci-test.sh` creates its own seed schema and a fresh database
for the integration tree on the same Postgres server, so the compose database
only needs to be disposable.

To run the API itself: `cd backend && cp .env.example .env` (fill in the
required values) and `bun run start`. It listens on port 8888. The frontend dev
server is `npm run dev` in `frontend/`.

## Configuration

All configuration is environment-driven. The important groups:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | OIDC issuer + confidential client |
| `LICENSES_URL` | Optional. Enables licence-token introspection; empty = path disabled |
| `N8N_*`, `PLANKA_*`, `KAG_*`, `CODING_*`, `REQUIREMENTS_API_URL`, `ARTIFACTS_*`, `SECRETS_*`, `WORKERS_API_URL`, `BILLING_BASE_URL` | Integrations. In development an empty URL disables the integration; production boots only when the configured set is present. |

See `backend/.env.example` and `frontend/.env.example` for the full list. The
service clients commit their OpenAPI snapshots, so client generation does not
need a live service.

## Tests

- `backend`: `bun run ci:verify` runs the static gates (types, OpenAPI
  coverage, migration checks, secret-usage guards). `bun run ci:test` runs the
  unit, auth, source and integration suites against disposable Postgres 18 +
  Redis.
- `frontend`: `npm run test` (Vitest) and `npm run check` (svelte-check).
- Playwright lanes under `frontend/e2e/` are opt-in and require a running
  stack; they are not part of the default test run.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).

The upstream Planka and n8n projects keep their own licences; this repository
only contains code written for FR.

## Security

Report vulnerabilities privately through the repository's Security tab — see
[`SECURITY.md`](SECURITY.md). Do not open a public issue for a security problem.

## Contributing

Issues and pull requests are welcome. See
[`CONTRIBUTING.md`](https://github.com/nonagenticai/.github/blob/main/CONTRIBUTING.md) for the
organisation-wide rules; setup, test and lint commands are in this README. Commits carry DCO
sign-off.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
