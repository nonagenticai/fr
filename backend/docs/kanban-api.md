# Kanban API (FR Backend)

This module provides HTTP + WebSocket access to the underlying Planka boards,
scoped to the caller's active fr TENANT. It is trimmed to the conveyor
operations (George 2026-10-10); users edit their board in their own Planka. Every frontend (Svelte UI, Signal
node, MS Teams, future agents) consumes this same API — FR never exposes Planka
directly.

## Authentication

All endpoints under `/api/kanban/*` and `/api/projects/*` require a Keycloak
Bearer token in the `Authorization` header. fr acts in Planka as ONE configured
account (`PLANKA_AGENT_*`; per tenant, not per user) and runs its own tenant
gate on every route BEFORE any Planka write — a board/card/list of another
tenant answers 404.

```bash
export KC_TOKEN="eyJhbGciOi..."        # Keycloak access token
export FR_BASE="https://fr.example.com"   # or http://localhost:3000 in dev
AUTH=(-H "Authorization: Bearer $KC_TOKEN")
```

All `curl` examples below assume `KC_TOKEN` and `FR_BASE` are exported and use
the `AUTH` array above.

## Error envelope

Planka-layer failures are mapped to FR's standard JSON error shape:

```json
{ "error": "<short tag>", "message": "<human message>", "details": <optional> }
```

| Planka error           | HTTP | `error` tag        |
| ---------------------- | ---- | ------------------ |
| PlankaNotFoundError    | 404  | `Not found`        |
| PlankaValidationError  | 400  | `Validation error` (with `details.fields`) |
| PlankaForbiddenError   | 403  | `Forbidden`        |
| PlankaAuthError        | 401  | `Unauthorized`     |
| Other PlankaError      | 502  | `Upstream error`   |

Zod body-validation failures return `400` with the Zod issue list under
`details`.

## Reads (no side effects)

### GET /api/kanban/boards

List every board the caller can see.

```bash
curl "${AUTH[@]}" "$FR_BASE/api/kanban/boards"
```

### GET /api/kanban/boards/:boardId

Full board detail: lists, cards, labels, memberships (single fan-out call).

### GET /api/kanban/cards/:cardId

Full card detail: comments, tasks (with task-lists), labels, members.

### GET /api/projects/:projectId/kanban

Returns the board linked to the given FR project (resolved via
`projects.planka_board_id`). Useful when the caller has the FR project id but
not the Planka board id.

## Projects

### POST /api/projects

Creates an FR project **and** a Planka project + board + the lists, labels
and custom-field groups of the tenant's RM board template. It creates **no
card** (George 2026-10-12: fr is a facilitator; n8n's `trigger.conveyor_start`
creates the first card after the `project.created` start webhook). Lives in `routes/projects.ts`, not kanban, because it writes to
both the FR DB and Planka.

Body: `ProjectCreateSchema` (see `src/types/api.ts`). Key fields:
`name`, `description?`, `repository_url`, `branch?`, `secret_id?`, `repo?`.

Response:

```json
{
  "id": "<fr-project-uuid>",
  "planka_project_id": "<planka-project-id>",
  "planka_board_id": "<planka-board-id>",
  "planka": { "boardId": "..." },
  "...": "standard project fields"
}
```

## Card writes

WS event kinds given next to each endpoint fire on success.

### POST /api/kanban/lists/:listId/cards  →  `card_created`

```json
{ "name": "...", "description"?: "...", "position"?: 65535,
  "dueDate"?: "2026-05-01T00:00:00Z", "type"?: "project" | "story" }
```

```bash
curl "${AUTH[@]}" -X POST "$FR_BASE/api/kanban/lists/$LIST/cards" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ship v1","position":65535}'
```

### PATCH /api/kanban/cards/:cardId  →  `card_updated`

```json
{ "name"?: "...", "description"?: "..."|null,
  "dueDate"?: "..."|null, "isClosed"?: true }
```

### POST /api/kanban/cards/:cardId/move  →  `card_moved`

```json
{ "listId": "<target-list>", "position": 32768 }
```

### POST /api/kanban/cards/:cardId/duplicate  →  `card_duplicated`

```json
{ "name"?: "Copy of ..." }
```

### DELETE /api/kanban/cards/:cardId  →  `card_deleted`

## Comments

### GET /api/kanban/cards/:cardId/comments
### POST /api/kanban/cards/:cardId/comments  →  `comment_created`

```json
{ "text": "LGTM, merging." }
```


## Labels

Attach/detach an EXISTING label of the card's own board (another board's label → 404).

### POST /api/kanban/cards/:cardId/labels/:labelId  →  `label_attached`
### DELETE /api/kanban/cards/:cardId/labels/:labelId  →  `label_detached`

## WebSocket

```
wss://<host>/api/kanban/ws?token=<keycloak-access-token>
```

The token is passed as a query parameter because browser `WebSocket` can't set
custom headers. It's validated against Keycloak exactly like the Bearer header.

On open, the client is auto-subscribed to `kanban:all`. Additional scoped
subscriptions:

```json
{ "type": "subscribe", "boardId": "<id>" }
{ "type": "subscribe", "cardId": "<id>" }
{ "type": "subscribe", "kanbanAll": true }
```

`unsubscribe` uses the same fields. `{ "type": "ping" }` → `{ "type": "pong" }`.

Event envelope:

```json
{
  "type": "kanban:<event-kind>",
  "event": { "kind": "<event-kind>", "...": "kind-specific fields" },
  "timestamp": "2026-04-21T10:12:04.318Z"
}
```

Every event carries the ids needed to correlate with local state. Events that
mention a `boardId` are fanned out on `kanban:board:<boardId>`, events with
`cardId` are fanned out on `kanban:card:<cardId>`, and everything hits
`kanban:all`.

### Event kinds

- Cards: `card_created`, `card_updated`, `card_moved`, `card_duplicated`, `card_deleted`
- Comments: `comment_created`, `comment_mentioned`
- Labels: `label_attached`, `label_detached`

Canonical union lives in `src/services/websocket-manager.ts` as `KanbanEvent`.
