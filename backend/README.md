# FR Backend - TypeScript/Bun

**Version**: 1.0.0
**Stack**: TypeScript + Bun + Drizzle ORM + PostgreSQL + Redis
**Port**: 8888
**Architecture**: Thin proxy layer to orchestrator and Code Graph Helper

## Overview

The FR Backend is a thin API proxy that:
- Provides REST API matching frontend expectations
- Handles Keycloak JWT authentication
- Manages secrets with AES-256-GCM encryption
- Proxies to orchestrator for workflow execution
- Proxies to Code Graph Helper for quality data
- Integrates with KAG for document processing

## Quick Start

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env

# Setup database
bun run db:push

# Start development server
bun run dev
```

## API Endpoints

### Projects (`/api/projects`)
- POST - Create project
- GET - List projects
- GET /:id - Get project
- DELETE /:id - Delete project
- GET /:id/status - Get status

### Project repositories (`/api/projects/:id/repositories`, since 2026-05-27)
Multi-repo per project. The N:M `project_repositories` join (migration 072) sits on top of the existing `repositories` table; `projects.repository_url / branch / container_name` stay as the denormalised primary so every existing reader keeps working unchanged.
- GET `/api/projects/:id/repositories` — list, primary first; surfaces `primary_repository_id`
- POST `/api/projects/:id/repositories` — attach existing (`{repo_id}`) or create-or-attach (`{url, branch?, name?}`); idempotent via the `(user_id, url)` unique + `(project_id, repo_id)` PK
- DELETE `/api/projects/:id/repositories/:repo_id` — refuses the current primary with `409` (promote a replacement first)
- PUT `/api/projects/:id/repositories/:repo_id/primary` — transactional partial-unique swap + re-stamp the project's denormalised cache columns

Attach + primary-promote hop to requirements_management's `GET /architecture/containers/{name}?projectId=` validator: attach is **soft** (404 → `201 + warning`); promote is **hard** (404 → `409 container_not_bound_to_project`; no container_name → `422 repository_not_provisioned`). 60s TTL keyed `(tenantId, projectId, containerName)`.

### Secrets (`/api/v1/secrets`)
- GET - List secrets
- POST - Create secret
- PUT /:id - Update secret
- DELETE /:id - Delete secret

### Documents (`/api/v1/documents`)
- POST /upload - Upload document
- GET /:id/status - Get status
- GET /projects/:id/documents - List documents

### Quality (`/api/v2`) - Proxy to Code Graph Helper
- GET /architecture/graph/:container
- GET /quality/:container/gate
- GET /dependencies/:container/report
- POST /dependencies/:container/scan
- WS /quality/ws/:container

## Environment Variables

See `.env.example` for full configuration. Required:
- `DATABASE_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `KEYCLOAK_URL` - Authentication server
- `SECRET_ENCRYPTION_KEY` - 32-byte key

## Development

```bash
bun run dev      # Start with hot reload
bun test         # Run tests
bun run db:studio # View database
```

## Docker

```bash
docker build -t fr-backend .
docker run -p 8888:8888 --env-file .env fr-backend
```

For complete documentation, see `backend_implementation.md`
