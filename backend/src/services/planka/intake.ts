import { ensureConveyorMembership } from './conveyor-membership';
import { ensureWebhookSubscription } from './webhook-subscription';
import type { PlankaClient } from './index';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import type { Project, Board } from './types';
import type { BoardSpec } from '../catalogue/board-template';
import { provisionBoardFieldGroups } from './custom-fields';

// The board's lists, labels and custom-field groups come from the tenant's
// requirements_management BOARD TEMPLATE for the project type (falling back to
// the tenant's `default` template) — services/catalogue/board-template.ts
// `boardSpecFor`. There is no list of list names here any more (was
// DEFAULT_LIST_NAMES). RM's v3 default template lists TODO, READY, DOING, QA,
// BLOCKED, DONE, DROPPED (closed: DONE, DROPPED).

export interface IntakeInput {
  name: string;
  description?: string;
}

export interface IntakeResult {
  project: Project;
  board: Board;
  /** list name → list id, for every list the template defined. */
  listIds: Record<string, string>;
  /** The template the board was built from (lists, labels, field groups); absent when no board was built (adopt). */
  spec?: BoardSpec;
}

/**
 * Create a project + board (lists, labels and custom-field groups from the tenant's RM board template,
 * `spec`) in Planka. It creates NO card (George 2026-10-12: fr is a facilitator and
 * never creates or moves Planka cards; v4 R80/R81: n8n's trigger.conveyor_start
 * creates the first card).
 *
 * Everything runs as fr's ONE configured Planka account (`agent`, see
 * with-auth.ts): Planka use is per tenant, not per user (George, 2026-10-10),
 * so no fr user is created in, resolved in, or granted access to Planka. The
 * account needs a Planka role that may POST /api/projects (admin or
 * projectOwner); Planka makes the creator a board member, so every later
 * kanban request — also made as that account — can reach the board. fr's own
 * gates (tenant checks, `assertBoardTenantWritable`) decide which fr user may
 * act on it.
 *
 * The one extra membership is the n8n conveyor's Planka user, granted editor
 * on PLATFORM-tenant boards only (conveyor-membership.ts; fails closed).
 */
export async function createProjectWithDefaultBoard(
  agent: PlankaClient,
  input: IntakeInput,
  /** Tenant that OWNS the new board. Only a platform tenant's board gets the
   *  n8n conveyor's Planka user as editor (see conveyor-membership.ts);
   *  omitted ⇒ treated as non-platform (fail closed). */
  tenantId: string | undefined,
  /** The board template (services/catalogue/board-template.ts boardSpecFor). */
  spec: BoardSpec,
): Promise<IntakeResult> {
  const project = await agent.projects.create({
    name: input.name,
    description: input.description,
    type: 'private',
  });
  // ⛔ COMPENSATION. Everything below runs after the Planka project EXISTS. A
  // failure in any later step (board, lists, labels, fields) used to leave that project —
  // and any board under it — orphaned in Planka with no fr row pointing at it.
  // Undo best-effort (board first: Planka refuses to delete a project that still
  // holds boards), report each undo failure, then rethrow the ORIGINAL error.
  let boardId: string | undefined;
  try {
    // Planka 2.1.0 requires position > 0 on board create (422 "Position must be
    // present" otherwise). Use the same 65536 base used for lists.
    const board = await agent.boards.create({ projectId: project.id, name: input.name, position: 65536 });
    boardId = board.id;
    // Never throws; a skip/failure is logged inside (deployment#4397).
    await ensureConveyorMembership(agent, { boardId: board.id, tenantId });
    // Throws: a board no webhook serves never runs a flow (webhook-subscription.ts).
    await ensureWebhookSubscription(agent, { boardId: board.id, tenantId });

    const listIds: IntakeResult['listIds'] = {};
    for (let i = 0; i < spec.lists.length; i++) {
      const { name } = spec.lists[i]!;
      const list = await agent.lists.create({ boardId: board.id, name, position: (i + 1) * 65536 });
      listIds[name] = list.id;
    }
    for (let i = 0; i < spec.labels.length; i++) {
      const label = spec.labels[i]!;
      await agent.labels.create({ boardId: board.id, name: label.name, color: label.color, position: (i + 1) * 65536 });
    }
    // The template's custom-field groups + fields (v4 ruling 12). This is the
    // ONLY moment fr creates board fields; card writers never add one later.
    if (spec.fieldGroups.length > 0) {
      await provisionBoardFieldGroups(agent, board.id, spec.fieldGroups);
    }

    return { project, board, listIds, spec };
  } catch (err) {
    await compensateIntake(agent, project.id, boardId);
    throw err;
  }
}

/** Best-effort undo of a half-built intake. Never throws. */
async function compensateIntake(agent: PlankaClient, projectId: string, boardId: string | undefined): Promise<void> {
  if (boardId) {
    try {
      await agent.boards.delete(boardId);
    } catch (undoErr) {
      reportSwallowedFailure(undoErr, {
        service: 'planka',
        method: 'DELETE',
        path: `/api/boards/${boardId}`,
        degradedTo: 'orphan Planka board left after a failed intake',
      });
    }
  }
  try {
    await agent.projects.delete(projectId);
  } catch (undoErr) {
    reportSwallowedFailure(undoErr, {
      service: 'planka',
      method: 'DELETE',
      path: `/api/projects/${projectId}`,
      degradedTo: 'orphan Planka project left after a failed intake',
    });
  }
}

/**
 * Undo the Planka project + board of an fr project create that failed AFTER
 * `createProjectWithDefaultBoard` succeeded (George 2026-10-13, v4 D15/R16: the
 * RM POST is the create's LAST fallible step, so a failure there — or at the fr
 * row — leaves only Planka to compensate; RM refuses a DELETE). Best effort,
 * NEVER throws: every failure is reported via reportSwallowedFailure. The agent
 * is passed by the caller (routes/projects.ts `projectCreateDeps.plankaAsAgent`).
 */
export async function discardPlankaProjectOfFailedCreate(
  agent: PlankaClient,
  created: { projectId: string; boardId: string },
): Promise<void> {
  await compensateIntake(agent, created.projectId, created.boardId);
}
