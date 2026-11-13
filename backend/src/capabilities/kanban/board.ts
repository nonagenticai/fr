// fr-agui SPEC §13 P4d-2b — spec drain, the kanban group: fr's Planka proxy `/api/kanban/*`
// (routes/kanban/*) and the kanban-WS liveness read `/api/tools/kanban/liveness`
// (routes/tools/kanban.ts), re-expressed with NO behaviour change (`legacyHandler`).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// Two of these routes were already in the served spec (the `src/openapi.ts` literal):
// `POST /api/kanban/cards/:cardId/move` (moveKanbanCard, on the licence route allowlist —
// n8n-nodes-fr `kanban.moveCard`) and `POST /api/kanban/cards/:cardId/break-glass-done`
// (breakGlassDoneKanbanCard). Their literal operations move here VERBATIM (`openapi.frozen`,
// SPEC §3.3: operationId and body byte-identical; the literal keeps only the position marker).
// Neither needs an edit: move declares its 400 (a non-JSON body is the pipeline's 400) and is
// allowlisted (no licence-door 403); break-glass declares 400 and 403. The other twelve are
// NEW operations (operationId = camelCase(id)), formerly pinned in LEGACY_UNDECLARED.
//
// Gates, as the handlers run them (the declared rule is the bar BEFORE the handler logic):
//   * validateAuth / validateAuthWithToken — the licence route door (a licence bearer reaches
//     only the allowlisted move) and the conveyor write door — `isAuthenticatedUser`;
//   * then fr's TENANT gate, before any Planka call (routes/kanban/_gate.ts,
//     lib/board-tenant-access.ts): a card / list / board outside the caller's active tenant is
//     the SAME 404 as a missing one (never 403). A SERVICE identity (n8n-nodes-fr) is gated on
//     the tenant DERIVED from the card's board (lib/service-card-tenant.ts). That is a
//     resource gate (the answer is 404), not the declared rule;
//   * break-glass: the `super_admin` realm role (403 'super-admin only').
// The JSON-body writes parse the body FIRST (before the tenant gate, so before any read):
// a non-JSON body is the pipeline's 400 `invalid JSON body` (break-glass answers its own 400
// 'Invalid JSON body'; duplicate's `JSON.parse` SyntaxError is fr's 500 — measured).
//
// None is agent-exposed (`out-of-agent-scope`): the project agent reaches cards through its
// own hand-written actions (agui/actions/kanban-*.ts), unchanged.
import { z } from 'zod';

import { defaultConfirm, defineCapability, type Capability } from '../define';
import { lazyHandler } from '../lazy';
import { isAuthenticatedSuperAdmin, isAuthenticatedUser } from '../rbac-rules';
import { standardResponses } from '../account/_shared';
import { routeRule, settingsCapabilities } from '../settings/_shared';

const rule = routeRule(isAuthenticatedUser);
const superAdmin = routeRule(isAuthenticatedSuperAdmin);

const ROUTES = (m: string, load: () => Promise<Record<string, unknown>>) => ({ module: `src/routes/${m}.ts`, load });
const READS = ROUTES('kanban/reads', () => import('../../routes/kanban/reads'));
const COMMENTS = ROUTES('kanban/comments', () => import('../../routes/kanban/comments'));
const CARDS = ROUTES('kanban/cards', () => import('../../routes/kanban/cards'));
const LABELS = ROUTES('kanban/labels', () => import('../../routes/kanban/labels'));
const BREAK_GLASS = ROUTES('kanban/break-glass-done', () => import('../../routes/kanban/break-glass-done'));
const TOOLS = ROUTES('tools/kanban', () => import('../../routes/tools/kanban'));

const cardId = z.string().min(1).describe('Planka card id');
const listId = z.string().min(1).describe('Planka list id');
const boardId = z.string().min(1).describe('Planka board id');
const labelId = z.string().min(1).describe('Planka label id (one of the card board\'s own labels)');

const GATE_404 =
  "404: `error` 'Not found' / 'Card not found' / 'Label not found' — the card, list or board is not in the caller's active " +
  'tenant (or not a platform board), does not exist, or (a service identity) its asserted tenant differs from the one ' +
  'derived from the board: indistinguishable on purpose. ';
const PLANKA =
  "Planka failing: `error` / `message` (client-safe text; `details` = Planka's `problems` for a validation refusal) with its " +
  'status mapped — 400, 401, 403, 404, 409, 422, 429, or 502 (Planka unreachable / 5xx). ';
const ZOD_422 = "422: `error` 'Validation error' (`details`: the zod issues) — the body fails the schema. ";
const NON_JSON = "400: `error` 'invalid JSON body' (the body is not JSON; nothing read or written). ";
const GHERKIN =
  '400: a malformed `gherkin_scenarios` entry in `description` (`code`; refused, never stripped — fr#1338). ';

/** A Planka item as Planka answers it (fr passes it through). */
const plankaItem = (what: string) => z.object({ id: z.string() }).passthrough().describe(`The Planka ${what}, as Planka returns it.`);

const label = z.object({ id: z.string(), name: z.string().nullable(), color: z.string(), boardId: z.string() });
const boardCard = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  listId: z.string(),
  boardId: z.string(),
  position: z.number().nullable(),
  dueDate: z.string().nullable(),
  stopwatch: z.unknown().nullable(),
  labels: z.array(label),
  memberIds: z.array(z.string()),
  card_type: z.string().nullable().describe("Metadata.card_type (null when the card carries none: 'Unclassified')."),
  card_group: z.string().nullable().describe("The card type's RM capability in the board OWNER tenant's catalogue, else null."),
});

const NEW: ReadonlyArray<Capability<unknown, unknown>> = [
  ...settingsCapabilities({ area: 'kanban', tag: 'Kanban', tenancy: 'tenant', rule, ...READS }, [
    {
      id: 'kanban.list_boards', method: 'GET', path: '/api/kanban/boards', handler: 'handleListBoards',
      summary: "The Planka boards of the caller's active tenant (project- and stream-backed)", effect: 'read',
      description:
        "Tenant: a super_admin's accepted X-Active-Tenant, else the request tenant, else the JWT one; none resolvable is " +
        '`{ items: [], total: 0 }` without calling Planka. A board with no fr project / active stream row is shown to nobody.',
      input: z.object({}),
      output: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            projectId: z.string().describe('The Planka project id.'),
            projectName: z.string().describe("'Unknown' when Planka did not include it."),
            position: z.number().nullable(),
            frProjectId: z.string().nullable().describe('The fr project the board belongs to, when the caller can read it; else null.'),
          }),
        ),
        total: z.number().int(),
      }),
      responses: standardResponses(PLANKA),
    },
    {
      id: 'kanban.get_board', method: 'GET', path: '/api/kanban/boards/:boardId', handler: 'handleGetBoard',
      summary: 'A board with its user-visible lists, cards (with labels, members and card type) and labels', effect: 'read',
      input: z.object({ boardId }),
      output: z.object({
        board: z.object({ id: z.string(), name: z.string(), projectId: z.string(), position: z.number().nullable() }),
        lists: z.array(z.object({ id: z.string(), name: z.string().nullable(), boardId: z.string(), position: z.number().nullable() })),
        cards: z.array(boardCard),
        labels: z.array(label),
      }),
      responses: standardResponses(
        GATE_404 + "404 `code` 'board_deleted_upstream': fr names the board but Planka no longer has it. " + PLANKA,
      ),
    },
    {
      id: 'kanban.get_card', method: 'GET', path: '/api/kanban/cards/:cardId', handler: 'handleGetCard',
      summary: 'A card with its tasks, comments, action history and author roster', effect: 'read',
      input: z.object({ cardId }),
      output: z.object({
        card: boardCard.extend({
          labels: z.array(z.object({ id: z.string(), name: z.string().nullable(), color: z.string() })).describe('Label ids only (name null, color empty).'),
        }),
        tasks: z.array(z.object({ id: z.string(), name: z.string(), isCompleted: z.boolean(), position: z.number().nullable() })),
        comments: z.array(z.object({ id: z.string(), cardId: z.string(), userId: z.string().nullable(), text: z.string(), createdAt: z.string() })),
        actions: z
          .array(z.object({ id: z.string(), type: z.string(), data: z.unknown(), userId: z.string().nullable(), createdAt: z.string() }))
          .nullable()
          .describe('null: the history could not be read (never an empty list for that).'),
        users: z.array(z.object({ id: z.string(), name: z.string(), username: z.string().nullable() })).describe('At most 50 authors; never an email.'),
      }),
      responses: standardResponses(GATE_404 + PLANKA),
    },
  ]),
  ...settingsCapabilities({ area: 'kanban', tag: 'Kanban', tenancy: 'tenant', rule, ...COMMENTS }, [
    {
      id: 'kanban.list_comments', method: 'GET', path: '/api/kanban/cards/:cardId/comments', handler: 'handleListComments',
      summary: "A card's comments (Planka comment items)", effect: 'read',
      input: z.object({ cardId }),
      output: z.object({ items: z.array(plankaItem('comment')) }),
      responses: standardResponses(GATE_404 + PLANKA),
    },
    {
      id: 'kanban.create_comment', method: 'POST', path: '/api/kanban/cards/:cardId/comments', handler: 'handleCreateComment',
      summary: 'Comment on a card (as fr\'s Planka account, prefixed `via @<author>:`; @mentions are notified)', effect: 'write',
      description: 'The body is parsed BEFORE the tenant gate. Publishes a `comment_created` kanban event.',
      input: z.object({ cardId, text: z.string().min(1).max(8192) }),
      output: plankaItem('comment'),
      successStatus: 201,
      responses: standardResponses(NON_JSON + ZOD_422 + GATE_404 + PLANKA),
    },
  ]),
  ...settingsCapabilities({ area: 'kanban', tag: 'Kanban', tenancy: 'tenant', rule, ...CARDS }, [
    {
      id: 'kanban.create_card_in_list', method: 'POST', path: '/api/kanban/lists/:listId/cards', handler: 'handleCreateCard',
      summary: 'Create a card in a list (optionally typed, prioritised and idempotent)', effect: 'write',
      description:
        'The body is parsed BEFORE the tenant gate. A continuous_flow project accepts only `card_type` ' +
        "'work_intake_record' (422 `details.code` 'card_type_not_allowed'). An `idempotency_key` replay within 7 days " +
        'returns the original card. `priority` is the board owner tenant\'s RM priority level, stamped as Metadata.priority ' +
        '(the card is rolled back if the stamp fails). Publishes `card_created`.',
      input: z.object({
        listId,
        name: z.string().min(1).max(1024),
        description: z.string().max(16384).optional(),
        position: z.number().optional(),
        dueDate: z.string().datetime().nullable().optional(),
        type: z.enum(['project', 'story']).optional(),
        card_type: z.string().min(1).max(128).optional(),
        idempotency_key: z.string().min(1).max(512).optional(),
        priority: z.string().optional().describe("A priority level (name or id) of the board owner tenant (else 400 `code` 'card_priority_invalid' / 'invalid_priority')."),
      }),
      output: plankaItem('card'),
      successStatus: 201,
      responses: standardResponses(
        NON_JSON + "400 `code` 'card_priority_invalid'. " + GHERKIN + ZOD_422 + GATE_404 +
          "409 `code` 'board_tenant_unknown' (a priority on a board with no owning tenant). " + PLANKA,
      ),
    },
    {
      id: 'kanban.update_card', method: 'PATCH', path: '/api/kanban/cards/:cardId', handler: 'handleUpdateCard',
      summary: "Edit a card's name, description, due date or closed flag (never its list: use the move)", effect: 'write',
      description: 'The body is parsed BEFORE the tenant gate; unknown keys are dropped. Publishes `card_updated`.',
      input: z.object({
        cardId,
        name: z.string().min(1).max(1024).optional(),
        description: z.string().max(16384).nullable().optional(),
        dueDate: z.string().datetime().nullable().optional(),
        isClosed: z.boolean().optional(),
      }),
      output: plankaItem('card'),
      responses: standardResponses(NON_JSON + GHERKIN + ZOD_422 + GATE_404 + PLANKA),
    },
    {
      id: 'kanban.duplicate_card', method: 'POST', path: '/api/kanban/cards/:cardId/duplicate', handler: 'handleDuplicateCard',
      summary: 'Duplicate a card (optionally renamed)', effect: 'write',
      description:
        'The body is optional (empty = `{}`). A proof-subset card in a DONE list may not be duplicated (409 ' +
        "'done_without_computed_check'; 503 'done_guard_destination_unresolved' when its list cannot be read). Publishes " +
        '`card_duplicated`.',
      input: z.object({ cardId, name: z.string().min(1).max(1024).optional() }),
      output: plankaItem('card'),
      successStatus: 201,
      responses: standardResponses(
        "400: `error` 'invalid JSON body' (a non-empty body that is not JSON). " + ZOD_422 + GATE_404 +
          "409 / 503: the DONE guard (`error`, `card_id`, `card_type`, `message`). " + PLANKA,
      ),
    },
    {
      id: 'kanban.delete_card', method: 'DELETE', path: '/api/kanban/cards/:cardId', handler: 'handleDeleteCard',
      summary: 'Delete a card', effect: 'destructive',
      input: z.object({ cardId }),
      output: z.null(),
      successStatus: 204,
      responses: standardResponses(GATE_404 + PLANKA),
    },
  ]),
  ...settingsCapabilities({ area: 'kanban', tag: 'Kanban', tenancy: 'tenant', rule, ...LABELS }, [
    {
      id: 'kanban.attach_label', method: 'POST', path: '/api/kanban/cards/:cardId/labels/:labelId', handler: 'handleAttachLabel',
      summary: "Attach one of the card board's existing labels to the card", effect: 'write',
      description: "A label of another board is the same 404 as a missing one ('Label not found'). Publishes `label_attached`.",
      input: z.object({ cardId, labelId }),
      output: z.null(),
      successStatus: 204,
      responses: standardResponses(GATE_404 + PLANKA),
    },
    {
      id: 'kanban.detach_label', method: 'DELETE', path: '/api/kanban/cards/:cardId/labels/:labelId', handler: 'handleDetachLabel',
      summary: "Detach one of the card board's labels from the card", effect: 'write',
      description: "A label of another board is the same 404 as a missing one ('Label not found'). Publishes `label_detached`.",
      input: z.object({ cardId, labelId }),
      output: z.null(),
      successStatus: 204,
      responses: standardResponses(GATE_404 + PLANKA),
    },
  ]),
  ...settingsCapabilities({ area: 'kanban', tag: 'Kanban', tenancy: 'tenant', rule, ...TOOLS }, [
    {
      id: 'kanban.get_liveness', method: 'GET', path: '/api/tools/kanban/liveness', handler: 'handleGetLiveness',
      summary: 'Liveness of the kanban WebSocket subscriber pool (optionally one project\'s subscriptions)', effect: 'read',
      description:
        "status: 'disconnected' with no subscriber or a lag ≥ 60s, 'stale' at ≥ 20s, else 'live'. Counts only; " +
        '`projectId` is not access-checked. The AG-UI action `kanban.verify_liveness` (routes/tools/kanban.ts) reads the same ' +
        'snapshot and stays where it is.',
      input: z.object({ projectId: z.string().optional() }),
      output: z.object({
        data: z.object({
          last_broadcast_seq: z.number().int(),
          subscribers: z.number().int(),
          max_lag_seconds: z.number(),
          lag_ms: z.number().int(),
          status: z.enum(['live', 'stale', 'disconnected']),
        }),
      }),
      responses: standardResponses(),
    },
  ]),
];

/** `POST /api/kanban/cards/:cardId/move` — the literal operation, VERBATIM. */
const MOVE_FROZEN = {
    summary: 'Move a Planka card to another list (human UI drag, or an n8n service identity via n8n-nodes-fr moveCard)',
    description:
      'Moves the card with the Planka agent identity after fr authorizes the caller. AUTH: a Keycloak bearer. ' +
      'A HUMAN token is gated by the board-tenant WRITE predicate (unchanged). A SERVICE identity (a client-credentials ' +
      'token, or the system operator holding the `aa-orchestrator` realm role) is authorized against the tenant DERIVED ' +
      "FROM THE CARD (its board -> project/stream -> tenant); X-Tenant-Id / X-Active-Tenant / the token's tenant claim are " +
      'never trusted, only compared — any mismatch, and an unresolvable owner, is the same 404 as a missing card. ' +
      'DONE GUARD: a proof-subset card (bug_analysis, code_quality_analysis, security_analysis, development_bug_fix) ' +
      'may enter a DONE-equivalent list (any name containing DONE, SHIP, PUBLISH or COMPLETED; ' +
      'never DROPPED) only with a computed-check pass on record; otherwise 409 `done_without_computed_check` and no ' +
      'move. If the destination list cannot be read, every other card moves as before and a proof-subset card without ' +
      'a pass gets 503 `done_guard_destination_unresolved` (retry). A pending bug_fix_authorization approval refuses leaving BLOCKED (409 ' +
      '`bug_fix_authorization_pending`).',
    tags: ['Kanban'],
    operationId: 'moveKanbanCard',
    security: [{ bearerAuth: [] }],
    parameters: [{ name: 'cardId', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['listId'],
            properties: {
              listId: { type: 'string', minLength: 1, description: 'Destination Planka list id' },
              position: { type: 'number', description: 'Planka position within the list' },
            },
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'The moved card (Planka card item)',
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      },
      '400': { description: "Body fails the schema, or `list_not_on_card_board` (the destination list is not on the card's own board)", content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      '401': { description: 'Missing or invalid bearer', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      '404': { description: 'Card not found — also a foreign tenant, a service identity whose asserted tenant differs from the card-derived tenant, or an unresolvable owner (fail closed)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      '409': {
        description:
          '`done_without_computed_check` (proof-subset card to DONE without a computed pass), ' +
          '`bug_fix_authorization_pending` (pending fix authorization), or `project_not_live` ' +
          '(a move INTO READY for a card whose project is archived / delivered / pending / cancelled)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error'],
              properties: {
                error: { type: 'string', enum: ['done_without_computed_check', 'bug_fix_authorization_pending'] },
                card_id: { type: 'string' },
                card_type: { type: 'string' },
                approval_id: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      // P4d-2e (P4d-2b carry, measured): the route's zod refusal (MoveCardBody: `listId` missing / empty, `position`
      // not a number) is handleError's 422 'Validation error', not the 400 above (which is the non-JSON body).
      '422': {
        description: "`error` 'Validation error' (`details`: the zod issues) — the body fails MoveCardBody.",
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      '503': {
        description:
          '`done_guard_destination_unresolved` — the destination list could not be read and the card is a ' +
          'proof-subset card without a computed pass (it might be a DONE move); or `destination_list_unresolved` — ' +
          "neither the destination list nor the card's own board could be read, so the cross-board guard cannot " +
          'decide. Nothing was moved; retry.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error'],
              properties: {
                error: { type: 'string', enum: ['done_guard_destination_unresolved', 'destination_list_unresolved'] },
                card_id: { type: 'string' },
                card_type: { type: 'string', nullable: true },
                list_id: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

/** `POST /api/kanban/cards/:cardId/break-glass-done` — the literal operation, VERBATIM. */
const BREAK_GLASS_FROZEN = {
    summary: 'Break-glass: move a proof-subset card to DONE without a computed pass (super_admin, audited, scored NON-DONE)',
    description:
      'super_admin only. Requires a non-blank `reason`; writes an append-only `card_done_overrides` row (who, when, reason, ' +
      'card, done_by=human_override) BEFORE the move. Every fr DONE consumer treats the card as NON-DONE ' +
      '(`done_kind: human_override`). Only for a proof-subset card and a DONE-family destination.',
    tags: ['Kanban'],
    operationId: 'breakGlassDoneKanbanCard',
    security: [{ bearerAuth: [] }],
    'x-internal': true,
    parameters: [{ name: 'cardId', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['listId', 'reason'],
            properties: {
              listId: { type: 'string', minLength: 1 },
              reason: { type: 'string', minLength: 1, maxLength: 2000 },
              position: { type: 'number' },
            },
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Moved; `done_kind` is always `human_override`',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['card', 'done_kind', 'override'],
              properties: {
                card: { type: 'object', additionalProperties: true },
                done_kind: { type: 'string', enum: ['human_override'] },
                override: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      '400': { description: '`reason_required`, `not_a_done_list`, `not_proof_subset` or an invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      // P4d-2e (P4d-2b FROZEN_401_GAPS, measured): validateAuth answers a caller with no / an invalid bearer 401 first.
      '401': { description: "validateAuth's 401 (`error`: 'Missing or invalid Authorization header' / 'Invalid or expired token').", content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      '403': { description: 'Not a super_admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      '409': { description: '`bug_fix_authorization_pending`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

const MOVE_ROUTE = { method: 'POST', path: '/api/kanban/cards/:cardId/move' } as const;
const BREAK_GLASS_ROUTE = { method: 'POST', path: '/api/kanban/cards/:cardId/break-glass-done' } as const;

const FROZEN: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'kanban.move_card',
    area: 'kanban',
    summary: MOVE_FROZEN.summary,
    http: { ...MOVE_ROUTE, operationId: 'moveKanbanCard' },
    // The frozen operation's own path parameter and body (the route's zod is the contract:
    // routes/kanban/cards.ts MoveCardBody: `position` optional — omitted appends to the list's end).
    input: z.object({ cardId, listId, position: z.number().optional() }).passthrough(),
    output: plankaItem('card'),
    errors: [],
    auth: { principal: 'user', rbac: rule(MOVE_ROUTE) },
    tenancy: 'tenant',
    effect: 'write',
    confirm: defaultConfirm('write'),
    licence: { ops: ['kanban.moveCard'] },
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { frozen: MOVE_FROZEN },
    legacyHandler: lazyHandler(CARDS.load, { module: CARDS.module, exportName: 'handleMoveCard' }),
  }) as Capability<unknown, unknown>,
  defineCapability({
    id: 'kanban.break_glass_done',
    area: 'kanban',
    summary: BREAK_GLASS_FROZEN.summary,
    http: { ...BREAK_GLASS_ROUTE, operationId: 'breakGlassDoneKanbanCard' },
    input: z.object({ cardId, listId, reason: z.string().min(1).max(2000), position: z.number().optional() }).passthrough(),
    output: z.object({ card: plankaItem('card'), done_kind: z.literal('human_override'), override: z.record(z.unknown()) }),
    errors: [],
    auth: { principal: 'user', rbac: superAdmin(BREAK_GLASS_ROUTE) },
    tenancy: 'platform',
    effect: 'write',
    confirm: defaultConfirm('write'),
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { frozen: BREAK_GLASS_FROZEN },
    legacyHandler: lazyHandler(BREAK_GLASS.load, { module: BREAK_GLASS.module, exportName: 'handleBreakGlassDone' }),
  }) as Capability<unknown, unknown>,
];

export const KANBAN_FROZEN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = FROZEN;
export const KANBAN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = NEW;

