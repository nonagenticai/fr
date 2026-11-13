/**
 * kanban.add_comment AG-UI action.
 *
 * Adds a comment to a Planka card identified by UUID, attributing authorship
 * to the calling user by prefixing `via @<user_email>:` to the body. The
 * Planka-layer author is the agent service account; the prefix preserves human
 * attribution in a way that survives Planka's auth model.
 *
 * TENANT GATE: the card's board must be writable by `ctx.tenantId`
 * (`assertCardTenantWritable`, the same gate the kanban comment route runs)
 * BEFORE any Planka write; a foreign or unknown card is a 404.
 *
 * Action kind = `write`. The handler calls
 * `plankaClient.asAgent().comments.create` — it MUTATES. `kind` is the field
 * that decides whether `registry.ts` applies the approval gate at all:
 * `registerAction` (registry.ts:~254) rejects write+auto, and `invokeAction`
 * (registry.ts:351) routes a write to the approval backend INSTEAD of running
 * the handler. A mutating handler labelled `read` therefore does not "skip a
 * naming convention", it silently bypasses the gate and posts the comment.
 *
 * This previously read `kind: 'read'`, justified as "reachable ONLY via the
 * explicit `comment <uuid>: <text>` chat verb, so there is no LLM
 * hallucination risk". Both halves are false against the code:
 *   - `domain/engagement/command-grammar.ts` does not filter on `kind`, and
 *     `channels/index.ts` already handles a returned `PendingAction` (it posts
 *     an `approval-request` reply). Nothing about verb dispatch needs `read`.
 *   - `llm-resolver.ts buildSystemPrompt()` enumerates the FULL registry via
 *     `listActions()` with no `kind` filter, so this action is in the model's
 *     catalog and an LLM pick at confidence >= 0.7 invoked it with no
 *     approval — exactly the hallucinated side-effect the gate exists for.
 *
 * APPROVAL. `single-approver / initiator` + `autoApproveForInitiator: true`,
 * the shape kanban-card.ts uses. Deliberately NOT `approver: 'project-owner'`:
 * the channel dispatcher builds its `ActionContext` with `projectId: null` and
 * `resolveRequiredApprovers` throws `ProjectOwnerRequiredError` on a null
 * projectId — that shape would make every chat `comment` command fail.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import { withInvokeCard } from '../capability-invoke-card';
import type { ActionContext, AgentCallableAction } from '../types';
import { plankaClient } from '../../services/planka';
import { formatCommentBody } from '../../services/planka/comment-attribution';
import { keycloak } from '../../services/keycloak';
import { db } from '../../db/client';
import { assertCardTenantWritable, resolveCardBoardOrRefuse } from '../../lib/board-tenant-access';
import { NotFoundError } from '../../utils/errors';
import { projects } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { ProjectMismatchError } from '../../agent/project-binding';
import { tryCtxTenantId } from '../../middleware/request-context';
import { createHash } from 'node:crypto';

// D3 — idempotency keys hash the FULL content. A 64-char prefix made two
// distinct writes sharing a prefix collide onto one cached result.
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** The bound project's Planka board id, or null. */
async function projectBoardId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ board: projects.planka_board_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.board ?? null;
}

/**
 * fr-agui SPEC §13 P1c — re-homed into the PROJECT agent, bound project only.
 * In a project-bound context (`ctx.projectId`) the card must sit on THAT
 * project's board; a card of another project of the same tenant is refused
 * `project_mismatch` (binding correctness, not a tenant breach — P1-TEAM). The
 * channel `comment <card>: <text>` grammar is unbound and unchanged.
 */
export async function assertCardOnBoundProject(
  cardId: string,
  ctx: Pick<ActionContext, 'projectId'>,
  actionName = 'kanban.add_comment',
): Promise<void> {
  if (!ctx.projectId) return;
  const [board, bound] = await Promise.all([
    // The card's Planka board (404 when it cannot be resolved — fail closed).
    resolveCardBoardOrRefuse(cardId, 'card_write'),
    projectBoardId(ctx.projectId),
  ]);
  if (!bound || String(board) !== String(bound)) {
    throw new ProjectMismatchError(actionName, 'card_id', ctx.projectId);
  }
}

// Planka 2.x uses Snowflake-style numeric ids for cards (e.g. "1764170980260840476"),
// not UUIDs. Older Planka deployments used UUIDs. Accept either: any non-empty
// alphanumeric+hyphen+underscore string up to 64 chars. Upstream Planka rejects
// genuinely malformed ids, so we don't need stricter validation here.
const cardIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

const inputSchema = z.object({
  /**
   * fr-agui P2: the project this write targets — the PROJECT PARAMETER
   * (agui/agent-surface.ts PROJECT_BINDING): removed from the model's schema
   * and set from the thread in a bound context, required by the confirm card's
   * route (POST /api/capabilities/:id/invoke). Unused outside a project.
   */
  project_id: z.string().uuid().optional(),
  /** Planka card id — Snowflake (numeric) or UUID, depending on Planka version. */
  card_id: cardIdSchema,
  /** Comment body text (1–8000 chars). */
  text: z.string().min(1).max(8000),
});

const outputSchema = z.object({
  comment_id: z.string(),
  card_id: z.string(),
  /** The actual posted body including the `via @...:` prefix. */
  body: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export const addCommentAction: AgentCallableAction<Input, Output> = {
  name: 'kanban.add_comment',
  kind: 'write',
  description:
    'Add a comment to a Planka card by id. Author attribution is preserved by prefixing "via @<user_email>:" to the body — the Planka-layer author is the agent service account.',
  input: inputSchema,
  output: outputSchema,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human-initiated invocation self-approves inline and adds NO approvals row;
  // an agent / n8n / cron invocation still parks for human review.
  autoApproveForInitiator: true,
  cronSafe: true, // a cron invocation is not self-approved — it parks for review
  idempotencyKey: (i) => `kanban.add_comment:${i.card_id}:${sha256Hex(i.text)}`,
  rbac: { type: 'public' },
  handler: async (input: Input, ctx: ActionContext): Promise<Output> => {
    // ⛔ TENANT GATE before any Planka write. fr writes as its one configured
    // Planka account, which can reach every board, so fr's gate is the whole
    // boundary: the card's board must be writable by the caller's tenant — the
    // same `assertCardTenantWritable` the kept POST /api/kanban/cards/:id/comments
    // route uses. No resolvable tenant ⇒ nothing to authorize ⇒ the same 404,
    // before Planka is dialled (AUTH_BYPASS dev/CI excepted, as in the gate).
    const tenantId = ctx.tenantId ?? tryCtxTenantId();
    if (!tenantId && process.env.AUTH_BYPASS !== 'true') throw new NotFoundError('Card not found');
    await assertCardTenantWritable(
      { id: ctx.userId, tenantId: tenantId ?? '', roles: ctx.tenantRoles ?? [] },
      input.card_id,
      db,
    );
    await assertCardOnBoundProject(input.card_id, ctx);

    // Best-effort email lookup — never let a Keycloak hiccup drop a comment.
    let email: string | null = null;
    try {
      email = (await keycloak.getUserById(ctx.userId))?.email ?? null;
    } catch {
      // intentionally swallowed — fall back to userId attribution
    }

    const body = formatCommentBody(email, input.text, ctx.userId);
    const comment = await plankaClient.asAgent().comments.create({
      cardId: input.card_id,
      text: body,
    });

    return {
      comment_id: comment.id,
      card_id: input.card_id,
      body,
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

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerKanbanCommentActions(): void {
  safeRegister(withInvokeCard(addCommentAction));
}

registerKanbanCommentActions();

