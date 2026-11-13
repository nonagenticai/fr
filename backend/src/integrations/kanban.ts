import { config } from '../config';
import { createHttpClient, type HttpClient, type RequestOptions } from './_lib/http-client';
import { plankaClient } from '../services/planka';
import { assertPlankaCardBodyCarriesNoEvidence } from '../services/planka/description-guard';
import {
  getCreateBoardUrl,
  getCreateCardLabelUrl,
  getCreateCardUrl,
  getCreateLabelUrl,
  getCreateListUrl,
  getCreateProjectUrl,
  getCreateTaskListUrl,
  getCreateTaskUrl,
  getDeleteBoardUrl,
  getDeleteCardLabelUrl,
  getDeleteCardUrl,
  getDeleteLabelUrl,
  getDeleteListUrl,
  getDeleteProjectUrl,
  getDeleteTaskListUrl,
  getDeleteTaskUrl,
  getGetBoardUrl,
  getGetCardUrl,
  getGetCardsUrl,
  getGetListUrl,
  getGetProjectUrl,
  getGetProjectsUrl,
  getUpdateBoardUrl,
  getUpdateCardUrl,
  getUpdateLabelUrl,
  getUpdateListUrl,
  getUpdateProjectUrl,
  getUpdateTaskListUrl,
  getUpdateTaskUrl,
  type CreateBoardBody,
  type CreateCardBody,
  type CreateCardLabel200,
  type CreateCardLabelBody,
  type CreateLabelBody,
  type CreateListBody,
  type CreateProjectBody,
  type CreateTaskBody,
  type CreateTaskListBody,
  type GetBoard200,
  type GetCard200,
  type GetCards200,
  type GetList200,
  type GetProject200,
  type GetProjects200,
  type UpdateBoardBody,
  type UpdateCardBody,
  type UpdateLabelBody,
  type UpdateListBody,
  type UpdateProjectBody,
  type UpdateTaskBody,
  type UpdateTaskListBody,
} from '@fr/service-client-kanban';

// Planka CRUD is synchronous upstream; fail fast on dead upstream so the
// frontend doesn't hang. No endpoints exposed here stream, so a single
// timeout is fine.
const CRUD_TIMEOUT_MS = 30_000;

let cachedClient: HttpClient | undefined;

/**
 * The raw kanban HttpClient. Called from exactly ONE place — `KANBAN_TRANSPORT`
 * below — so every request this module sends passes the evidence guard first.
 * The coverage census (description-chokepoint-coverage.test.ts) pins that.
 */
function rawClient(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'kanban',
      baseUrl: config.services.kanban.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // Planka issues its OWN tokens and accepts nothing else — a Keycloak JWT
      // presented to `/api/*` comes back 401 `E_UNAUTHORIZED` ("Access token is
      // missing, invalid or expired"), the same as no header at all. So
      // forwarding the caller's bearer, which is what `sendAuthorization`
      // defaults to, was never a weaker identity: it was a guaranteed failure on
      // every verb in this file. It is off here, and the shared service identity
      // this module was always documented to use is supplied below.
      sendAuthorization: false,
      // The agent login (`PLANKA_AGENT_EMAIL`/`PLANKA_AGENT_PASSWORD` →
      // POST /api/access-tokens, incl. the accept-terms step) already lives in
      // `services/planka/auth.ts`, cached process-wide. Reusing that instance
      // rather than logging in again means both Planka clients share one token
      // and one invalidation: `routes/dashboard.ts` and `routes/measure.ts`
      // read their board LISTS through `plankaClient.asAgent()` and their CARDS
      // through this module, and a second cache would let those two halves of a
      // single request disagree about whether the agent is still authenticated.
      credentialProvider: {
        token: () => plankaClient.auth.agentToken(),
        invalidate: () => plankaClient.auth.invalidateAgent(),
      },
    });
  }
  return cachedClient;
}

/**
 * The body as Planka will parse it; an unparseable string is returned as the raw
 * text, which the whole-body walk checks as a string `(body)` (fail closed).
 */
function wireBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * THE low-level transport of this module, and the kanban twin of
 * `PlankaHttp.request` (services/planka/http.ts): EVERY non-GET request with a
 * body runs the Planka evidence chokepoint — over EVERY string value and key of
 * the body, not only `description` (fr#1359) —
 * (services/planka/description-guard.ts) BEFORE the request is built or
 * fetched, whatever the writer. Guarding writer-by-writer covered only
 * createCard/updateCard and left createProject/updateProject sending a raw
 * `description` to Planka (reachable through the super-admin passthroughs in
 * routes/assets/kanban.ts). A refusal is the 400 `PlankaDescriptionEvidenceError`,
 * never a fetch.
 */
const KANBAN_TRANSPORT = {
  async json<T = unknown>(path: string, init: RequestInit & RequestOptions = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && init.body !== undefined && init.body !== null) {
      assertPlankaCardBodyCarriesNoEvidence(wireBody(init.body));
    }
    return await rawClient().json<T>(path, init);
  },
};

function http(): typeof KANBAN_TRANSPORT {
  return KANBAN_TRANSPORT;
}

// Planka responses are wrapped as `{ item, included }` for single resources
// and `{ items, included }` for collections. We surface them unchanged — the
// FR kanban UI already knows how to assemble the sidecar `included` bundle.

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<GetProjects200> {
  return await http().json<GetProjects200>(getGetProjectsUrl(), { method: 'GET' });
}

export async function getProject(id: string): Promise<GetProject200> {
  return await http().json<GetProject200>(getGetProjectUrl(id), { method: 'GET' });
}

export async function createProject(body: CreateProjectBody): Promise<unknown> {
  return await http().json<unknown>(getCreateProjectUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateProject(
  id: string,
  body: UpdateProjectBody,
): Promise<unknown> {
  return await http().json<unknown>(getUpdateProjectUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await http().json<void>(getDeleteProjectUrl(id), { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------
//
// NOTE: Planka exposes no "list boards by project" endpoint — the generated
// client has no getBoardsUrl / getListBoardsByProject URL builder. Boards are
// surfaced via `listProjects().included.boards` or via `getProject(id)`.
// Similarly `getBoard(id)` returns lists / labels / cards / tasks nested in
// `included`, so there are no list-lists-by-board or list-labels-by-board
// helpers here.

export async function getBoard(id: string): Promise<GetBoard200> {
  return await http().json<GetBoard200>(getGetBoardUrl(id), { method: 'GET' });
}

export async function createBoard(
  projectId: string,
  body: CreateBoardBody,
): Promise<unknown> {
  return await http().json<unknown>(getCreateBoardUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateBoard(
  id: string,
  body: UpdateBoardBody,
): Promise<unknown> {
  return await http().json<unknown>(getUpdateBoardUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteBoard(id: string): Promise<void> {
  await http().json<void>(getDeleteBoardUrl(id), { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Lists (columns)
// ---------------------------------------------------------------------------

export async function getList(id: string): Promise<GetList200> {
  return await http().json<GetList200>(getGetListUrl(id), { method: 'GET' });
}

export async function createList(
  boardId: string,
  body: CreateListBody,
): Promise<unknown> {
  return await http().json<unknown>(getCreateListUrl(boardId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateList(
  id: string,
  body: UpdateListBody,
): Promise<unknown> {
  return await http().json<unknown>(getUpdateListUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteList(id: string): Promise<void> {
  await http().json<void>(getDeleteListUrl(id), { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
//
// Planka has no dedicated "move" endpoint — moving a card to a different
// list/position is a PATCH on the card with `listId` + `position` fields.
// `moveCard` is a convenience wrapper around `updateCard` so the FR UI doesn't
// have to know that.

/**
 * ⚠️ ONE PAGE. `GET /api/lists/:id/cards` is CURSOR-paginated and returns no
 * total — `items.length` is a page size, never a list size.
 *
 * Measured on the running Planka 2.1.0 pod (`kanban` namespace):
 * `api/hooks/query-methods/models/Card.js:9` is `const LIMIT = 50`, applied on
 * both the Waterline path (`:154`) and the raw-SQL search path (`:111`), sorted
 * `listChangedAt DESC, id DESC`. `api/controllers/cards/index.js:246` returns
 * `{items, included}` with no `total` and no `hasMore`.
 *
 * Every caller that wanted a COUNT was therefore reporting 50 for any list
 * holding more. That is live, not hypothetical: the kanban DB holds 6,157
 * cards and ELEVEN lists exceed 50, the largest at 2,842 — a 56.8× undercount
 * rendered as a total. Use {@link countCardsByList} for a count.
 */
export async function listCardsByList(listId: string): Promise<GetCards200> {
  return await http().json<GetCards200>(getGetCardsUrl(listId), { method: 'GET' });
}

/**
 * Planka's server-side page size for `GET /lists/:id/cards`. Measured, not
 * assumed — see {@link listCardsByList}. A page SHORTER than this is provably
 * the last page, which is what keeps the common list at exactly one request.
 */
export const PLANKA_CARD_PAGE_SIZE = 50;

/**
 * Page budget for one {@link countCardsByList} walk. A list at or under
 * `PLANKA_CARD_PAGE_SIZE` costs ONE request and is exact; only a list that
 * overflows pays more, and it pays at most this. 20 × 50 = 1,000 cards counted
 * exactly; beyond that the answer is an explicit lower bound.
 */
const MAX_CARD_COUNT_PAGES = 20;

interface CardCount {
  /**
   * Cards counted. When `complete` is false this is a LOWER BOUND — render it
   * as "N+", never as a total.
   */
  count: number;
  /** true ⇒ the walk reached the end of the list and `count` is exact. */
  complete: boolean;
  /** Pages actually fetched (1 for the common case). */
  pages: number;
}

/**
 * Count the cards on a list by walking Planka's cursor, and SAY whether the
 * answer is exact.
 *
 * ⛔ The point is the `complete` flag, not the extra pages. A count that is a
 * page size wearing a total's clothes is the failure this exists to remove: a
 * caller can render "1,000+" honestly, but it cannot un-fabricate a confident
 * "50".
 *
 * Cursor semantics (measured, `Card.js:67-73,134-150`): pass
 * `before[listChangedAt]` + `before[id]` from the LAST item of the previous
 * page; the predicate is `list_changed_at < $1 OR (list_changed_at = $1 AND id
 * < $2)`. A card whose `listChangedAt` is null cannot form a cursor, so the
 * walk stops there and reports `complete:false` rather than restarting from the
 * top and double-counting.
 *
 * Errors are NOT swallowed: a failure on page 0 throws, exactly as
 * `listCardsByList` does, because callers already distinguish "read failed"
 * from "list is empty" and must keep being able to. A failure on a LATER page
 * also throws — a partial walk that returned quietly would be the same
 * confident-undercount defect in a new place.
 */
export async function countCardsByList(
  listId: string,
  opts: { maxPages?: number } = {},
): Promise<CardCount> {
  const maxPages = opts.maxPages ?? MAX_CARD_COUNT_PAGES;
  let count = 0;
  let pages = 0;
  let before: { listChangedAt: string; id: string } | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url = getGetCardsUrl(
      listId,
      before
        ? { 'before[listChangedAt]': before.listChangedAt, 'before[id]': before.id }
        : undefined,
    );
    const res = await http().json<GetCards200>(url, { method: 'GET' });
    const items = res.items ?? [];
    pages += 1;
    count += items.length;

    // A short page is provably the last one — Planka would have filled it.
    if (items.length < PLANKA_CARD_PAGE_SIZE) return { count, complete: true, pages };

    const last = items[items.length - 1];
    const cursorTs = last?.listChangedAt;
    if (!last || typeof cursorTs !== 'string' || cursorTs.length === 0) {
      // No usable cursor: stop and admit the number is a floor.
      return { count, complete: false, pages };
    }
    before = { listChangedAt: cursorTs, id: last.id };
  }
  return { count, complete: false, pages };
}

export async function getCard(id: string): Promise<GetCard200> {
  return await http().json<GetCard200>(getGetCardUrl(id), { method: 'GET' });
}

/**
 * Planka 2.1.0 REQUIRES `position` on card create — without it the API answers
 * 422 `E_UNPROCESSABLE_ENTITY: "Position must be present"`.
 *
 * That was known in exactly one place (`services/planka/cards.ts:17-24`, which
 * carries the same comment and the same 65536 default) and nowhere else, so
 * every caller of THIS function had to remember it independently.
 * `agui/actions/streams.ts:396` remembered; `domain/bridge/commit.ts` did not,
 * and the bridge's commit step had therefore never once succeeded in
 * production — measured 2026-09-01 by driving the full lifecycle as a real
 * user, and corroborated by `card_bridge_links` holding ZERO rows since the
 * table was created. The surface was not unused; it was broken.
 *
 * Defaulting here rather than at each call site is deliberate: this is a
 * property of the Planka API, so the wrapper that talks to Planka is where it
 * belongs. An explicit `position` from a caller still wins.
 */
const DEFAULT_CARD_POSITION = 65536;

export async function createCard(
  listId: string,
  body: CreateCardBody,
): Promise<unknown> {
  // Chokepoint: repro evidence never reaches Planka (services/planka/description-guard.ts).
  assertPlankaCardBodyCarriesNoEvidence(body);
  return await http().json<unknown>(getCreateCardUrl(listId), {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      position: body.position ?? DEFAULT_CARD_POSITION,
    }),
  });
}

export async function updateCard(id: string, body: UpdateCardBody): Promise<unknown> {
  // Chokepoint: repro evidence never reaches Planka (services/planka/description-guard.ts).
  // moveCard routes through here, so a raw passthrough body is checked too.
  assertPlankaCardBodyCarriesNoEvidence(body);
  return await http().json<unknown>(getUpdateCardUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function moveCard(
  id: string,
  body: Pick<UpdateCardBody, 'listId' | 'boardId' | 'position'>,
): Promise<unknown> {
  return await updateCard(id, body);
}

export async function deleteCard(id: string): Promise<void> {
  await http().json<void>(getDeleteCardUrl(id), { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Labels (board-scoped definitions + per-card attachments)
// ---------------------------------------------------------------------------

export async function createLabel(
  boardId: string,
  body: CreateLabelBody,
): Promise<unknown> {
  return await http().json<unknown>(getCreateLabelUrl(boardId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateLabel(
  id: string,
  body: UpdateLabelBody,
): Promise<unknown> {
  return await http().json<unknown>(getUpdateLabelUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteLabel(id: string): Promise<void> {
  await http().json<void>(getDeleteLabelUrl(id), { method: 'DELETE' });
}

export async function attachLabelToCard(
  cardId: string,
  body: CreateCardLabelBody,
): Promise<CreateCardLabel200> {
  return await http().json<CreateCardLabel200>(getCreateCardLabelUrl(cardId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function detachLabelFromCard(
  cardId: string,
  labelId: string,
): Promise<void> {
  await http().json<void>(getDeleteCardLabelUrl(cardId, labelId), {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Task lists + tasks (checklist items on cards)
// ---------------------------------------------------------------------------
//
// Tasks belong to a TaskList, which in turn belongs to a Card. The FR UI
// treats them as a flat "checklist"; we mirror the upstream hierarchy. To
// toggle a task complete, PATCH it with `{ isCompleted: true|false }` — there
// is no dedicated toggle endpoint.

export async function createTaskList(
  cardId: string,
  body: CreateTaskListBody,
): Promise<unknown> {
  return await http().json<unknown>(getCreateTaskListUrl(cardId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateTaskList(
  id: string,
  body: UpdateTaskListBody,
): Promise<unknown> {
  return await http().json<unknown>(getUpdateTaskListUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteTaskList(id: string): Promise<void> {
  await http().json<void>(getDeleteTaskListUrl(id), { method: 'DELETE' });
}

export async function createTask(
  taskListId: string,
  body: CreateTaskBody,
): Promise<unknown> {
  return await http().json<unknown>(getCreateTaskUrl(taskListId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateTask(id: string, body: UpdateTaskBody): Promise<unknown> {
  return await http().json<unknown>(getUpdateTaskUrl(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteTask(id: string): Promise<void> {
  await http().json<void>(getDeleteTaskUrl(id), { method: 'DELETE' });
}

// NOTE: Skipped verbs (by design, per FR kanban UI scope):
//   - users / user CRUD, notifications, webhooks, SMTP config
//   - project-managers, board-memberships, card-memberships
//   - attachments, comments (FR has its own comment system)
//   - custom fields / custom-field groups / custom-field values
//   - background images, actions (audit log), bootstrap, access tokens
//   - duplicateCard / readCardNotifications (not part of the UI's MVP)
