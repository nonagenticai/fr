/**
 * fr-agui SPEC §13 P3 — the project agent's EXECUTION OBSERVABILITY reads
 * (handlers of capabilities/projects/execution.ts):
 *
 *   projects.list_executions          every fr-initiated run of the project (all members')
 *   projects.get_wip                  RM's WIP limit + the board count ("not n8n's enforced count")
 *   projects.list_blocked_cards       BLOCKED-lane cards, block reason, open escalation gate
 *   projects.list_agent_actions       capability_audit (actor, capability, outcome, time)
 *   projects.list_cards_by_type       cards of one RM card type of the project's type
 *   projects.list_conveyor_executions §7.4a — available:false until the conveyor tags its runs
 *   projects.list_conveyor_notices    R311 — start_failed / coach_failed notices + the start retry offer
 *   projects.list_flow_runs           cockpit R-CK5 — the n8n execution-hook record of the project's flow runs
 *
 * and one WRITE, proposed on a confirm card (R311 PR 5, kanban-coach-errors.md §2.5, R-8):
 *
 *   projects.retry_conveyor_start     "Start again": the start retry, or (`scope`) a project / phase
 *                                     restart (POST /api/projects/:id/conveyor-start/retry), on EVERY
 *                                     channel (George 2026-10-30/31) through the route's own
 *                                     `runStartAgain`. The route refuses what is not offered; the agent
 *                                     offers, the caller confirms (fr is a facilitator, never a judge).
 *
 * ⭐ Each read runs the Execution hub's OWN route as the HUMAN
 * (`callRouteAsHuman`, agui/actions/project-core.ts): same identity, same gate
 * (`loadProjectForRead`, P1-TEAM-a), same answer as the page — SPEC §10.3 parity
 * by construction. The project is the thread's (`id`, injected; another id is
 * refused `project_mismatch`), and the route's answer (`{ data }`) must name that
 * same project (`data.project_id`) or it is refused — so every read carries the
 * bound projectId, verified rather than assumed. The agent gets the route's
 * body as the page does (`{ data }`, validated against the capability's output).
 */
import { createHash } from 'node:crypto';

import { registerAction } from '../registry';
import { z } from 'zod';

import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';
import { ProjectMismatchError } from '../../agent/project-binding';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';
import { getEndUserToken, getSuperAdminSwitchToken } from '../../integrations/_lib/context';
import { tryCtxTenantId } from '../../middleware/request-context';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import { EXECUTION_READ_TABLE, PROJECT_EXECUTION_CAPABILITIES } from '../../capabilities/projects/execution';

const routes = () => import('../../routes/project-execution');

function execRead(id: string) {
  const row = EXECUTION_READ_TABLE.find((r) => r.id === id);
  if (!row) throw new Error(`no execution read ${id}`);
  return async (input: Record<string, unknown>, ctx: ActionContext): Promise<unknown> => {
    const pid = bound(ctx, id);
    if (typeof input.id === 'string' && input.id !== '' && input.id.toLowerCase() !== pid.toLowerCase()) {
      throw new ProjectMismatchError(id, 'id', pid);
    }
    const query = Object.fromEntries(row.query.map((q) => [q, input[q] === undefined || input[q] === null ? undefined : String(input[q])]));
    const body = (await callRouteAsHuman(
      id,
      { method: 'GET', template: row.path, handler: lazyRoute(routes, row.handler), params: { id: pid }, query },
      ctx,
    )) as { data?: { project_id?: unknown } } | null;
    // Every answer carries the bound project (SPEC §13 P3 acceptance) — checked, not trusted.
    const data = body?.data;
    if (typeof data?.project_id !== 'string' || data.project_id.toLowerCase() !== pid.toLowerCase()) {
      throw new AppError(502, `${id}: the route answered for a different project`).withCode('project_answer_mismatch');
    }
    return body;
  };
}

export const listExecutionsRead = execRead('projects.list_executions');
export const getWipRead = execRead('projects.get_wip');
export const listBlockedCardsRead = execRead('projects.list_blocked_cards');
export const listAgentActionsRead = execRead('projects.list_agent_actions');
export const listCardsByTypeRead = execRead('projects.list_cards_by_type');
export const listConveyorExecutionsRead = execRead('projects.list_conveyor_executions');
export const listConveyorNoticesRead = execRead('projects.list_conveyor_notices');
export const listFlowRunsRead = execRead('projects.list_flow_runs');

// ---------------------------------------------------------------------------
// R311 PR 5 — the start retry (a human-confirmed write)
// ---------------------------------------------------------------------------

const retryInput = z.object({
  project_id: z.string().uuid().describe('The project (set from this conversation; never chosen by the model).'),
  scope: z
    .enum(['project', 'phase'])
    .optional()
    .describe(
      "Absent = the start retry. 'project' = restart the WHOLE project; 'phase' = restart ONE phase (the current one or an earlier one). Every card in " +
        "that scope runs again, finished ones included, and the conveyor's open questions on this project, plus open " +
        'requests about its cards, are withdrawn (George 2026-10-31).',
    ),
  phase: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "With scope 'phase' (required then): the phase the user chose, one of projects.list_conveyor_notices `restart.phases[].name` " +
        '(the current phase or an earlier one); anything else is refused 409 restart_phase_invalid.',
    ),
  comment: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe("A restart only: the user's optional comment to steer the restarted run (their words, as written)."),
  idempotency_key: z.string().min(1).max(200).optional().describe('Set by the confirm card.'),
});
type RetryInput = z.infer<typeof retryInput>;

/**
 * Run "Start again" for the agent action's caller — ONE path with the web route
 * (routes/project-conveyor-start.ts `runStartAgain`). In the browser (the human's own token
 * is on the request, or a switched super-admin's), it runs the route itself as that human, so
 * the confirm card does exactly what the page's button does. On any other channel (Telegram,
 * the fr MCP, an approved parked action) there is no browser token: the caller is the
 * action's resolved member — `ctx.userId` in `ctx.tenantId` with their realm roles — and the
 * same project WRITE lane decides (any member of the project's tenant; archived → 409).
 */
export async function startAgainAsCaller(i: RetryInput, ctx: ActionContext): Promise<unknown> {
  const pid = ctx.projectId ?? i.project_id;
  if (!pid) throw new AppError(409, 'projects.retry_conveyor_start works on a project').withCode('project_required');
  const comment = i.comment?.trim();
  const restart = i.scope ? { scope: i.scope, ...(i.phase ? { phase: i.phase } : {}), ...(comment ? { comment } : {}) } : null;
  const routes = () => import('../../routes/project-conveyor-start');
  if (getEndUserToken() || getSuperAdminSwitchToken()) {
    return callRouteAsHuman(
      'projects.retry_conveyor_start',
      {
        method: 'POST',
        template: '/api/projects/:id/conveyor-start/retry',
        handler: lazyRoute(routes, 'handleRetryProjectConveyorStart'),
        params: { id: pid },
        // No scope ⇒ no body: the start retry, exactly as before.
        ...(restart ? { body: restart } : {}),
      },
      ctx,
    );
  }
  const tenantId = ctx.tenantId ?? tryCtxTenantId();
  if (!tenantId) throw new AppError(404, 'Project not found');
  const { runStartAgain } = await routes();
  return { data: await runStartAgain({ id: ctx.userId, tenantId, roles: ctx.realmRoles ?? [] }, pid, restart) };
}

export const projectsRetryConveyorStartAction: AgentCallableAction<RetryInput, unknown> = {
  name: 'projects.retry_conveyor_start',
  kind: 'write',
  description:
    "Retry this project's conveyor start — the project page's \"Start again\" / the Execution hub's \"Retry the conveyor start\" button. Only when " +
    'projects.list_conveyor_notices says `retry.available` (after a recorded start failure, an undelivered start, a failed ' +
    "board link, `no_progress`: the start was accepted 10+ minutes ago but the project has not started moving, or `stalled`: its first " +
    'step has not moved for 30+ minutes); otherwise it is refused with the reason ' +
    "(`on_hold`: the project is on hold, release that first). When `retry.reason` is 'refused_by_conveyor' or 'restart_not_done', tell the user " +
    "`retry.message` as written and do not propose a retry. Propose it when the user wants to retry; never decide to on your own. " +
    'On their confirm, fr sends the start again under a new key and records the attempt. ' +
    "RESTART (`scope`): when projects.list_conveyor_notices says `restart.available`, the user may restart the whole project " +
    "(`scope: 'project'`) or one phase (`scope: 'phase'`, `phase` = one of `restart.phases[].name`: the current phase or an earlier " +
    "one, when the user found the problem started there), with an optional `comment` from the user to steer the run " +
    "(offer that phase's `default_comment` — the comment given when that phase's start was signed off). Tell them every card in that " +
    "scope runs again, including finished ones, and that the conveyor's open questions on this project, plus open requests " +
    'about its cards, are withdrawn; propose it only when they want to start over.',
  input: retryInput,
  output: z.unknown(),
  // The human's Confirm IS the approval (projects.provision's pattern): it runs inline for the initiator.
  approval: { type: 'single-approver', approver: 'initiator' },
  autoApproveForInitiator: true,
  cronSafe: false,
  // `public` + the handler's project WRITE lane (runStartAgain → loadTenantScopedProject), the
  // web route's own rights check: on a channel there is no bound project for a `project-member`
  // rule to read. In the bound web rail the registry still applies project-member (editor) first.
  rbac: { type: 'public' },
  projectParam: 'project_id',
  // Every channel (George 2026-10-30/31: web, Telegram and the fr MCP are equivalent; fr gates
  // nothing as web-only). The web confirms on its card; a channel parks it like any other write.
  confirm: { http: { method: 'POST', path: '/api/capabilities/projects.retry_conveyor_start/invoke' }, card: 'capability-invoke' },
  idempotencyKey: (i) =>
    `projects.retry_conveyor_start:${i.project_id}:${i.scope ?? ''}:${i.phase ?? ''}:${createHash('sha256').update(i.comment ?? '').digest('hex')}:${i.idempotency_key ?? ''}`,
  handler: async (i, ctx) => startAgainAsCaller(i, ctx),
};

/** The P3 reads, DERIVED from their declarations (SPEC §3.4 c). */
export const PROJECT_EXECUTION_ACTIONS: ReadonlyArray<AgentCallableAction> = PROJECT_EXECUTION_CAPABILITIES.map(
  (c) => deriveAgentAction(c) as AgentCallableAction,
);

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerProjectExecutionActions(): void {
  for (const a of PROJECT_EXECUTION_ACTIONS) safeRegister(a);
  safeRegister(projectsRetryConveyorStartAction);
}
