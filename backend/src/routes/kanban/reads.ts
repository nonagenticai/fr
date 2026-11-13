// src/routes/kanban/reads.ts
// Read-only kanban endpoints. Migrated from the legacy routes/kanban.ts + flat planka.ts client
// to the per-resource plankaClient (services/planka).
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { and, eq, inArray } from 'drizzle-orm';
import { validateAuthWithToken } from '../../middleware/auth';
import { tryGetRequestContext } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { config } from '../../config';
import { db, projects, departments, streams } from '../../db/client';
import {
  loadProjectForRead,
  plankaProjectTenantMatch,
  projectIdsReadableAsGetProject,
} from '../../lib/project-access';
import { plankaClient } from '../../services/planka';
import {
  assertBoardTenantAuthorized,
  assertCardTenantAuthorized,
  resolveBoardTenant,
} from '../../lib/board-tenant-access';
import { PlankaError, PlankaNotFoundError } from '../../services/planka/errors';
import { toHttpError } from './_errors';
import { cardTypeCapabilityMap } from '../../services/catalogue/tenant-catalogue';
import type {
  Action,
  Board,
  BoardDetail,
  Card,
  CardDetail,
  CardLabel,
  CardMembership,
  Comment,
  Label,
  List,
  Many,
  ProjectsListResponse,
  Task,
} from '../../services/planka';

// Planka returns these alongside the curated BoardDetail/CardDetail types.
// Typed locally because the curated types in services/planka/types.ts don't
// (yet) surface the AA-spec custom-field substrate.
interface IncludedCustomFieldGroup {
  id: string;
  cardId?: string | null;
  boardId?: string;
  name: string | null;
}
interface IncludedCustomField {
  id: string;
  customFieldGroupId: string;
  name: string | null;
}
interface IncludedCustomFieldValue {
  cardId: string;
  customFieldId: string;
  content: string | null;
}

/**
 * Build a per-card lookup of the AA-spec `Metadata.card_type` value.
 * Walks (customFieldGroups × customFields × customFieldValues) once per
 * board fetch, only counting values whose group is the card's Metadata
 * group AND whose field is named `card_type`.
 */
function buildCardTypeMap(included: {
  customFieldGroups?: IncludedCustomFieldGroup[];
  customFields?: IncludedCustomField[];
  customFieldValues?: IncludedCustomFieldValue[];
}): Map<string, string> {
  const groups = included.customFieldGroups ?? [];
  const fields = included.customFields ?? [];
  const values = included.customFieldValues ?? [];

  const metadataGroupIdByCard = new Map<string, string>();
  for (const g of groups) {
    if (g.cardId && g.name === 'Metadata') metadataGroupIdByCard.set(g.cardId, g.id);
  }
  const fieldNameById = new Map<string, string>();
  for (const f of fields) {
    if (f.name) fieldNameById.set(f.id, f.name);
  }
  const cardTypeByCard = new Map<string, string>();
  for (const v of values) {
    if (!v.content) continue;
    if (fieldNameById.get(v.customFieldId) !== 'card_type') continue;
    const meta = metadataGroupIdByCard.get(v.cardId);
    if (!meta) continue;
    cardTypeByCard.set(v.cardId, v.content);
  }
  return cardTypeByCard;
}

/**
 * Translate an error caught around a Planka call into the HTTP-shaped error
 * server.ts serializes. A `PlankaError` carries the upstream status —
 * `toHttpError` maps 404→404, 403→403, 401→401, and only genuine
 * network/5xx → 502. Anything that is NOT a PlankaError is rethrown so the
 * generic 500 handler catches it (a code bug must not masquerade as a 502).
 *
 * This replaces the previous blanket `ServiceUnavailableError(502)`, which
 * made "you are not a member of this board" (Planka 404) look like an
 * outage. See plan i-was-testing-fr-lazy-reef.md Bug 1.
 */
function rethrowPlanka(err: unknown): never {
  if (err instanceof PlankaError) throw toHttpError(err);
  throw err;
}

/**
 * The Planka project ids (among `plankaIds`) that belong to `tenantId`: the
 * project lane (fr.projects, by dept→workspace OR kc-tenant tag) unioned with
 * the active-stream lane (fr.streams). The SAME two lanes handleGetBoard's
 * tenant gate resolves.
 */
async function tenantPlankaProjectIds(
  tenantId: string,
  plankaIds: string[],
): Promise<Set<string>> {
  const allowedSet = new Set<string>();
  if (plankaIds.length === 0) return allowedSet;
  const [allowedProjects, allowedStreams] = await Promise.all([
    // No owner_id filter: every board of the tenant is visible to its members
    // (and to a super-admin viewing a switched workspace).
    db
      .select({ planka_project_id: projects.planka_project_id })
      .from(projects)
      .leftJoin(departments, eq(projects.dept_id, departments.id))
      .where(
        and(
          // Match by EITHER lane (dept→workspace OR kc-tenant tag). In prod
          // dept_id is NULL, so a workspace-only match drops every project
          // board; the kc-tenant tag is the authoritative association.
          plankaProjectTenantMatch(tenantId),
          inArray(projects.planka_project_id, plankaIds),
        ),
      ),
    db
      .select({ planka_project_id: streams.planka_project_id })
      .from(streams)
      .where(
        and(
          eq(streams.tenant_id, tenantId),
          eq(streams.is_active, true),
          inArray(streams.planka_project_id, plankaIds),
        ),
      ),
  ]);
  for (const r of allowedProjects) {
    if (r.planka_project_id) allowedSet.add(r.planka_project_id);
  }
  for (const r of allowedStreams) {
    allowedSet.add(r.planka_project_id);
  }
  return allowedSet;
}

/**
 * board id → fr project id, for the boards (among `boardIds`) that are a
 * project board OF `tenantId` (`projects.planka_board_id`, same tenant lanes as
 * `tenantPlankaProjectIds`) AND whose project this caller can
 * `GET /api/projects/:id`. fr-agui SPEC §7.5: the frontend redirects
 * `/kanban?board=<project board>` to `/projects/P/board` on this value, so the
 * board → project resolution is the server's, inside the tenant boundary.
 *
 * ⛔ The board gate is TENANT-wide but the project read is not (an ordinary
 * user reads only projects they own): a same-tenant peer sees the board, yet
 * would land on a 404 project shell. So a project the caller cannot read is
 * left out (→ `frProjectId: null`, the page stays on /kanban) — decided by
 * `projectIdsReadableAsGetProject`, the GET's own predicate, not a copy.
 */
async function tenantBoardProjectIds(
  user: Awaited<ReturnType<typeof validateAuthWithToken>>['user'],
  tenantId: string,
  boardIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (boardIds.length === 0) return out;
  const rows = await db
    .select({ id: projects.id, planka_board_id: projects.planka_board_id })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        plankaProjectTenantMatch(tenantId),
        inArray(projects.planka_board_id, boardIds),
      ),
    );
  const readable = await projectIdsReadableAsGetProject(
    user,
    rows.map((r) => r.id),
  );
  for (const r of rows) {
    if (!readable.has(r.id)) continue;
    if (r.planka_board_id && !out.has(r.planka_board_id)) out.set(r.planka_board_id, r.id);
  }
  return out;
}

/**
 * GET /api/kanban/boards
 * Lists the Planka boards that belong to the caller's ACTIVE fr tenant — and
 * nothing else. fr acts in Planka as ONE configured account (per tenant, not
 * per user, George 2026-10-10), so Planka's own listing is every board that
 * account can see across EVERY tenant; it is never returned unfiltered. A board
 * is kept iff its Planka project belongs to the tenant through one of the two
 * lanes handleGetBoard's gate resolves:
 *   (a) project-backed boards — fr.projects (dept→workspace OR kc-tenant tag), and
 *   (b) stream-backed boards — fr.streams where streams.tenant_id matches and
 *       streams.is_active = true (AA improvement / asset-authoring streams).
 * A board with no fr.projects/fr.streams row is shown to nobody. No resolvable
 * tenant ⇒ an empty list without dialling Planka (fail closed).
 */
export async function handleListBoards(req: Request): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  const ctx = tryGetRequestContext();
  // The super-admin X-Active-Tenant override scopes the list to the switched
  // tenant; otherwise the request context's tenant, then the JWT home tenant.
  const overrideTenantId =
    ctx?.activeTenantSource === 'header' &&
    ctx.tenantId &&
    ctx.tenantId !== user.tenantId
      ? ctx.tenantId
      : null;
  const effectiveTenantId = overrideTenantId ?? ctx?.tenantId ?? user.tenantId ?? null;
  if (!effectiveTenantId) return jsonResponse({ items: [], total: 0 });

  let resp: ProjectsListResponse;
  try {
    resp = await plankaClient.asAgent().projects.listWithIncluded();
  } catch (err) {
    rethrowPlanka(err);
  }

  const boards = resp.included?.boards || [];
  const allowed = await tenantPlankaProjectIds(
    effectiveTenantId,
    boards.map((b) => b.projectId),
  );
  const projectName = new Map<string, string>();
  for (const p of resp.items || []) projectName.set(p.id, p.name);

  const visible = boards.filter((b: Board) => allowed.has(b.projectId));
  const frProjectByBoard = await tenantBoardProjectIds(
    user,
    effectiveTenantId,
    visible.map((b) => b.id),
  );
  const items = visible.map((board: Board) => ({
    id: board.id,
    name: board.name,
    projectId: board.projectId,
    projectName: projectName.get(board.projectId) ?? 'Unknown',
    position: board.position,
    // The fr project this board belongs to, or null (stream / ad-hoc board).
    frProjectId: frProjectByBoard.get(board.id) ?? null,
  }));
  return jsonResponse({ items, total: items.length });
}

/**
 * GET /api/kanban/boards/:boardId
 * Returns a board with its lists, cards, and labels organized.
 */
/**
 * card_type → `card_group` for one board's cards. The group IS the card type's RM
 * capability (design Q1 = a) in the catalogue of the tenant that OWNS the board
 * (`resolveBoardTenant` — the project/stream row, never the caller's tenant: a
 * platform board read from a customer tenant still uses the platform vocabulary).
 * Only read when a card actually carries a card_type. A board with no owning
 * tenant row resolves no group (null) rather than guessing a tenant.
 */
async function boardCardGroupLookup(
  boardId: string,
  cardTypes: Iterable<string | null>,
): Promise<(cardType: string | null) => string | null> {
  const any = [...cardTypes].some((t) => typeof t === 'string' && t !== '');
  if (!any) return () => null;
  const owner = await resolveBoardTenant(boardId);
  if (!owner) return () => null;
  const map = await cardTypeCapabilityMap(owner);
  return (cardType) => (cardType ? (map.get(cardType) ?? null) : null);
}

export async function handleGetBoard(req: Request, boardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  // Gate by TENANT before any Planka call: the caller's active tenant must own
  // this board (or it must be a platform/system board). 404 on mismatch — never
  // leak which board ids exist across tenants. Keyed on the route boardId and
  // resolved from fr's own DB (project/stream lanes, same as handleListBoards).
  await assertBoardTenantAuthorized(user, boardId);
  // fr's one configured Planka account (per tenant, not per user).
  const client = plankaClient.asAgent();

  let data: BoardDetail;
  try {
    data = await client.boards.get(boardId);
  } catch (err) {
    // A stored board id can be stale — the Planka board was deleted but the
    // fr.projects/streams row still advertises it. Surface a distinguishable
    // `code` so the UI renders "this board no longer exists" instead of a
    // generic 404. (R2/B2 + B3: fr never reconciles dead Planka ids.)
    if (err instanceof PlankaNotFoundError) {
      throw {
        status: 404,
        data: {
          error: 'Not found',
          message: 'This board no longer exists',
          code: 'board_deleted_upstream',
        },
      };
    }
    rethrowPlanka(err);
  }

  const board = data.item;
  const included = data.included ?? {};

  // Planka auto-creates `archive` + `trash` system lists per board with
  // null name/position. Drop them — only return user-visible `active`/`closed`.
  const lists: List[] = (included.lists ?? [])
    .filter((l: List) => l.type === 'active' || l.type === 'closed')
    .slice()
    .sort((a: List, b: List) => (a.position ?? 0) - (b.position ?? 0));
  const cards: Card[] = included.cards ?? [];
  const labels: Label[] = included.labels ?? [];
  const cardLabels: CardLabel[] = included.cardLabels ?? [];
  const cardMemberships: CardMembership[] = included.cardMemberships ?? [];

  // Build label lookup: labelId -> Label
  const labelMap = new Map<string, Label>();
  for (const l of labels) {
    labelMap.set(l.id, l);
  }

  const cardLabelsByCard = new Map<string, Array<{ id: string; name: string | null; color: Label['color']; boardId: string }>>();
  for (const cl of cardLabels) {
    if (!cardLabelsByCard.has(cl.cardId)) {
      cardLabelsByCard.set(cl.cardId, []);
    }
    const label = labelMap.get(cl.labelId);
    if (label) {
      cardLabelsByCard.get(cl.cardId)!.push({
        id: label.id,
        name: label.name,
        color: label.color,
        boardId: label.boardId,
      });
    }
  }

  // Build member lookup: cardId -> memberUserIds[]
  const cardMembersByCard = new Map<string, string[]>();
  for (const cm of cardMemberships) {
    if (!cardMembersByCard.has(cm.cardId)) {
      cardMembersByCard.set(cm.cardId, []);
    }
    cardMembersByCard.get(cm.cardId)!.push(cm.userId);
  }

  // AA-spec card-type enrichment: surface Metadata.card_type + its computed
  // group so the frontend can color-code each card by type. Cards minted
  // outside the improvement flow have no Metadata.card_type and surface as
  // null on both fields (frontend renders them as "Unclassified").
  const cardTypeByCard = buildCardTypeMap(
    included as {
      customFieldGroups?: IncludedCustomFieldGroup[];
      customFields?: IncludedCustomField[];
      customFieldValues?: IncludedCustomFieldValue[];
    },
  );

  const cardGroupOf = await boardCardGroupLookup(boardId, cardTypeByCard.values());

  // Enrich cards
  const enrichedCards = cards
    .slice()
    .sort((a: Card, b: Card) => (a.position ?? 0) - (b.position ?? 0))
    .map((card: Card) => {
      const card_type = cardTypeByCard.get(card.id) ?? null;
      const card_group = cardGroupOf(card_type);
      return {
        id: card.id,
        name: card.name,
        description: card.description ?? null,
        listId: card.listId,
        boardId: card.boardId,
        position: card.position,
        dueDate: card.dueDate ?? null,
        stopwatch: card.stopwatch ?? null,
        labels: cardLabelsByCard.get(card.id) ?? [],
        memberIds: cardMembersByCard.get(card.id) ?? [],
        card_type,
        card_group,
      };
    });

  const enrichedLists = lists.map((list: List) => ({
    id: list.id,
    name: list.name,
    boardId: list.boardId,
    position: list.position,
  }));

  const enrichedLabels = labels.map((label: Label) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    boardId: label.boardId,
  }));

  return jsonResponse({
    board: {
      id: board.id,
      name: board.name,
      projectId: board.projectId,
      position: board.position,
    },
    lists: enrichedLists,
    cards: enrichedCards,
    labels: enrichedLabels,
  });
}

/**
 * GET /api/kanban/cards/:cardId
 * Returns a card with its details, comments, and actions.
 */
export async function handleGetCard(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  // Gate by TENANT before the card's contents are read: the card's board must
  // belong to the caller's active tenant (or a platform board). The gate's own
  // agent read resolves the board; 404 fail-closed, so a foreign card id is
  // indistinguishable from "not found".
  await assertCardTenantAuthorized(user, cardId);
  const client = plankaClient.asAgent();

  let cardData: CardDetail;
  let comments: Awaited<ReturnType<typeof client.comments.listForCard>>;
  let actionsData: Many<Action> | null;
  try {
    [cardData, comments, actionsData] = await Promise.all([
      client.cards.get(cardId),
      // Comments, unlike actions below, CAN legitimately be empty — a card
      // nobody has commented on has none — so `[]` stays the fallback and the
      // ambiguity cannot be removed from the response the way #913 removed it
      // for actions. What can be removed is the silence: without this, a Planka
      // 5xx and a card with no comments were identical in the logs too.
      client.comments.listForCard(cardId).catch((err: unknown) => {
        reportSwallowedFailure(err, {
          service: 'kanban',
          method: 'GET',
          path: `/api/cards/${cardId}/comments`,
          degradedTo: 'no comments (indistinguishable from a card with none)',
        });
        return [] as Awaited<ReturnType<typeof client.comments.listForCard>>;
      }),
      // No resource for actions yet; call the HTTP layer directly (agent context).
      // `null` on failure, never `{ items: [] }`: every card has at least a
      // `createCard` action, so an empty action list is not something Planka
      // can legitimately return — reporting one turned "we could not read this
      // card's history" into "this card has no history".
      client.http
        .request<Many<Action>>('GET', `/api/cards/${cardId}/actions`, {})
        .catch((err: unknown) => {
          console.warn(
            `[kanban] card ${cardId}: actions read failed; history is UNKNOWN`,
            err,
          );
          // #913 already made this HONEST in the response (`null`, not `[]`).
          // This additionally makes it RANKABLE: a console.warn is invisible to
          // `scripts/rank-integration-failures.ts`, which reads the
          // `integration_error` stream, so the failure existed but could never
          // be counted against anything.
          reportSwallowedFailure(err, {
            service: 'kanban',
            method: 'GET',
            path: `/api/cards/${cardId}/actions`,
            degradedTo: 'actions=null (history explicitly unknown)',
          });
          return null;
        }),
    ]);
  } catch (err) {
    rethrowPlanka(err);
  }

  const card = cardData.item;
  const included = cardData.included ?? {};

  const cardLabels: CardLabel[] = included.cardLabels ?? [];
  const tasks: Task[] = included.tasks ?? [];
  const cardMemberships: CardMembership[] = included.cardMemberships ?? [];

  // Card detail does not include label definitions — cardLabelList will be empty unless
  // a future API version adds labels to the card detail response.
  const cardLabelList: Array<{ id: string; name: string | null; color: string }> = [];
  for (const cl of cardLabels) {
    // labelId is available; label name/color require a separate labels lookup
    cardLabelList.push({ id: cl.labelId, name: null, color: '' });
  }

  const memberIds: string[] = cardMemberships.map((cm: CardMembership) => cm.userId);

  // AA-spec card-type enrichment — mirror handleGetBoard so the card-detail
  // modal can render the same badge as the column view.
  const cardTypeByCard = buildCardTypeMap(
    included as {
      customFieldGroups?: IncludedCustomFieldGroup[];
      customFields?: IncludedCustomField[];
      customFieldValues?: IncludedCustomFieldValue[];
    },
  );
  const card_type = cardTypeByCard.get(card.id) ?? null;
  const card_group = (await boardCardGroupLookup(card.boardId, [card_type]))(card_type);

  const mappedComments = comments.map((c: Comment) => ({
    id: c.id,
    cardId: c.cardId,
    userId: c.userId,
    text: c.text ?? '',
    createdAt: c.createdAt,
  }));

  const actions =
    actionsData === null
      ? null
      : (actionsData.items ?? []).map((a: Action) => ({
          id: a.id,
          type: a.type,
          data: a.data,
          userId: a.userId,
          createdAt: a.createdAt,
        }));

  // Author roster for the comment/action list. Without it the drawer could only
  // name users from the board roster, so every comment the conveyor's Planka
  // account wrote rendered as a truncated id. Read AFTER the tenant gate above: a
  // foreign card must not leak names. A failed lookup drops that one user
  // (the FE falls back to the id); it never fails the card detail.
  const authorIds = [
    ...new Set(
      [...mappedComments.map((c) => c.userId), ...(actions ?? []).map((a) => a.userId)].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ].slice(0, MAX_CARD_AUTHOR_LOOKUPS);
  const users = (
    await Promise.all(
      authorIds.map((id) =>
        client.members.getUser(id).catch((err: unknown) => {
          reportSwallowedFailure(err, {
            service: 'kanban',
            method: 'GET',
            path: `/api/users/${id}`,
            degradedTo: 'author shown as id',
          });
          return null;
        }),
      ),
    )
  )
    .filter((u): u is NonNullable<typeof u> => u != null)
    // Never forward email: it is used only to recognise the agent account.
    .map((u) => ({
      id: u.id,
      name: isConveyorAgent(u) ? CONVEYOR_AGENT_DISPLAY_NAME : u.name,
      username: u.username ?? null,
    }));

  return jsonResponse({
    card: {
      id: card.id,
      name: card.name,
      description: card.description ?? null,
      listId: card.listId,
      boardId: card.boardId,
      position: card.position,
      dueDate: card.dueDate ?? null,
      stopwatch: card.stopwatch ?? null,
      labels: cardLabelList,
      memberIds,
      card_type,
      card_group,
    },
    tasks: tasks.map((t: Task) => ({
      id: t.id,
      name: t.name,
      isCompleted: t.isCompleted,
      position: t.position,
    })),
    comments: mappedComments,
    actions,
    users,
  });
}

// Upper bound on per-card author lookups (one Planka GET each).
const MAX_CARD_AUTHOR_LOOKUPS = 50;
const CONVEYOR_AGENT_DISPLAY_NAME = 'Conveyor agent';

// The conveyor writes through fr's Planka agent login (PLANKA_AGENT_EMAIL) or
// its own account (PLANKA_CONVEYOR_USER_ID); its Planka profile name is the
// unhelpful "admin", so label it by role instead.
function isConveyorAgent(u: { id: string; email?: string | null }): boolean {
  const { email: agentEmail, conveyorUserId } = config.services.planka;
  if (conveyorUserId && u.id === conveyorUserId) return true;
  return Boolean(agentEmail && u.email && u.email.toLowerCase() === agentEmail.toLowerCase());
}

/**
 * GET /api/projects/:id/kanban
 * Returns the Planka board linked to an FR project via project.planka_board_id.
 */
export async function handleGetProjectKanban(req: Request, projectId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);

  // Verify the project exists and is reachable in the requester's active
  // tenant — same gate as routes/projects.ts get/delete. Throws NotFoundError
  // (not a 403) to avoid leaking which ids exist. This IS the authz gate, so the
  // board read below goes via the admin agent (Planka board-membership, which
  // the human may lack for an agent-created board, would otherwise empty it).
  const project = await loadProjectForRead(db, user, projectId);
  const client = plankaClient.asAgent();

  if (!project.planka_board_id) {
    return jsonResponse({ board: null, message: 'No Planka board linked to this project' });
  }

  // Reuse the board detail logic
  let data: BoardDetail;
  try {
    data = await client.boards.get(project.planka_board_id);
  } catch (err) {
    // Stored board id stale (deleted in Planka). Degrade to the same shape as
    // the no-board branch above so the cockpit renders cleanly instead of
    // 404-ing the whole project view (R2/B3).
    if (err instanceof PlankaNotFoundError) {
      return jsonResponse({
        board: null,
        stale: true,
        message: 'Planka board no longer exists',
      });
    }
    rethrowPlanka(err);
  }
  const board = data.item;
  // Drop Planka's auto-created `archive` + `trash` system lists (null name/position).
  const lists: List[] = (data.included?.lists ?? [])
    .filter((l: List) => l.type === 'active' || l.type === 'closed')
    .slice()
    .sort((a: List, b: List) => (a.position ?? 0) - (b.position ?? 0));
  const cards: Card[] = data.included?.cards ?? [];
  const labels: Label[] = data.included?.labels ?? [];

  const labelMap = new Map<string, { id: string; name: string | null; color: Label['color'] }>();
  for (const label of labels) {
    labelMap.set(label.id, { id: label.id, name: label.name, color: label.color });
  }

  const enrichedCards = cards.map((card: Card) => {
    const cardLabels = (data.included?.cardLabels ?? [])
      .filter((cl: CardLabel) => cl.cardId === card.id)
      .map((cl: CardLabel) => labelMap.get(cl.labelId))
      .filter((l): l is { id: string; name: string | null; color: Label['color'] } => l !== undefined);

    return {
      id: card.id,
      name: card.name,
      description: card.description,
      listId: card.listId,
      boardId: card.boardId,
      position: card.position,
      dueDate: card.dueDate,
      labels: cardLabels,
      memberIds: (data.included?.cardMemberships ?? [])
        .filter((cm: CardMembership) => cm.cardId === card.id)
        .map((cm: CardMembership) => cm.userId),
    };
  });

  return jsonResponse({
    project_id: projectId,
    board: { id: board.id, name: board.name, projectId: board.projectId },
    lists: lists.map((l: List) => ({ id: l.id, name: l.name, position: l.position })),
    cards: enrichedCards,
    labels: Array.from(labelMap.values()),
  });
}
