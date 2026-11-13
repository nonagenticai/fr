// src/routes/kanban/cards.ts
// Task 22 — Planka card write routes (create / update / move / duplicate / delete).
//
// Follows the T21 comment-handler skeleton: Zod-validate the body, run fr's
// tenant gate (./_gate.ts) BEFORE any Planka call, call fr's one Planka account
// (`plankaAsAgent`), map PlankaError → HTTP, and publish a KanbanEvent.
//
// NOTE for card_moved: Planka's PATCH /cards/:id is the move primitive, but it
// returns only the updated card (no prior listId). To populate
// `fromListId` in the event we pre-fetch the card's current listId with
// one extra GET. The cost is one round-trip per move; if that becomes
// hot-path it can be dropped (and `fromListId` left undefined).
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, projects } from '../../db/client';
import { validateAuthWithToken } from '../../middleware/auth';
import { plankaAsAgent } from '../../services/planka/with-auth';
import {
  assertBoardTenantWritable,
  resolveBoardTenant,
  resolveListBoardOrRefuse,
} from '../../lib/board-tenant-access';
import { legacyPriorityText, resolveTenantPriority } from '../../services/catalogue/priority-levels';
import { PlankaError } from '../../services/planka/errors';
import type { CardDetail } from '../../services/planka';
import { AppError, BadRequestError, ValidationError } from '../../utils/errors';
import {
  CardPrioritySchema,
} from '../../services/improvement-cards/request-schema';
import { boardField, resolveBoardFieldGroups } from '../../services/planka/custom-fields';
import type { PlankaClient } from '../../services/planka';
import { CardsResource } from '../../services/planka/cards';
import { assertDescriptionScenarios } from '../../services/gherkin-scenarios';
import { jsonResponse, createdResponse, noContentResponse } from '../../utils/response';
import { wsManager } from '../../domain/engagement/adapters/websocket';
import { runIdempotent } from '../../domain/engagement/idempotency';
import { toHttpError } from './_errors';
import { gateCardWrite, gateListWrite } from './_gate';
import { config } from '../../config';
import { maybeEvaporateOnBlocked } from '../../services/toc-hooks';
import { stampBlockReasonQuietly } from '../../services/card-block-reason';
import { isBlocked } from '../../lib/phase';
import { isLiveProjectStatus } from '../../lib/project-live-status';
import {
  bugFixAuthorizationPendingBody,
  findBlockingBugFixGate,
} from '../../services/approvals/bug-fix-park-guard';
import {
  checkDoneDuplicate,
  checkDoneMove,
  doneRefusalStatus,
  type DoneGuardRefusal,
} from '../../services/done-guard';
import { assertServiceCardTenant, isServiceIdentity } from '../../lib/service-card-tenant';
import { tryGetRequestContext } from '../../middleware/request-context';
import { PROJECT_KC_TENANT } from '../../lib/project-access';

const MOVE_WORKSPACE_MISMATCH_CODE = 'move_workspace_mismatch' as const;
const MOVE_WRONG_WORKSPACE = "Switch to this project's workspace to move its cards.";

/**
 * The fr project that owns this board (a conveyor board), with its own tenant tag; null for every
 * other board (stream, ad-hoc, untagged). Decided from fr's cached link with NO RM call (a human
 * move must never need RM): `projects.planka_board_id` is written only from RM's board-link answer
 * (R345/R351), so a project row naming this board IS the RM project's board.
 */
export async function resolveConveyorBoardProject(boardId: string): Promise<{ id: string; tenantId: string } | null> {
  if (!boardId) return null;
  const [row] = await db
    .select({ id: projects.id, tenant: PROJECT_KC_TENANT })
    .from(projects)
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  if (!row) return null;
  const tenantId = typeof row.tenant === 'string' && row.tenant.trim() !== '' ? row.tenant.trim() : null;
  if (!tenantId) return null;
  return { id: row.id, tenantId };
}

// Spec 2 §5.4 — idempotency cache TTL for kanban-card create. Seven days
// covers the longest cron-replay windows we expect (RSS / S3 listings
// usually re-emit within hours; GitHub query results within days).
// Anything longer just bloats the cache.
const CARD_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 3600;

// --- Zod schemas ---------------------------------------------------------
//
// Spec 2 §4.5 / §5.4 — `card_type` and `idempotency_key` are user-supplied
// fields. card_type drives the continuous_flow whitelist gate below;
// idempotency_key (Task 10) routes through runIdempotent() against the
// existing action_idempotency table so cron-driven retries dedupe by
// `<tenant_id>:<trigger_id>:<connector_dedup_key>`.
const CreateCardBody = z.object({
  name: z.string().min(1).max(1024),
  description: z.string().max(16384).optional(),
  position: z.number().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  type: z.enum(['project', 'story']).optional(),
  card_type: z.string().min(1).max(128).optional(),
  idempotency_key: z.string().min(1).max(512).optional(),
  // fr#1397 — Metadata.priority, the same tenant RM priority levels as POST
  // /api/cards/project (fr#1394). Without this key the non-strict object
  // STRIPPED a supplied priority: 201, and a card the WIP census (which orders
  // by Metadata::priority first) could not rank. Absent ⇒ nothing is written.
  // An invalid value is refused by assertCardPriority() BEFORE this parse.
  priority: CardPrioritySchema.optional(),
});

/**
 * fr#1397 — a supplied `priority` that is not a non-empty string is a 400
 * naming the field, never stripped and never defaulted. Checked on the RAW body
 * (key present, any value — including null) so the refusal is a 400 with a
 * code, not the generic 422 a ZodError maps to. MEMBERSHIP is the board owner
 * tenant's RM priority levels (resolveCardPriorityText, before any Planka write).
 */
function assertCardPriority(raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || !('priority' in raw)) return;
  const parsed = CardPrioritySchema.safeParse((raw as { priority: unknown }).priority);
  if (parsed.success) return;
  throw new BadRequestError('priority must be a priority level (name or id)', {
    field: 'priority',
    issues: parsed.error.issues,
  }).withCode('card_priority_invalid');
}

/**
 * The Metadata.priority TEXT for `raw` on the board holding `listId`: the
 * legacy text of the board OWNER tenant's RM priority level (design Q3 = b;
 * 400 invalid_priority outside its levels). A board with no owning tenant row
 * cannot resolve a vocabulary: 409 `board_tenant_unknown` (never a guess).
 */
async function resolveCardPriorityText(listId: string, raw: string): Promise<string> {
  const boardId = await resolveListBoardOrRefuse(listId);
  const owner = await resolveBoardTenant(boardId);
  if (!owner) {
    throw new AppError(409, `board ${boardId} has no owning tenant, so its priority levels are unknown`).withCode(
      'board_tenant_unknown',
    );
  }
  const { level } = await resolveTenantPriority(owner, raw);
  return legacyPriorityText(level!);
}

/**
 * fr#1397 — write Metadata.priority on a just-created card, through the SAME
 * Metadata group + `priority` field POST /api/cards/project stamps. READ-ONLY on
 * the board schema: a board whose RM template has no Metadata.priority skips
 * the write with a `board_custom_field_missing` warning — fr never creates the
 * field (v4 ruling 12). One board read + one PATCH.
 */
async function stampCardPriority(
  client: PlankaClient,
  boardId: string,
  cardId: string,
  priority: string,
): Promise<void> {
  const groups = await resolveBoardFieldGroups(client, boardId);
  const field = boardField(groups, {
    boardId,
    cardId,
    group: 'Metadata',
    field: 'priority',
    context: 'kanban.cards.create',
  });
  if (!field) return;
  await client.customFields.setCardCustomFieldValue({
    cardId,
    customFieldGroupId: field.groupId,
    customFieldId: field.fieldId,
    content: priority,
  });
}
const UpdateCardBody = z.object({
  name: z.string().min(1).max(1024).optional(),
  description: z.string().max(16384).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isClosed: z.boolean().optional(),
});
// `position` is OPTIONAL, as the served spec (frozen op `moveKanbanCard`) and the
// n8n-nodes-fr `moveCard` op have always declared it. It used to be required
// here, so every n8n move without a position got a 422. Omitted ⇒ the card is
// appended to the END of the destination list (`appendPositionOnList`).
const MoveCardBody = z.object({
  listId: z.string().min(1),
  position: z.number().optional(),
});
const DuplicateCardBody = z.object({
  name: z.string().min(1).max(1024).optional(),
});

// --- POST /api/kanban/lists/:listId/cards --------------------------------
//
// Spec 2 §4.5 — continuous_flow projects accept ONLY card_type =
// 'work_intake_record'. Resolution path: list -> board -> projects row
// matching planka_board_id -> shape. Deliverable projects keep the open
// whitelist (any card_type, including no card_type at all).
//
// The shape lookup happens BEFORE the Planka create call so a rejected
// request never mints a card in Planka.
export async function handleCreateCard(req: Request, listId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  const raw: unknown = await req.json();
  // fr#1397: an invalid priority is refused (400 + code), never stripped.
  assertCardPriority(raw);
  const body = CreateCardBody.parse(raw);
  // fr#1338: strict gherkin_scenarios entries — refused (400 + code), never stripped.
  assertDescriptionScenarios(body.description);
  // Tenant gate BEFORE any Planka call: the list's board must be writable by the caller.
  await gateListWrite(req, user, listId);
  // The board owner tenant's RM level, resolved BEFORE the card exists.
  const priorityText =
    body.priority !== undefined ? await resolveCardPriorityText(listId, body.priority) : undefined;
  const client = plankaAsAgent();

  // Spec 2 §4.5 — shape gate. The gate only matters when the caller is
  // ASSERTING a card_type; an untyped card create predates this spec and
  // bypasses the lookup entirely (legacy callers + the existing test
  // fixtures both rely on this). When card_type IS supplied and
  // resolves against a continuous_flow project to anything other than
  // work_intake_record, we reject with 422 BEFORE the Planka create.
  //
  // Lookup is wrapped in try/catch + fail-open: a transient DB error
  // shouldn't gate card creation. The gate is a data-integrity guard,
  // not a security boundary; the cron tick worker only ever mints
  // work_intake_record cards anyway.
  if (body.card_type !== undefined) {
    let projectShape: string | null = null;
    try {
      const list = await client.lists.get(listId);
      const boardId = list.boardId;
      if (boardId) {
        const [project] = await db
          .select({ shape: projects.shape })
          .from(projects)
          .where(eq(projects.planka_board_id, boardId));
        projectShape = project?.shape ?? null;
      }
    } catch (err) {
      console.warn(
        '[kanban.create-card] shape lookup failed, falling through:',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (projectShape === 'continuous_flow' && body.card_type !== 'work_intake_record') {
      throw new ValidationError(
        'continuous_flow projects accept only card_type=work_intake_record',
        { code: 'card_type_not_allowed', shape: projectShape },
      );
    }
  }

  // Spec 2 §5.4 — when the cron tick worker (or a connector subflow)
  // posts a card with `idempotency_key`, replays of the same key inside
  // the TTL return the originally-created card without inserting again.
  // Reuses the existing E-4 store (action_idempotency table); per-user
  // scoping mirrors how runIdempotent already partitions other actions.
  const doCreate = async () => {
    const card = await client.cards.create({
      listId,
      name: body.name,
      description: body.description,
      position: body.position,
      dueDate: body.dueDate,
      type: body.type,
    });
    // fr#1397 — stamp BEFORE announcing the card, and roll it back on failure:
    // a 201 for a card that silently lacks the requested priority is the very
    // defect this closes. Inside doCreate, so a failure is never cached by
    // runIdempotent.
    if (priorityText !== undefined) {
      try {
        const boardId =
          (card as { boardId?: string }).boardId ?? (await client.lists.get(listId)).boardId;
        if (!boardId) throw new Error(`card ${card.id} has no boardId; cannot stamp priority`);
        await stampCardPriority(client, boardId, card.id, priorityText);
      } catch (err) {
        await client.cards.delete(card.id).catch((delErr: unknown) => {
          console.warn(
            `[kanban.create-card] priority stamp failed AND rollback of card ${card.id} failed:`,
            delErr instanceof Error ? delErr.message : String(delErr),
          );
        });
        throw err;
      }
    }
    wsManager.publishKanbanEvent({
      kind: 'card_created',
      boardId: (card as { boardId?: string }).boardId,
      cardId: card.id,
      card,
    });
    return card;
  };

  try {
    if (body.idempotency_key) {
      const { value } = await runIdempotent(
        user.id,
        `kanban-card:${body.idempotency_key}`,
        CARD_IDEMPOTENCY_TTL_SECONDS,
        doCreate,
      );
      return createdResponse(value);
    }
    const card = await doCreate();
    return createdResponse(card);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}

// --- PATCH /api/kanban/cards/:cardId -------------------------------------
export async function handleUpdateCard(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  const body = UpdateCardBody.parse(await req.json());
  // fr#1338: strict gherkin_scenarios entries — refused (400 + code), never stripped.
  assertDescriptionScenarios(body.description);
  await gateCardWrite(req, user, cardId);
  const client = plankaAsAgent();
  try {
    const card = await client.cards.update(cardId, body);
    wsManager.publishKanbanEvent({
      kind: 'card_updated',
      boardId: (card as { boardId?: string }).boardId,
      cardId: card.id,
      card,
    });
    return jsonResponse(card);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}

// --- READY-move refusal for a closed project (fr#1519 follow-up) ----------
//
// The UI hides "Move back to READY" for a closed project (frontend
// lib/projects/project-status.ts isClosedProjectStatus: archived / delivered),
// but the move route itself accepted it, so any other caller could put a closed
// project's card back on the conveyor. Refused server-side for every
// NON-live status (archived / pending / cancelled / delivered — a superset of the
// UI's closed set; pending/cancelled projects have no board in practice).
// READY is matched exactly as the UI resolves it: list name trimmed,
// upper-cased, equal to 'READY' (frontend lib/cards/moveToReady.ts).

/** The machine-readable code on the 409. */
const PROJECT_NOT_LIVE = 'project_not_live';

function isReadyListName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().toUpperCase() === 'READY';
}

/** Status of the fr project whose board this is; null = no project owns the board. */
async function boardProjectStatus(boardId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  return row?.status ?? null;
}

/**
 * The position that puts a card at the END of `listId`: the largest position of
 * the list's other cards plus Planka's position gap, or the gap itself on an
 * empty list.
 *
 * Read from the BOARD (`GET /api/boards/:id` → `included.cards`), not from
 * `GET /api/lists/:id/cards`: that endpoint is paged at 50 and ordered by
 * `listChangedAt`, not position (see `integrations/kanban.ts` listCardsByList),
 * so on a list over 50 cards its max would land the card mid-list. The board read
 * carries every card of every finite (active/closed) list, which is what
 * `routes/kanban/reads.ts` renders lists from. A non-finite list (archive/trash)
 * has no cards there and Planka orders it by time, so the gap is returned.
 * The moved card itself is excluded so a same-list move does not drift upward.
 */
export async function appendPositionOnList(
  client: PlankaClient,
  boardId: string,
  listId: string,
  movedCardId: string,
): Promise<number> {
  const board = await client.boards.get(boardId);
  let max = 0;
  for (const c of board.included?.cards ?? []) {
    if (c.listId !== listId || c.id === movedCardId) continue;
    if (typeof c.position === 'number' && Number.isFinite(c.position) && c.position > max) max = c.position;
  }
  return max + CardsResource.POSITION_GAP;
}

// --- POST /api/kanban/cards/:cardId/move ---------------------------------
export async function handleMoveCard(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  const body = MoveCardBody.parse(await req.json());
  // fr's one Planka account; FR gates by tenant below, before the write.
  const client = plankaAsAgent();

  // Pre-fetch for fromListId (see module comment above) AND for the boardId the
  // tenant gate keys on. Unlike the previous best-effort fetch this is load-
  // bearing: with no card there is nothing to authorize, so a failure here fails
  // closed with the upstream's own status instead of falling through to the move.
  let before: CardDetail;
  try {
    before = await client.cards.get(cardId);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
  const fromListId: string | undefined = before.item.listId;

  // Gate the agent-write with the WRITE predicate. Throws NotFoundError — 404
  // fail-closed, never 403, so a foreign card id stays indistinguishable from
  // "not found".
  //
  // ⛔ THIS USED TO BE `assertBoardTenantAuthorized`, THE READ GATE, AND THAT
  // WAS THE DEFECT (fr#1137). The read gate carries `if
  // (isInternalTenant(owningTenant)) return;` on purpose — a stakeholder who
  // must READ an AA / framework board is by construction never in the reserved
  // tenant that owns it. Paired with `plankaAsAgent()` above, which passes
  // Planka's own board-membership check unconditionally, that one branch meant
  // ANY authenticated user in ANY tenant could move ANY card on the 12 live
  // internal-tenant boards, as the admin identity. `assertBoardTenantWritable`
  // is the same boundary MINUS that branch — same short-circuits, same
  // fail-CLOSED catch, same 404-never-403 shape, one shared implementation.
  //
  // ⭐ WHY THE BOARD-KEYED PREDICATE AND NOT `assertCardTenantWritable`. The
  // card-keyed sibling exists for handlers that hold only a card id and must
  // agent-read the card to learn its board. THIS handler already holds
  // `before.item.boardId` from the load-bearing pre-fetch it needs for
  // `fromListId`, so the card-keyed gate would issue a SECOND `GET
  // /api/cards/:id` per drag to recompute a board id already in hand — a
  // duplicate round-trip, and a changed Planka call shape that the hermetic
  // kanban unit tests assert positions on.
  //
  // ⚠️ The super-admin short-circuit SURVIVES this narrowing, and must: a
  // super-admin dragging a card on a `__system_*` board from their home view
  // is a real frontend path, not automation, and it would start 404-ing if
  // `tenantGateShortCircuits`' `isSuperAdmin(user) && !headerOverride` branch
  // were ever dropped.
  //
  // ⭐ SERVICE IDENTITY (n8n-nodes-fr moveCard, coordinator 2026-10-05): the tenant is DERIVED
  // from the card's board, never from X-Tenant-Id / X-Active-Tenant / a claim the caller can
  // assert — those are only compared, and a mismatch is the same 404. lib/service-card-tenant.ts.
  if (isServiceIdentity(user)) {
    await assertServiceCardTenant(req, user, before.item.boardId);
  } else {
    await assertBoardTenantWritable(user, before.item.boardId);
  }

  // ⭐ R349 (George 2026-11-04): a PERSON's drag on a CONVEYOR board (the board's fr project is
  // linked to an RM pm_project) is the plain Planka move — the exact effect, and the exact Planka
  // webhook event, of a move the n8n flows make themselves. So fr's two judge-shaped guards below
  // (bug-fix park, DONE) do not apply to it: a raw Planka move has neither. SERVICE identities,
  // licence callers and every other board keep both guards.
  const human = !isServiceIdentity(user) && user.authKind !== 'licence';
  // `isConveyorBoard(boardId)`: the fr project that owns the board AND is linked to an RM
  // pm_project, or null.
  const conveyor = human ? await resolveConveyorBoardProject(before.item.boardId) : null;
  if (conveyor) {
    // The board gate passed; the project's OWN tenant must also be the caller's active one, so
    // the move acts in the tenant the person is looking at (a super-admin's home view
    // short-circuits the gate on any board).
    const activeTenant = tryGetRequestContext()?.tenantId ?? user.tenantId;
    if (conveyor.tenantId !== activeTenant) {
      return jsonResponse({ error: MOVE_WRONG_WORKSPACE, code: MOVE_WORKSPACE_MISMATCH_CODE, card_id: cardId }, 409);
    }
  }

  // Bug-fix PARK guard 2: a card parked in BLOCKED behind a PENDING marked
  // bug_fix_authorization approval leaves BLOCKED only through the gate's
  // decision callback. See services/approvals/bug-fix-park-guard.ts.
  // (Not on the human path of a conveyor board — R349 parity with a raw Planka move.)
  if (!conveyor) {
    let blockingGate: string | null;
    try {
      blockingGate = await findBlockingBugFixGate({
        cardId,
        destListId: body.listId,
        known: { boardId: before.item.boardId, listId: before.item.listId },
      });
    } catch (err) {
      if (err instanceof PlankaError) throw toHttpError(err);
      throw err;
    }
    if (blockingGate) return jsonResponse(bugFixAuthorizationPendingBody(blockingGate), 409);
  }

  // DONE-move guard (liveness never counts toward DONE, ncn#2087 row #7): a proof-subset
  // card reaches DONE only with a computed pass. See services/done-guard.ts.
  //
  // The destination list is read ONCE, HERE, before the move: the guard needs its name, and the
  // post-move block-reason / evaporate concerns below reuse it. ⚠️ The read is BEST-EFFORT, as
  // it was on main (validator NO-1): a failure is handed to the guard as `listReadFailed`, which
  // resolves the card's type and holds back ONLY a proof-subset card (503
  // done_guard_destination_unresolved). Every other card moves exactly as before.
  let destList: { name?: string | null; boardId?: string } | null = null;
  let listReadFailed = false;
  try {
    destList = await client.lists.get(body.listId);
  } catch (err) {
    listReadFailed = true;
    console.warn(
      '[kanban.move-card] could not resolve destination list before the move (guard decides by card type):',
      err instanceof Error ? err.message : String(err),
    );
  }
  // ⛔ The destination list must be on the card's OWN board. The tenant gate above
  // authorised `before.item.boardId` only; as the admin agent, Planka would otherwise
  // move the card onto any board whose list id the caller names — including one the
  // gate never looked at. Decided on the list read above. When that read failed (or
  // carried no board id) the board is NOT assumed: it is decided from the card's OWN
  // board read instead, and if that fails too the move is refused (503) — the cross-board
  // guard fails closed, never open. The DONE guard below still sees `listReadFailed`.
  if (destList?.boardId) {
    if (destList.boardId !== before.item.boardId) {
      return jsonResponse(
        { error: 'list_not_on_card_board', card_id: cardId, list_id: body.listId },
        400,
      );
    }
  } else {
    let onOwnBoard: boolean;
    try {
      const board = await client.boards.get(before.item.boardId);
      onOwnBoard = (board.included?.lists ?? []).some((l) => l.id === body.listId);
    } catch (err) {
      console.warn(
        '[kanban.move-card] could not resolve the destination list\'s board; refusing the move:',
        err instanceof Error ? err.message : String(err),
      );
      return jsonResponse(
        { error: 'destination_list_unresolved', card_id: cardId, list_id: body.listId },
        503,
      );
    }
    if (!onOwnBoard) {
      return jsonResponse(
        { error: 'list_not_on_card_board', card_id: cardId, list_id: body.listId },
        400,
      );
    }
  }
  // fr#1519 follow-up: a closed (non-live) project's card may not be moved into
  // READY. Decided on the list read above; when that read failed the name is
  // unknown and the move proceeds as before (best-effort, like the guards here).
  if (isReadyListName(destList?.name)) {
    const status = await boardProjectStatus(before.item.boardId);
    if (status !== null && !isLiveProjectStatus(status)) {
      return jsonResponse(
        {
          error: `This card's project is ${status}; its cards cannot be moved back into READY`,
          code: PROJECT_NOT_LIVE,
          project_status: status,
          card_id: cardId,
        },
        409,
      );
    }
  }
  // DONE guard — not on the human path of a conveyor board (R349: a raw Planka move has none).
  if (!conveyor) {
    let doneRefusal: DoneGuardRefusal | null;
    try {
      doneRefusal = await checkDoneMove({
        cardId,
        destListId: body.listId,
        knownListName: listReadFailed ? undefined : (destList?.name ?? null),
        listReadFailed,
      });
    } catch (err) {
      if (err instanceof PlankaError) throw toHttpError(err);
      throw err;
    }
    if (doneRefusal) return jsonResponse(doneRefusal, doneRefusalStatus(doneRefusal));
  }

  // Every guard above has passed; only now is the destination read for the append slot.
  let position: number;
  try {
    position =
      body.position ?? (await appendPositionOnList(client, before.item.boardId, body.listId, cardId));
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }

  try {
    const moved = await client.cards.move(cardId, { listId: body.listId, position });
    wsManager.publishKanbanEvent({
      kind: 'card_moved',
      boardId: (moved as { boardId?: string }).boardId,
      cardId: moved.id,
      card: moved,
      fromListId,
      toListId: body.listId,
    });

    // The destination list, resolved ONCE for the two post-move concerns
    // below. It used to be fetched inside the `hookEvaporateOnBlocked` guard;
    // the block-reason invariant needs the same name and must hold whether or
    // not that (default-OFF) hook is enabled, so the read is hoisted rather
    // than duplicated. Cost is one GET per move on a human-rate endpoint, and
    // this handler already pays one for `fromListId`.
    //
    // Best-effort: a failure resolving the destination must never turn a
    // SUCCESSFUL move into an error response — the card has already moved, and
    // a 500 here only invites a retry that re-moves it.
    // Read before the move (see the DONE guard above); if that read failed, retry it here,
    // best-effort exactly as main did — a failure is swallowed, never an error response.
    if (listReadFailed) {
      try {
        destList = await client.lists.get(body.listId);
      } catch (err) {
        console.warn(
          '[kanban.move-card] could not resolve destination list (swallowed):',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const destBoardId = (moved as { boardId?: string }).boardId ?? destList?.boardId;

    // ⛔ A card must not reach BLOCKED with an empty `block_reason`. This is
    // the generic move endpoint — a human drag-and-drop in the fr UI, and any
    // caller that speaks it — so there is no reason available and the fallback
    // is the honest answer. See services/card-block-reason.ts for why an empty
    // one strands the card permanently rather than merely looking untidy.
    if (destBoardId && isBlocked(destList?.name ?? null)) {
      await stampBlockReasonQuietly(client, {
        boardId: destBoardId,
        cardId,
        source: 'fr.kanban.move_card',
      });
    }

    // Plan §5 hook B (DEFAULT OFF, coordination-gated): when a card lands on
    // the project's BLOCKED list, optionally build an Evaporating Cloud for the
    // conflict. Gate the extra DB lookup on the flag so disabled deploys pay
    // nothing. Best-effort/non-blocking — a failure here must never turn a
    // successful move into an error.
    if (config.services.n8n.hookEvaporateOnBlocked && destList) {
      try {
        let projectId: string | null = null;
        if (destBoardId) {
          const [project] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.planka_board_id, destBoardId));
          projectId = project?.id ?? null;
        }
        await maybeEvaporateOnBlocked({
          projectId,
          destinationListName: destList.name,
          cardId,
        });
      } catch (err) {
        console.warn(
          '[kanban.move-card] evaporate-on-blocked hook failed (swallowed):',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return jsonResponse(moved);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}

// --- POST /api/kanban/cards/:cardId/duplicate ----------------------------
export async function handleDuplicateCard(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  // Body is optional — accept empty body. A non-empty body that is not JSON is
  // the caller's fault: 400 'invalid JSON body', the same answer the pipeline
  // gives the other /api/kanban writes (`JSON.parse` here is not the tagged
  // `req.json()`, so its SyntaxError used to fall through to fr's 500).
  const raw = await req.text();
  let body: unknown = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) throw new BadRequestError('invalid JSON body');
      throw err;
    }
  }
  const name = DuplicateCardBody.parse(body).name;
  await gateCardWrite(req, user, cardId);
  const client = plankaAsAgent();
  // DONE guard (validator NO-3a): a proof-subset card in a DONE list may not be duplicated —
  // the copy would land in DONE carrying card_type and no computed pass. services/done-guard.ts.
  let dupRefusal: Awaited<ReturnType<typeof checkDoneDuplicate>>;
  try {
    dupRefusal = await checkDoneDuplicate(cardId);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
  if (dupRefusal) {
    return jsonResponse(
      dupRefusal,
      dupRefusal.error === 'done_guard_destination_unresolved' ? 503 : 409,
    );
  }
  try {
    const dup = await client.cards.duplicate(cardId, name);
    wsManager.publishKanbanEvent({
      kind: 'card_duplicated',
      boardId: (dup as { boardId?: string }).boardId,
      cardId,
      newCardId: dup.id,
    });
    return createdResponse(dup);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}

// --- DELETE /api/kanban/cards/:cardId ------------------------------------
export async function handleDeleteCard(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  await gateCardWrite(req, user, cardId);
  const client = plankaAsAgent();
  try {
    await client.cards.delete(cardId);
    wsManager.publishKanbanEvent({ kind: 'card_deleted', cardId });
    return noContentResponse();
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}
