/**
 * kanban.create_card AG-UI action (and, below, kanban.request_move and projects.get_andon).
 *
 * Creates a Planka card on the intake (leftmost) list of the named project,
 * attributing authorship to the calling user by prefixing `via @<user_email>`
 * to the description. The Planka-layer author is the agent service account;
 * the prefix preserves human attribution in a way that survives Planka's auth
 * model.
 *
 * Action kind = `write`. The handler calls `plankaClient.cards.create`, so it
 * mutates; `kind` decides whether `registry.ts` applies the approval gate at
 * all (`registerAction` rejects write+auto, and `invokeAction` routes writes
 * through the approval backend). A mutating handler labelled `read` skips that
 * gate entirely.
 *
 * This previously read `kind: 'read'`, justified as "reachable ONLY via the
 * explicit `card <project>: <title>` chat verb, so there is no LLM
 * hallucination risk". Both halves of that are false against the code:
 *   - `domain/engagement/command-grammar.ts` does not filter on `kind`, and
 *     `channels/index.ts` already handles a returned `PendingAction` (it posts
 *     an `approval-request` reply). Nothing about verb dispatch needs `read`.
 *   - The installed resolver chain is
 *     `CommandGrammarIntentResolver(LLMIntentResolver(HeuristicIntentResolver))`
 *     (`server.ts`). `llm-resolver.ts buildSystemPrompt()` enumerates the FULL
 *     registry via `listActions()` with no `kind` filter, so this action is in
 *     the model's catalog and an LLM pick at confidence >= 0.7 invoked it with
 *     no approval — exactly the hallucinated side-effect the gate exists for.
 *     `HeuristicIntentResolver`'s `<tool>.<verb_noun> {json}` direct-invocation
 *     regex reaches it too.
 *
 * APPROVAL. `single-approver / initiator` + `autoApproveForInitiator: true`,
 * the shape `routes/tools/kag.ts` uses for self-service writes. Deliberately
 * NOT `approver: 'project-owner'` (the `toc.evaluate_lenses` shape): the channel
 * dispatcher builds its `ActionContext` with `projectId: null`, and
 * `resolveRequiredApprovers` throws `ProjectOwnerRequiredError` on a null
 * projectId — that shape would make every chat `card` command fail outright.
 *
 * On a channel the dispatcher credits a grammar-matched `card` to the linked
 * person (`initiatorFor`, channels/index.ts), so it self-approves and queues
 * nothing, like a human-initiated web invoke.
 *
 * kanban-comment.ts and kaizen.ts carry the same mislabel
 * (mutating handler, `kind: 'read'`, `approval: { type: 'auto' }`) and are
 * deliberately left alone by this change.
 */
import { z } from 'zod';
import { and, eq, ilike } from 'drizzle-orm';

import { registerAction } from '../registry';
import { withInvokeCard } from '../capability-invoke-card';
import type { ActionContext, AgentCallableAction } from '../types';
import { db, projects } from '../../db/client';
import { tenantMemberProjectScope } from '../../lib/project-access';
import { plankaClient } from '../../services/planka';
import { keycloak } from '../../services/keycloak';
import { assertDescriptionScenarios } from '../../services/gherkin-scenarios';
import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors';
import { ProjectMismatchError } from '../../agent/project-binding';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import { PROJECT_ANDON_READ_CAPABILITIES } from '../../capabilities/projects/assets';

// D3 — idempotency keys hash the FULL content. A 64-char prefix made two
// distinct writes sharing a prefix collide onto one cached result.
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const inputSchema = z.object({
  /**
   * fr-agui P2: the project this write targets — the PROJECT PARAMETER
   * (agui/agent-surface.ts PROJECT_BINDING): removed from the model's schema
   * and set from the thread in a bound context, required by the confirm card's
   * route (POST /api/capabilities/:id/invoke). Unused outside a project.
   */
  project_id: z.string().uuid().optional(),
  /**
   * Project name or substring to match (fuzzy, tenant-scoped) — the channel
   * `card <project>: <title>` grammar's target. fr-agui P1c: in a PROJECT-BOUND
   * context (the project agent) it is not the model's to fill: the bound
   * project is the target, the key is hidden from the LLM schema, and any value
   * other than the bound project id is refused `project_mismatch`
   * (agent/project-binding.ts). Unbound, it is required.
   */
  project_ref: z.string().min(1).max(255).optional(),
  /** Card title (1–255 chars). */
  title: z.string().min(1).max(255),
  /** Optional card description (up to 8000 chars). */
  description: z.string().max(8000).optional(),
});

const outputSchema = z.object({
  card_id: z.string(),
  list_id: z.string(),
  project_id: z.string().uuid(),
  title: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

/**
 * Return the id of the list with the lowest `position` value (the intake list).
 *
 * - Lists without an `id` are skipped.
 * - Missing `position` is treated as +Infinity so named lists without positions
 *   sort last.
 * - Returns null for an empty array.
 */
export function pickIntakeListId(
  lists: Array<{ id?: string | null; name?: string | null; position?: number | null }>,
): string | null {
  let bestId: string | null = null;
  let bestPos = Infinity;

  for (const list of lists) {
    if (!list.id) continue;
    const pos = list.position ?? Infinity;
    if (pos < bestPos) {
      bestPos = pos;
      bestId = list.id;
    }
  }

  return bestId;
}

export const createCardAction: AgentCallableAction<Input, Output> = {
  name: 'kanban.create_card',
  kind: 'write',
  description:
    "Create a Planka card on the intake (leftmost) list of a project — a forwarded user action (OQ-14): only when the user asked for this card. Inside a project the card goes on THIS project's board. On a channel, project_ref names the project (a fuzzy match on its name).",
  input: inputSchema,
  output: outputSchema,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human-initiated invocation self-approves inline and adds NO approvals row;
  // an agent / n8n / cron invocation still parks for human review.
  autoApproveForInitiator: true,
  cronSafe: true, // a cron invocation is not self-approved — it parks for review
  // The registry scopes every key by tenant AND bound project (D2), so a bound
  // call's empty project_ref still keys per project.
  idempotencyKey: (i) => `kanban.create_card:${i.project_ref ?? ''}:${sha256Hex(i.title)}`,
  rbac: { type: 'public' },
  handler: async (input: Input, ctx: ActionContext): Promise<Output> => {
    // 1. The target project. fr-agui P1c: a PROJECT-BOUND context (the project
    //    agent) targets ITS project only — by id, never by name. Unbound (the
    //    channel grammar): fuzzy name match, tenant-scoped (P1-TEAM-a: any
    //    project of the caller's tenant, not only the caller's own).
    const ref = input.project_ref?.trim() ?? '';
    if (!ctx.projectId && ref === '') {
      throw new Error('kanban.create_card needs a project: send "card <project>: <title>"');
    }
    const [proj] = await db
      .select()
      .from(projects)
      .where(
        and(
          // tag == the caller's tenant (fail closed; fr row 14b) + selection hook.
          tenantMemberProjectScope(ctx.userId, ctx.tenantId),
          ctx.projectId ? eq(projects.id, ctx.projectId) : ilike(projects.name, `%${ref}%`),
        ),
      )
      .limit(1);

    if (!proj) {
      throw new Error(
        ctx.projectId
          ? 'The bound project is not readable for the calling user'
          : `No project matches "${ref}" for the calling user`,
      );
    }

    if (!proj.planka_board_id) {
      throw new Error(`Project "${proj.name}" has no Planka board provisioned yet`);
    }

    // 2. Fetch the board to get its lists.
    const board = await plankaClient.asAgent().boards.get(proj.planka_board_id);
    const lists = board.included.lists ?? [];

    // 3. Pick the leftmost (intake) list.
    const listId = pickIntakeListId(lists);
    if (!listId) {
      throw new Error(`Project "${proj.name}" has no kanban lists yet`);
    }

    // 4. Best-effort email lookup — never let a Keycloak hiccup block card creation.
    let email: string | null = null;
    try {
      const user = await keycloak.getUserById(ctx.userId);
      email = user?.email ?? null;
    } catch (err) {
      // Fall back to userId attribution. Log so a Keycloak outage that turns
      // card-author descriptions into raw UUIDs leaves an audit trail —
      // matches the `[ws-auth]` log shape in `server.ts`.
      console.warn('[kanban-card] keycloak getUserById failed, falling back to userId', {
        userId: ctx.userId,
        err,
      });
    }

    const handle = email ?? ctx.userId;
    const description = input.description
      ? `via @${handle}: ${input.description}`
      : `via @${handle}`;

    // fr#1338: strict gherkin_scenarios entries — refused, never stripped.
    assertDescriptionScenarios(description);

    // 5. Create the card on the intake list.
    const card = await plankaClient.asAgent().cards.create({
      listId,
      name: input.title,
      description,
    });

    return {
      card_id: card.id,
      list_id: listId,
      project_id: proj.id,
      title: input.title,
    };
  },
};

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The board move and the halt read, operable by the project agent exactly as by the UI (George
// 10-14: fr is fully operable via AG-UI agents):
//
//   kanban.request_move     the board DRAG. On the person's Confirm it runs the SAME route a drag
//                           calls (POST /api/kanban/cards/:cardId/move, routes/kanban/cards.ts
//                           handleMoveCard) AS THE HUMAN. R349: on a conveyor board that is the
//                           plain Planka move, exactly like a move the n8n flows make.
//   projects.get_andon      the halt banner's read (GET /api/projects/:id/andon).
// ---------------------------------------------------------------------------

const cardsRoutes = () => import('../../routes/kanban/cards');
const andonRoutes = () => import('../../routes/andon');

export const REQUEST_MOVE_LIST_NOT_FOUND = 'list_not_on_board' as const;
export const REQUEST_MOVE_LIST_AMBIGUOUS = 'list_name_ambiguous' as const;
export const REQUEST_MOVE_CARD_NOT_ON_BOARD = 'card_not_on_project_board' as const;

interface BoardSnapshot {
  boardId: string;
  lists: Array<{ id?: string | null; name?: string | null }>;
  cards: Array<{ id?: string | null; listId?: string | null; name?: string | null }>;
}

/** The bound project's board (lists + cards), inside the caller's tenant; null = no such project / no board. */
async function projectBoard(projectId: string, ctx: ActionContext): Promise<BoardSnapshot | null> {
  const [proj] = await db
    .select({ id: projects.id, planka_board_id: projects.planka_board_id })
    .from(projects)
    .where(and(tenantMemberProjectScope(ctx.userId, ctx.tenantId), eq(projects.id, projectId)))
    .limit(1);
  if (!proj?.planka_board_id) return null;
  const board = await plankaClient.asAgent().boards.get(proj.planka_board_id);
  return {
    boardId: proj.planka_board_id,
    lists: (board.included?.lists ?? []) as BoardSnapshot['lists'],
    cards: (board.included?.cards ?? []) as BoardSnapshot['cards'],
  };
}

/**
 * Pure: the board list `to_list` names — its exact id, else its name (trimmed, case-insensitive).
 * Unknown ⇒ 422 `list_not_on_board` (with the board's list names); a name two lists share ⇒ 409.
 */
export function resolveTargetList(lists: BoardSnapshot['lists'], toList: string): string {
  const want = toList.trim();
  const byId = lists.find((l) => l.id && l.id === want);
  if (byId?.id) return byId.id;
  const named = lists.filter((l) => l.id && (l.name ?? '').trim().toLowerCase() === want.toLowerCase());
  if (named.length === 1) return named[0]!.id!;
  const names = lists.map((l) => (l.name ?? '').trim()).filter((n) => n !== '');
  if (named.length > 1) {
    throw new AppError(409, `More than one list on this board is called "${want}"; name the list by its id.`).withCode(REQUEST_MOVE_LIST_AMBIGUOUS);
  }
  throw new AppError(422, `This board has no list "${want}". Its lists are: ${names.join(', ') || '(none)'}.`).withCode(REQUEST_MOVE_LIST_NOT_FOUND);
}

const requestMoveInput = z.object({
  project_id: z.string().uuid().optional().describe('The project (set from this conversation; never chosen by the model).'),
  card_id: z.string().min(1).max(64).describe('The Planka card id of a card on this project\'s board.'),
  to_list: z.string().min(1).max(255).describe('The list to move it to: its name as the board shows it (e.g. READY, DROPPED) or its id.'),
  position: z.number().optional().describe('Position within the target list; omitted = the end of the list.'),
  idempotency_key: z.string().min(1).max(200).optional().describe('Set by the confirm card.'),
});
type RequestMoveInput = z.infer<typeof requestMoveInput>;

const requestMoveOutput = z.object({
  outcome: z.literal('moved'),
  message: z.string(),
  card_id: z.string(),
  from_list_id: z.string().nullable(),
  to_list_id: z.string(),
});
type RequestMoveOutput = z.infer<typeof requestMoveOutput>;

export const MOVED_MESSAGE = 'The card moved.';

export const requestMoveAction: AgentCallableAction<RequestMoveInput, RequestMoveOutput> = {
  name: 'kanban.request_move',
  kind: 'write',
  description:
    "Move a card on this project's board, exactly as the person's own drag would — a forwarded user action: only when the user asked " +
    'for this move. On a conveyor board it is the plain board move, the same as a move the conveyor makes itself. Quote every ' +
    'refusal verbatim.',
  input: requestMoveInput,
  output: requestMoveOutput,
  // The human's Confirm IS the approval (projects.retry_conveyor_start's pattern): it runs inline for
  // the initiator.
  approval: { type: 'single-approver', approver: 'initiator' },
  autoApproveForInitiator: true,
  cronSafe: false,
  rbac: { type: 'project-member' },
  projectParam: 'project_id',
  webOnly: true,
  idempotencyKey: (i) =>
    `kanban.request_move:${i.project_id ?? ''}:${i.card_id}:${sha256Hex(i.to_list)}:${i.position ?? ''}:${i.idempotency_key ?? ''}`,
  handler: async (input: RequestMoveInput, ctx: ActionContext): Promise<RequestMoveOutput> => {
    const pid = bound(ctx, 'kanban.request_move');
    if (input.project_id && input.project_id.toLowerCase() !== pid.toLowerCase()) {
      throw new ProjectMismatchError('kanban.request_move', 'project_id', pid);
    }
    const board = await projectBoard(pid, ctx);
    if (!board) throw new AppError(409, 'This project has no board yet, so there is no card to move.').withCode('project_board_missing');
    const card = board.cards.find((c) => c.id === input.card_id);
    if (!card) {
      throw new AppError(404, "That card is not on this project's board.").withCode(REQUEST_MOVE_CARD_NOT_ON_BOARD);
    }
    const listId = resolveTargetList(board.lists, input.to_list);
    // The SAME route a drag calls, as the human (their bearer): every gate is the route's, not
    // re-implemented here.
    await callRouteAsHuman(
      'kanban.request_move',
      {
        method: 'POST',
        template: '/api/kanban/cards/:cardId/move',
        handler: lazyRoute(cardsRoutes, 'handleMoveCard'),
        params: { cardId: input.card_id },
        body: { listId, ...(input.position !== undefined ? { position: input.position } : {}) },
      },
      ctx,
    );
    return {
      outcome: 'moved',
      message: MOVED_MESSAGE,
      card_id: input.card_id,
      from_list_id: typeof card.listId === 'string' ? card.listId : null,
      to_list_id: listId,
    };
  },
};

/** `projects.get_andon`'s handler (capabilities/projects/assets.ts): the halt read, run as the human. */
export async function getProjectAndonRead(input: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const pid = bound(ctx, 'projects.get_andon');
  if (typeof input.id === 'string' && input.id !== '' && input.id.toLowerCase() !== pid.toLowerCase()) {
    throw new ProjectMismatchError('projects.get_andon', 'id', pid);
  }
  const body = (await callRouteAsHuman(
    'projects.get_andon',
    { method: 'GET', template: '/api/projects/:id/andon', handler: lazyRoute(andonRoutes, 'handleGetProjectAndon'), params: { id: pid } },
    ctx,
  )) as { data?: { project_id?: unknown } } | null;
  // The answer must name the bound project — checked, not trusted.
  const pidOut = body?.data?.project_id;
  if (typeof pidOut !== 'string' || pidOut.toLowerCase() !== pid.toLowerCase()) {
    throw new AppError(502, 'projects.get_andon: the route answered for a different project').withCode('project_answer_mismatch');
  }
  return body;
}

const getAndonCapability = PROJECT_ANDON_READ_CAPABILITIES.find((c) => c.id === 'projects.get_andon');
if (!getAndonCapability) throw new Error('capabilities/projects/assets.ts: projects.get_andon is not declared');
/** DERIVED from its declaration (SPEC §3.4 c). */
export const getProjectAndonAction = deriveAgentAction(getAndonCapability) as AgentCallableAction;

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerKanbanCardActions(): void {
  safeRegister(withInvokeCard(createCardAction));
  safeRegister(withInvokeCard(requestMoveAction));
  safeRegister(getProjectAndonAction);
}

registerKanbanCardActions();

