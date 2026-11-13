// fr-agui SPEC §13 P4d-2b — spec drain, the kanban group: the asset-library Planka
// passthrough `/api/assets/kanban/*` (routes/assets/kanban.ts), re-expressed with NO behaviour
// change (`legacyHandler`). Every one is a NEW operation (operationId = camelCase(id)),
// formerly pinned in LEGACY_UNDECLARED, `out-of-agent-scope`.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// Gate, as the handlers run it: `requireSuperAdmin` — validateAuth (the licence route door:
// none of these is allowlisted; the conveyor write door), then the `super_admin` realm role
// (403 'super-admin only') — `isAuthenticatedSuperAdmin`. Platform-scoped: the passthrough
// calls Planka as fr's one configured account with NO tenant scoping, which is why it is
// super-admin only. A SERVICE identity moving a card (move, or a PATCH carrying `listId`) is
// additionally checked against the tenant DERIVED from the card's board
// (lib/service-card-tenant.ts: a mismatch is 404 'Card not found').
//
// Bodies are read with `readJsonBody` after the role check: a non-JSON body is 400
// `error.code` 'BAD_REQUEST' (nothing sent to Planka). Every Planka answer goes through the
// kanban service client (`handle`): success `{ data }` (201 on a create, 204 on a delete),
// an upstream failure the integration envelope (`error.code` 'UPSTREAM_…', its status
// relayed).
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody, VALIDATE_AUTH_401, type SettingsRoute } from '../settings/_shared';

const rule = routeRule(isAuthenticatedSuperAdmin);

const id = (what: string) => pathId(`Planka ${what} id`);
const data = z.object({ data: z.unknown().describe('The Planka answer, as the kanban service client returns it.') });

/** A body forwarded to Planka as the service-client type `t` (unknown keys forwarded). */
const body = (t: string, shape: z.ZodRawShape = {}) =>
  z.object(shape).passthrough().describe(`Forwarded to Planka (@fr/service-client-kanban \`${t}\`).`);

const SUPER_403 =
  "403: `error` 'super-admin only' (no `super_admin` realm role), or `code` 'licence_route_not_allowed' (a licence bearer: " +
  "refused by the server before the handler) / 'conveyor_route_forbidden' (the conveyor identity, non-GET). ";
const UPSTREAM =
  "Planka failing: the integration envelope (`error.code` 'UPSTREAM_…'; its 4xx relayed, its 401 / 5xx or no answer 502, a " +
  "timeout 504). 500: fr's own (`error`). ";
const NON_JSON = "400: `error.code` 'BAD_REQUEST' — the body is not JSON (nothing sent to Planka). ";
const GHERKIN = '400: a malformed `gherkin_scenarios` entry in `description` (`code`; refused, never stripped — fr#1338). ';
const MOVE_GUARDS =
  "404 'Card not found': a service identity whose asserted tenant differs from the card-derived one (or the card is " +
  "unreadable). 409: `error` 'bug_fix_authorization_pending' (a pending fix authorization holds the card in BLOCKED), " +
  "'done_without_computed_check' (a proof-subset card into a DONE list without a computed pass — a super_admin is NOT " +
  "break-glass here); 503 'done_guard_destination_unresolved'. ";

function responses(extra = ''): SettingsRoute['responses'] {
  return [
    { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
    { status: 'default', description: SUPER_403 + extra + UPSTREAM, schema: frErrorBody },
  ];
}

type Row = Omit<SettingsRoute, 'output' | 'responses' | 'effect'> & { extra?: string };

const read = ({ extra, ...r }: Row): SettingsRoute => ({ ...r, effect: 'read', output: data, responses: responses(extra) });
const create = ({ extra, ...r }: Row): SettingsRoute => ({
  ...r,
  effect: 'write',
  successStatus: 201,
  output: data,
  responses: responses(NON_JSON + (extra ?? '')),
});
const update = ({ extra, ...r }: Row): SettingsRoute => ({ ...r, effect: 'write', output: data, responses: responses(NON_JSON + (extra ?? '')) });
/** A POST with no body (the label attach): 201 `{ data }`, no body read. */
const attach = ({ extra, ...r }: Row): SettingsRoute => ({ ...r, effect: 'write', successStatus: 201, output: data, responses: responses(extra) });
const remove = ({ extra, ...r }: Row, effect: SettingsRoute['effect'] = 'destructive'): SettingsRoute => ({
  ...r,
  effect,
  successStatus: 204,
  output: z.null(),
  responses: responses(extra),
});

export const KANBAN_ASSET_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'kanban_assets',
    tag: 'Kanban Assets',
    tenancy: 'platform',
    rule,
    module: 'src/routes/assets/kanban.ts',
    load: () => import('../../routes/assets/kanban'),
  },
  [
    // Projects
    read({ id: 'kanban_assets.list_projects', method: 'GET', path: '/api/assets/kanban/projects', handler: 'handleListKanbanProjects', summary: 'Every Planka project (super_admin passthrough)', input: z.object({}) }),
    create({ id: 'kanban_assets.create_project', method: 'POST', path: '/api/assets/kanban/projects', handler: 'handleCreateKanbanProject', summary: 'Create a Planka project (super_admin passthrough)', input: body('CreateProjectBody') }),
    create({ id: 'kanban_assets.create_board', method: 'POST', path: '/api/assets/kanban/projects/:projectId/boards', handler: 'handleCreateKanbanBoard', summary: 'Create a board in a Planka project (super_admin passthrough)', input: body('CreateBoardBody', { projectId: id('project') }) }),
    read({ id: 'kanban_assets.get_project', method: 'GET', path: '/api/assets/kanban/projects/:projectId', handler: 'handleGetKanbanProject', summary: 'A Planka project (super_admin passthrough)', input: z.object({ projectId: id('project') }) }),
    update({ id: 'kanban_assets.update_project', method: 'PATCH', path: '/api/assets/kanban/projects/:projectId', handler: 'handleUpdateKanbanProject', summary: 'Edit a Planka project (super_admin passthrough)', input: body('UpdateProjectBody', { projectId: id('project') }) }),
    remove({ id: 'kanban_assets.delete_project', method: 'DELETE', path: '/api/assets/kanban/projects/:projectId', handler: 'handleDeleteKanbanProject', summary: 'Delete a Planka project (super_admin passthrough)', input: z.object({ projectId: id('project') }) }),
    // Boards
    create({ id: 'kanban_assets.create_list', method: 'POST', path: '/api/assets/kanban/boards/:boardId/lists', handler: 'handleCreateKanbanList', summary: 'Create a list on a board (super_admin passthrough)', input: body('CreateListBody', { boardId: id('board') }) }),
    create({ id: 'kanban_assets.create_label', method: 'POST', path: '/api/assets/kanban/boards/:boardId/labels', handler: 'handleCreateKanbanLabel', summary: 'Create a label on a board (super_admin passthrough)', input: body('CreateLabelBody', { boardId: id('board') }) }),
    read({ id: 'kanban_assets.get_board', method: 'GET', path: '/api/assets/kanban/boards/:boardId', handler: 'handleGetKanbanBoard', summary: 'A Planka board (super_admin passthrough)', input: z.object({ boardId: id('board') }) }),
    update({ id: 'kanban_assets.update_board', method: 'PATCH', path: '/api/assets/kanban/boards/:boardId', handler: 'handleUpdateKanbanBoard', summary: 'Edit a Planka board (super_admin passthrough)', input: body('UpdateBoardBody', { boardId: id('board') }) }),
    remove({
      id: 'kanban_assets.delete_board', method: 'DELETE', path: '/api/assets/kanban/boards/:boardId', handler: 'handleDeleteKanbanBoard',
      summary: 'Delete a Planka board and clear every fr project pointer to it (super_admin passthrough)',
      description:
        "After a confirmed delete every `projects.planka_board_id` naming the board is cleared (in every tenant). After a Planka " +
        '404 the pointers are cleared only when the board is PROVEN gone (the agent manages the owning project, which no longer ' +
        'lists it); the 404 is still answered.',
      input: z.object({ boardId: id('board') }),
    }),
    // Lists
    read({ id: 'kanban_assets.list_cards', method: 'GET', path: '/api/assets/kanban/lists/:listId/cards', handler: 'handleListKanbanCardsByList', summary: "A list's cards (super_admin passthrough)", input: z.object({ listId: id('list') }) }),
    create({
      id: 'kanban_assets.create_card', method: 'POST', path: '/api/assets/kanban/lists/:listId/cards', handler: 'handleCreateKanbanCard',
      summary: 'Create a card in a list (super_admin passthrough)',
      input: body('CreateCardBody', { listId: id('list'), description: z.string().optional() }),
      extra: GHERKIN,
    }),
    read({ id: 'kanban_assets.get_list', method: 'GET', path: '/api/assets/kanban/lists/:listId', handler: 'handleGetKanbanList', summary: 'A Planka list (super_admin passthrough)', input: z.object({ listId: id('list') }) }),
    update({
      id: 'kanban_assets.update_list', method: 'PATCH', path: '/api/assets/kanban/lists/:listId', handler: 'handleUpdateKanbanList',
      summary: 'Edit a list (super_admin passthrough; a DONE-family list may not be renamed out of it)',
      input: body('UpdateListBody', { listId: id('list'), name: z.string().optional() }),
      extra: '409: the DONE guard refuses the rename (services/done-guard.ts `checkDoneListRename`). ',
    }),
    remove({ id: 'kanban_assets.delete_list', method: 'DELETE', path: '/api/assets/kanban/lists/:listId', handler: 'handleDeleteKanbanList', summary: 'Delete a list (super_admin passthrough)', input: z.object({ listId: id('list') }) }),
    // Cards
    update({
      id: 'kanban_assets.move_card', method: 'POST', path: '/api/assets/kanban/cards/:cardId/move', handler: 'handleMoveKanbanCard',
      summary: 'Move a card (super_admin passthrough; bug-fix PARK and DONE guards apply)',
      description: 'A card that lands in BLOCKED gets a fallback `block_reason` (best-effort).',
      input: body("UpdateCardBody (listId / boardId / position)", { cardId: id('card'), listId: z.string().optional(), boardId: z.string().optional(), position: z.number().optional() }),
      extra: MOVE_GUARDS,
    }),
    create({ id: 'kanban_assets.create_task_list', method: 'POST', path: '/api/assets/kanban/cards/:cardId/task-lists', handler: 'handleCreateKanbanTaskList', summary: 'Create a task list on a card (super_admin passthrough)', input: body('CreateTaskListBody', { cardId: id('card') }) }),
    attach({ id: 'kanban_assets.attach_label', method: 'POST', path: '/api/assets/kanban/cards/:cardId/labels/:labelId', handler: 'handleAttachKanbanLabel', summary: 'Attach a label to a card (super_admin passthrough)', input: z.object({ cardId: id('card'), labelId: id('label') }) }),
    remove({ id: 'kanban_assets.detach_label', method: 'DELETE', path: '/api/assets/kanban/cards/:cardId/labels/:labelId', handler: 'handleDetachKanbanLabel', summary: 'Detach a label from a card (super_admin passthrough)', input: z.object({ cardId: id('card'), labelId: id('label') }) }, 'write'),
    read({ id: 'kanban_assets.get_card', method: 'GET', path: '/api/assets/kanban/cards/:cardId', handler: 'handleGetKanbanCard', summary: 'A Planka card (super_admin passthrough)', input: z.object({ cardId: id('card') }) }),
    update({
      id: 'kanban_assets.update_card', method: 'PATCH', path: '/api/assets/kanban/cards/:cardId', handler: 'handleUpdateKanbanCard',
      summary: 'Edit a card (super_admin passthrough; a body carrying `listId` is a move and gets the move guards)',
      input: body('UpdateCardBody', {
        cardId: id('card'),
        description: z.string().nullable().optional(),
        listId: z.string().min(1).optional().describe("Present = a move (any other type, or empty: 400 `error` 'invalid_list_id')."),
      }),
      extra: GHERKIN + "400: `error` 'invalid_list_id'. " + MOVE_GUARDS,
    }),
    remove({ id: 'kanban_assets.delete_card', method: 'DELETE', path: '/api/assets/kanban/cards/:cardId', handler: 'handleDeleteKanbanCard', summary: 'Delete a card (super_admin passthrough)', input: z.object({ cardId: id('card') }) }),
    // Labels
    update({ id: 'kanban_assets.update_label', method: 'PATCH', path: '/api/assets/kanban/labels/:labelId', handler: 'handleUpdateKanbanLabel', summary: 'Edit a board label (super_admin passthrough)', input: body('UpdateLabelBody', { labelId: id('label') }) }),
    remove({ id: 'kanban_assets.delete_label', method: 'DELETE', path: '/api/assets/kanban/labels/:labelId', handler: 'handleDeleteKanbanLabel', summary: 'Delete a board label (super_admin passthrough)', input: z.object({ labelId: id('label') }) }),
    // Task lists + tasks
    create({ id: 'kanban_assets.create_task', method: 'POST', path: '/api/assets/kanban/task-lists/:taskListId/tasks', handler: 'handleCreateKanbanTask', summary: 'Create a task in a task list (super_admin passthrough)', input: body('CreateTaskBody', { taskListId: id('task list') }) }),
    update({ id: 'kanban_assets.update_task_list', method: 'PATCH', path: '/api/assets/kanban/task-lists/:taskListId', handler: 'handleUpdateKanbanTaskList', summary: 'Edit a task list (super_admin passthrough)', input: body('UpdateTaskListBody', { taskListId: id('task list') }) }),
    remove({ id: 'kanban_assets.delete_task_list', method: 'DELETE', path: '/api/assets/kanban/task-lists/:taskListId', handler: 'handleDeleteKanbanTaskList', summary: 'Delete a task list (super_admin passthrough)', input: z.object({ taskListId: id('task list') }) }),
    update({ id: 'kanban_assets.update_task', method: 'PATCH', path: '/api/assets/kanban/tasks/:taskId', handler: 'handleUpdateKanbanTask', summary: 'Edit a task (super_admin passthrough)', input: body('UpdateTaskBody', { taskId: id('task') }) }),
    remove({ id: 'kanban_assets.delete_task', method: 'DELETE', path: '/api/assets/kanban/tasks/:taskId', handler: 'handleDeleteKanbanTask', summary: 'Delete a task (super_admin passthrough)', input: z.object({ taskId: id('task') }) }),
  ],
);
