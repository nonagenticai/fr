import { eq } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { db, projects } from '../../db/client';
import { isIntegrationError } from '../../integrations/_lib/errors';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { assertDescriptionScenarios } from '../../services/gherkin-scenarios';
import {
  attachLabelToCard,
  createBoard,
  createCard,
  createLabel,
  createList,
  createProject,
  createTask,
  createTaskList,
  deleteBoard,
  deleteCard,
  deleteLabel,
  deleteList,
  deleteProject,
  deleteTask,
  deleteTaskList,
  detachLabelFromCard,
  getBoard,
  getCard,
  getList,
  getProject,
  listCardsByList,
  listProjects,
  moveCard,
  updateBoard,
  updateCard,
  updateLabel,
  updateList,
  updateProject,
  updateTask,
  updateTaskList,
} from '../../integrations/kanban';
import { plankaAsAgent } from '../../services/planka/with-auth';
import {
  agentConfirmDeps,
  confirmBoardMissing,
} from '../../services/planka/confirm-board-missing';
import { stampBlockReasonQuietly } from '../../services/card-block-reason';
import { isBlocked } from '../../lib/phase';
import {
  bugFixAuthorizationPendingBody,
  findBlockingBugFixGate,
} from '../../services/approvals/bug-fix-park-guard';
import { checkDoneListRename, checkDoneMove, doneRefusalStatus } from '../../services/done-guard';
import { assertServiceCardTenant, isServiceIdentity } from '../../lib/service-card-tenant';
import type {
  CreateBoardBody,
  CreateCardBody,
  CreateLabelBody,
  CreateListBody,
  CreateProjectBody,
  CreateTaskBody,
  CreateTaskListBody,
  UpdateBoardBody,
  UpdateCardBody,
  UpdateLabelBody,
  UpdateListBody,
  UpdateProjectBody,
  UpdateTaskBody,
  UpdateTaskListBody,
} from '@fr/service-client-kanban';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import { readJsonBody } from '../_lib';

// The asset-library kanban routes are an admin-grade Planka passthrough: they
// call Planka as fr's one configured account with NO tenant scoping (unlike
// `/api/kanban/*` and `/api/projects/:id/kanban`, which run fr's own tenant gate
// before any Planka call — fr has no per-user Planka identity since 2026-10-10,
// so Planka board membership limits nothing). Planka does not partition on
// `X-Tenant-Id`, so an ordinary tenant user hitting these by raw id could
// read/mutate/delete ANY tenant's board. These routes have no UI/n8n caller —
// restrict the whole family to platform super-admins (the same posture as the
// `/api/admin/assets/*` console).
async function requireSuperAdmin(req: Request): Promise<Awaited<ReturnType<typeof validateAuth>>> {
  const user = await validateAuth(req);
  if (!isSuperAdmin(user)) {
    throw new ForbiddenError('super-admin only');
  }
  return user;
}

/**
 * A SERVICE identity moving a card through this passthrough: the card's tenant is DERIVED from
 * its board and every asserted tenant must match it (lib/service-card-tenant.ts). A human
 * super-admin is unaffected (the passthrough stays unscoped for them, as before).
 */
async function assertServiceMoveTenant(
  req: Request,
  user: Awaited<ReturnType<typeof validateAuth>>,
  cardId: string,
): Promise<void> {
  if (!isServiceIdentity(user)) return;
  let boardId: string;
  try {
    boardId = (await plankaAsAgent().cards.get(cardId)).item.boardId;
  } catch {
    throw new NotFoundError('Card not found');
  }
  await assertServiceCardTenant(req, user, boardId);
}


// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function handleListKanbanProjects(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => listProjects(),
    (data) => jsonResponse({ data }),
  );
}

export async function handleCreateKanbanProject(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateProjectBody>(req);
  return handle(
    () => createProject(body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetKanbanProject(
  req: Request,
  projectId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => getProject(projectId),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateKanbanProject(
  req: Request,
  projectId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateProjectBody>(req);
  return handle(
    () => updateProject(projectId, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteKanbanProject(
  req: Request,
  projectId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => deleteProject(projectId),
    () => noContentResponse(),
  );
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

export async function handleCreateKanbanBoard(
  req: Request,
  projectId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateBoardBody>(req);
  return handle(
    () => createBoard(projectId, body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetKanbanBoard(
  req: Request,
  boardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => getBoard(boardId),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateKanbanBoard(
  req: Request,
  boardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateBoardBody>(req);
  return handle(
    () => updateBoard(boardId, body),
    (data) => jsonResponse({ data }),
  );
}

/** Distinct `planka_project_id` values (nulls included) of rows naming `boardId`. */
async function loadProjectIdsForBoard(boardId: string): Promise<Array<string | null>> {
  const rows = await db
    .selectDistinct({ pid: projects.planka_project_id })
    .from(projects)
    .where(eq(projects.planka_board_id, boardId));
  return rows.map((r) => r.pid);
}

/** NULL `projects.planka_board_id` on every row naming `boardId`. Returns rows cleared. */
async function clearProjectBoardPointers(boardId: string): Promise<number> {
  const rows = await db
    .update(projects)
    .set({ planka_board_id: null, updated_at: new Date() })
    .where(eq(projects.planka_board_id, boardId))
    .returning({ id: projects.id });
  return rows.length;
}

/**
 * After the delete answered 404: is the board PROVABLY gone? Planka's
 * boards/delete.js answers `BOARD_NOT_FOUND; // Forbidden` to any caller that is
 * not a project manager — admin does not bypass — so the 404 alone proves
 * nothing. The owning project comes from fr's own rows; zero or several
 * distinct project ids ⇒ unprovable ⇒ keep the pointers.
 */
async function boardProvenMissingAfter404(boardId: string): Promise<{ ok: boolean; reason: string }> {
  const pids = await loadProjectIdsForBoard(boardId);
  if (pids.length === 0) return { ok: false, reason: 'no project row names this board' };
  if (pids.length > 1) return { ok: false, reason: `rows disagree on the owning project (${pids.length} ids)` };
  const v = await confirmBoardMissing(boardId, pids[0] ?? null, agentConfirmDeps(plankaAsAgent()));
  return { ok: v.verdict === 'missing', reason: 'reason' in v ? v.reason : v.verdict };
}

// Deleting a board must not leave fr project rows pointing at it. Planka has no
// FK into fr's database (separate DB, separate service), so nothing cascades:
// before this, a board deleted here left every `projects.planka_board_id` that
// named it dangling, and every later reader (backfills, the board list, the
// Runtime-State heal) had to tell "board live" from "board gone".
//
// After a CONFIRMED delete (2xx) every project row naming this board id is
// NULLed in one UPDATE. After a Planka 404 the rows are NULLed ONLY if
// `confirmBoardMissing` proves the board is gone (board GET 404 AND the agent
// manages the owning project, which no longer lists it) — a 404 also means
// "not a project manager" (boards/delete.js), and clearing on it would wipe a
// pointer to a board that still exists. An unproven 404 is logged as
// `unverified_404` and clears nothing. Any other failure (401/403/5xx/network)
// clears nothing.
//
// TENANT SCOPE — deliberately NOT narrowed to the caller's tenant. A Planka
// board id is global and this route is a super-admin-only, cross-tenant
// passthrough (see requireSuperAdmin): the delete removed the board for every
// tenant, so a pointer to it in ANY tenant is false. Filtering by the caller's
// tenant would leave exactly the dangling rows this exists to prevent. The clear
// is keyed on the exact board id, so no other board's pointer — in this tenant
// or another — is touched. `streams.planka_board_id` is NOT NULL (migration
// 017) and cannot be cleared this way; it is out of scope.
//
// The 404 is still returned to the caller: the response keeps its upstream
// meaning ("Planka said not found").
export async function handleDeleteKanbanBoard(
  req: Request,
  boardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    async () => {
      let notFound: unknown;
      try {
        await deleteBoard(boardId);
      } catch (err) {
        if (!(isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND')) throw err;
        notFound = err;
      }
      if (notFound) {
        const proof = await boardProvenMissingAfter404(boardId);
        if (!proof.ok) {
          console.warn(
            `[assets.kanban] board ${boardId} delete → 404 but absence NOT proven ` +
              `(unverified_404: ${proof.reason}) — project pointers kept`,
          );
          throw notFound;
        }
      }
      const cleared = await clearProjectBoardPointers(boardId);
      if (cleared > 0) {
        console.warn(
          `[assets.kanban] board ${boardId} ${notFound ? 'proven absent (404 + PM check)' : 'deleted'} — ` +
            `cleared planka_board_id on ${cleared} project row(s)`,
        );
      }
      if (notFound) throw notFound;
    },
    () => noContentResponse(),
  );
}

// ---------------------------------------------------------------------------
// Lists (columns)
// ---------------------------------------------------------------------------

export async function handleCreateKanbanList(
  req: Request,
  boardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateListBody>(req);
  return handle(
    () => createList(boardId, body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetKanbanList(
  req: Request,
  listId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => getList(listId),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateKanbanList(
  req: Request,
  listId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateListBody>(req);
  // DONE guard (validator NO-3b): super-admin is not exempt. services/done-guard.ts.
  const renameRefusal = checkDoneListRename(listId, (body as { name?: unknown } | null)?.name);
  if (renameRefusal) return jsonResponse(renameRefusal, 409);
  return handle(
    () => updateList(listId, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteKanbanList(
  req: Request,
  listId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => deleteList(listId),
    () => noContentResponse(),
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export async function handleListKanbanCardsByList(
  req: Request,
  listId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => listCardsByList(listId),
    (data) => jsonResponse({ data }),
  );
}

export async function handleCreateKanbanCard(
  req: Request,
  listId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateCardBody>(req);
  // fr#1338: strict gherkin_scenarios entries — refused (400 + code), never stripped.
  assertDescriptionScenarios((body as { description?: unknown } | null)?.description);
  return handle(
    () => createCard(listId, body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetKanbanCard(
  req: Request,
  cardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => getCard(cardId),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateKanbanCard(
  req: Request,
  cardId: string,
): Promise<Response> {
  const user = await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateCardBody>(req);
  // fr#1338: strict gherkin_scenarios entries — refused (400 + code), never stripped.
  assertDescriptionScenarios((body as { description?: unknown } | null)?.description);
  // Bug-fix PARK guard 2: this passthrough is the SAME Planka PATCH /api/cards/:id that
  // moveCard uses, so a body carrying `listId` is a move and gets the move's check. Planka
  // changes a card's list only via `listId` (a `boardId` change requires one), so a body
  // without it (name, description, …) is not a move and is untouched by the guard.
  // ANY present `listId` is a move: a non-string (a JSON number, null) or empty one is
  // refused 400 rather than forwarded, because Planka's input coercion turns a number into a
  // string that passes its id validation — a numeric listId would otherwise skip this guard
  // and still move the card.
  const destListId = (body as { listId?: unknown } | null)?.listId;
  if (destListId !== undefined) {
    if (typeof destListId !== 'string' || !destListId) {
      return jsonResponse(
        { error: 'invalid_list_id', message: 'listId must be a non-empty string' },
        400,
      );
    }
    await assertServiceMoveTenant(req, user, cardId);
    const blockingGate = await findBlockingBugFixGate({ cardId, destListId });
    if (blockingGate) return jsonResponse(bugFixAuthorizationPendingBody(blockingGate), 409);
    // DONE-move guard (ncn#2087 row #7) — super-admin is NOT break-glass; see services/done-guard.ts.
    const doneRefusal = await checkDoneMove({ cardId, destListId });
    if (doneRefusal) return jsonResponse(doneRefusal, doneRefusalStatus(doneRefusal));
  }
  return handle(
    () => updateCard(cardId, body),
    (data) => jsonResponse({ data }),
  );
}

/**
 * ⛔ A card must not reach BLOCKED with an empty `block_reason` — see
 * `services/card-block-reason.ts` for why an empty one strands the card
 * permanently rather than merely looking untidy.
 *
 * This surface is a super-admin passthrough over the generated kanban client,
 * which has no customField writer, so the stamp goes through the PlankaClient
 * agent instead. Entirely best-effort in BOTH directions: it neither fails the
 * move nor is allowed to throw into `handle()`, because by the time it runs the
 * card is already in BLOCKED and a 500 would only invite a retry that re-moves
 * an already-moved card.
 */
async function stampBlockReasonIfBlocked(
  cardId: string,
  listId: string | undefined,
  source: string,
): Promise<void> {
  if (!listId) return;
  try {
    const list = (await getList(listId)) as unknown as {
      item?: { name?: string | null; boardId?: string };
    };
    const name = list.item?.name ?? null;
    const boardId = list.item?.boardId;
    if (!boardId || !isBlocked(name)) return;
    await stampBlockReasonQuietly(plankaAsAgent(), { boardId, cardId, source });
  } catch (err) {
    console.warn(
      `[assets.kanban] could not resolve destination list ${listId} to stamp ` +
        `block_reason on card ${cardId} (swallowed):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function handleMoveKanbanCard(
  req: Request,
  cardId: string,
): Promise<Response> {
  const user = await requireSuperAdmin(req);
  const body = await readJsonBody<
    Pick<UpdateCardBody, 'listId' | 'boardId' | 'position'>
  >(req);
  // Bug-fix PARK guard 2 — same check as POST /api/kanban/cards/:cardId/move
  // (services/approvals/bug-fix-park-guard.ts). Before the move, never after.
  await assertServiceMoveTenant(req, user, cardId);
  const blockingGate = await findBlockingBugFixGate({ cardId, destListId: body?.listId });
  if (blockingGate) return jsonResponse(bugFixAuthorizationPendingBody(blockingGate), 409);
  // DONE-move guard (ncn#2087 row #7) — super-admin is NOT break-glass; see services/done-guard.ts.
  const doneRefusal = await checkDoneMove({ cardId, destListId: body?.listId });
  if (doneRefusal) return jsonResponse(doneRefusal, doneRefusalStatus(doneRefusal));
  return handle(
    async () => {
      const data = await moveCard(cardId, body);
      await stampBlockReasonIfBlocked(
        cardId,
        body.listId,
        'fr.assets.kanban.move_card',
      );
      return data;
    },
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteKanbanCard(
  req: Request,
  cardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => deleteCard(cardId),
    () => noContentResponse(),
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export async function handleCreateKanbanLabel(
  req: Request,
  boardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateLabelBody>(req);
  return handle(
    () => createLabel(boardId, body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleUpdateKanbanLabel(
  req: Request,
  labelId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateLabelBody>(req);
  return handle(
    () => updateLabel(labelId, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteKanbanLabel(
  req: Request,
  labelId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => deleteLabel(labelId),
    () => noContentResponse(),
  );
}

export async function handleAttachKanbanLabel(
  req: Request,
  cardId: string,
  labelId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => attachLabelToCard(cardId, { labelId }),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleDetachKanbanLabel(
  req: Request,
  cardId: string,
  labelId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => detachLabelFromCard(cardId, labelId),
    () => noContentResponse(),
  );
}

// ---------------------------------------------------------------------------
// Task lists + tasks (checklist items)
// ---------------------------------------------------------------------------

export async function handleCreateKanbanTaskList(
  req: Request,
  cardId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateTaskListBody>(req);
  return handle(
    () => createTaskList(cardId, body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleUpdateKanbanTaskList(
  req: Request,
  taskListId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateTaskListBody>(req);
  return handle(
    () => updateTaskList(taskListId, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteKanbanTaskList(
  req: Request,
  taskListId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => deleteTaskList(taskListId),
    () => noContentResponse(),
  );
}

export async function handleCreateKanbanTask(
  req: Request,
  taskListId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<CreateTaskBody>(req);
  return handle(
    () => createTask(taskListId, body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleUpdateKanbanTask(
  req: Request,
  taskId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readJsonBody<UpdateTaskBody>(req);
  return handle(
    () => updateTask(taskId, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteKanbanTask(
  req: Request,
  taskId: string,
): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => deleteTask(taskId),
    () => noContentResponse(),
  );
}
