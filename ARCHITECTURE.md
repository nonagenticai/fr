# FR Architecture

## Overview

FR is the portal and communication hub for an autonomous-agent workflow system.
It provides project submission, approval workflows, status dashboards, an asset
library, and multi-channel notification fan-out. Agents reach the same operations
through the AG-UI protocol that humans reach through the browser.

```
                    +------------------+
                    |   FR Frontend    |
                    |   (SvelteKit 5)  |
                    +--------+---------+
                             |  REST + WebSocket
                    +--------+---------+
                    |   FR Backend     |
                    | (Bun/TypeScript) |
                    |   port 8888      |
                    +--------+---------+
                             |
        +--------------------+--------------------+
        |                    |                    |
 +------+------+      +------+------+      +------+------+
 | PostgreSQL  |      |   Redis     |      |  Keycloak   |
 |  (18)       |      |  (cache)    |      |  (OIDC)     |
 +-------------+      +-------------+      +-------------+
                             |
        +--------------------+--------------------+
        |                    |                    |
 +------+------+      +------+------+      +------+------+
 |    n8n      |      |   Planka    |      |    KAG      |
 | (workflows) |      |  (kanban)   |      | (documents) |
 +-------------+      +-------------+      +-------------+
```

In development every service behind FR is optional: its base URL is read from
the environment, and an empty URL disables that integration. The core (database,
Redis, Keycloak) is required. In production FR refuses to boot until the
configured service URLs are present; the deployment supplies them.

## Components

| Path | Responsibility |
|---|---|
| `backend/src/routes/**` | HTTP surface. Routes are unversioned: `/api/<resource>`, never `/api/v1/`. |
| `backend/src/capabilities/**` | Capability registry and the OpenAPI document derived from it. |
| `backend/src/agui/**` | Action registry, RBAC, approvals and the AG-UI wire protocol. |
| `backend/src/domain/**` | Approval, engagement and notification domain logic. |
| `backend/src/integrations/**` | Typed clients for n8n, Planka, KAG and the sibling services. |
| `frontend/src/routes/**` | SvelteKit pages: dashboard, kanban, library, knowledge, decisions, channels, governance, admin. |
| `packages/service-clients/**` | Generated, typed clients for the sibling service APIs. |

## Multi-tenancy

Requests carry a tenant identity. Database access is tenant-scoped, and the
service clients forward the tenant header. A super-admin can switch the active
workspace with `X-Active-Tenant`; upstreams that resolve the tenant from the
token rather than the forwarded header are refused with a
`409 tenant_context_conflict` instead of silently acting in another workspace.

## Authentication

- **Humans and browsers**: Keycloak OIDC. The frontend is a public PKCE client;
  the backend validates JWTs against the realm's JWKS.
- **Machine callers**: Keycloak client credentials, or — when `LICENSES_URL` is
  configured — an opaque licence token that FR introspects against the licences
  service and binds to that licence's tenant. With `LICENSES_URL` empty (the
  public default) the licence path is off and a non-JWT bearer is rejected.
- **Authorization**: realm roles and per-action RBAC in the AG-UI registry.
  Super-admin is a realm role read from the signed token; it is not an
  environment allowlist.

## Integrations

### FR → n8n

FR submits project intake and approval decisions to n8n webhooks. The outbound
payload carries the FR project id, card id where relevant, and the decision
metadata.

### n8n → FR

n8n calls FR back on `/api/webhooks/n8n/*` (approval requests, status updates,
computed checks). These routes are service-authenticated; a browser session
cannot mint an approval.

### FR → Planka

FR reads and writes boards, cards, comments and members through Planka's HTTP
API. Per-user credentials are stored encrypted; the agent account is a separate
service account.

### FR → KAG (documents)

Customer document uploads are virus-scanned before they are parsed or indexed.
FR does not run a scanner itself — enforcement lives downstream in the ingestion
service and is fail-closed: an unreachable scanner rejects the upload.

```
customer (browser)
  -> POST /api/documents/upload        (multipart; type + size validation)
  -> integrations/kag.ts uploadDocument()
  -> KAG gateway  POST /ingest/documents
  -> ingestion service  POST /ingest
       scan -> parse -> (optional) graph ingestion
```

The upload is not written to FR's disk: bytes stay in memory for the request
and stream to KAG. The `documents` row stores metadata and the ingestion id, not
a file path.

## AG-UI substrate

The action registry — not the HTTP router — is the single agent-callable
surface. HTTP routes and inbound channel webhooks are thin adapters that build
an `ActionContext` and call `invokeAction`.

| Concern | Where |
|---|---|
| Telemetry span helper | `backend/src/telemetry/spans.ts` |
| Request context (correlation, initiator, channel, tenant) | `backend/src/middleware/request-context.ts`, `backend/src/integrations/_lib/context.ts` |
| Idempotency store | `backend/src/services/idempotency.ts` |
| Action registry (`registerAction`, `invokeAction`, schema validation at registration) | `backend/src/agui/registry.ts`, `backend/src/agui/types.ts` |
| Action-approval bus (pending → approved → executing → done/failed) | `backend/src/services/action-approvals.ts` |
| Notification channels (`sendMessage(ChannelMessage)`) | `backend/src/domain/engagement/notifications.ts` and adapters |
| Inbound channel dispatch (identity → intent → action) | `backend/src/channels/*`, `backend/src/agent-core/*` |
| AG-UI wire protocol (`POST /api/agui/invoke`, NDJSON streaming) | `backend/src/routes/agui.ts` |
| Per-action RBAC (`assertRbac`) | `backend/src/agui/rbac.ts` |
| Agent-session token refresh (rotation + replay-detection revocation) | `backend/src/services/agent-session.ts`, `backend/src/routes/agui-session.ts` |

An action invocation flows:

```
HTTP route / channel dispatcher / agent NDJSON
        |
        v  build ActionContext { userId, projectId, correlationId, initiator, channel, tenantRoles }
invokeAction(name, input, ctx)
        |
        +- assertRbac(action.rbac, ctx, input)
        +- emitSpan('action.invoke', ...)
        +- read  -> runIdempotent(key, ttl, handler)
        +- write -> ApprovalBackend.enqueue(...) -> PendingAction
```

## Channel adapters

Every outbound adapter implements `sendMessage(ChannelMessage)` and renders the
message kind (`text`, `approval-request`, `action-result`, `action-error`).
Every channel that can carry a decision goes through one shared reply-to-decision
module (`domain/engagement/channel-reply.ts`), which writes through the same
`recordApprovalDecision` function the web route uses. The dispatcher is
env-gated; when disabled, channel webhook routes run unchanged.

## Data stores

- **PostgreSQL 18**: projects, cards, approvals, decisions, documents,
  engagement deliveries, agent sessions, idempotency keys, and tenant-scoped
  domain tables. Schema: `backend/src/db/schema.ts`; migrations:
  `backend/migrations/`.
- **Redis**: cache and short-lived coordination state.
