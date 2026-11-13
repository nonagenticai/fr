/**
 * fr-agui — `projects.close`, the conveyor's CLOSE step: the fr half of MCP
 * capability 4 (contract: `~/.claude/handoffs/caller-identity-2026-10-30/FR-CLOSE-CONTRACT.md`).
 *
 * The agent platform drives fr over the MCP channel. `projects.create` and
 * `projects.get` already run there, and an MCP `fr_project` task ends
 * `succeeded` only once fr's project reads `delivered` — but nothing could
 * make it do that: `projects.archive`
 * (agui/actions/project-outputs.ts) is a DESTRUCTIVE typed-confirm card a human
 * fills in (its `confirm_name` is a human field) and it makes the run read
 * `cancelled`. This is the agent-usable path.
 *
 * ⭐ A CLOSE IS RM'S, NOT A DELETION. The fr project row stays LIVE — no
 * archive, no purge, no board teardown. It closes the project's RM
 * `pm_project` through the SAME step the archive runs first
 * (`closeRmProjectOfArchive`, services/catalogue/project-state.ts), which is
 * what the delivery derivation reads (services/project-delivered.ts): RM says
 * `closed` ⇒ the project answers `delivered`. That answer is what ends the MCP
 * run (nonagenticai_mcp_server `src/external/fr.py` maps `delivered` →
 * `succeeded`).
 *
 * Identity: the project is loaded with the doorway read's OWN query
 * (`selectProjectVisibleToGetProject`, agui/actions/projects-read.ts) for the
 * calling agent member, so a missing id and another tenant's project are ONE
 * answer — 404 `project_not_found`, never a 403 that leaks existence.
 *
 * Approval: `single-approver / initiator` + `autoApproveForInitiator`, so the
 * agent member's typed `projects.close {"id":…}` on the sender-verified MCP
 * channel runs inline as that member (fr#1683, owner rulings 2026-10-31: the
 * agent member is fr's autonomous user, a normal member within its
 * admin-assigned role). Any other initiator — the agent token, n8n, cron —
 * still parks an approval for a person.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { isAuthenticatedTenantUser } from '../../capabilities/rbac-rules';
import { isUuidShape } from '../../lib/uuid-shape';
import { selectProjectVisibleToGetProject } from '../../routes/projects';
import {
  closeRmProjectOfArchive,
  projectStatesFor,
  type ProjectStateRow,
  type RmArchiveClose,
} from '../../services/catalogue/project-state';
import { deliveryFromRm, listProjectDeliverables } from '../../services/project-delivered';
import { AppError, NotFoundError } from '../../utils/errors';
import { agentProjectReader, projectSummary } from './projects-read';

/**
 * The contract's answer shape — the MCP side reads exactly these keys.
 * `status` is the DERIVED value after the close (expect `delivered`), not the
 * stored row's.
 */
export const projectsCloseOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  project_type: z.string().nullable(),
  status: z.string(),
  phase: z.string().nullable(),
  url: z.string(),
  delivered_at: z.string().nullable(),
  delivery_evidence: z.unknown(),
  deliverables: z.array(z.object({ title: z.string(), url: z.string().optional() })),
  closed: z.literal(true),
  already_closed: z.boolean(),
  rm_pm_project_id: z.string(),
});
export type ProjectsCloseOutput = z.infer<typeof projectsCloseOutputSchema>;

/**
 * ⚠️ `id` is a plain OPTIONAL string on purpose. The contract's refusal for a
 * missing or malformed id is `invalid_input` (a stable MCP failure code that
 * survives `mcpRefusalCode` verbatim); a `z.string().uuid()` here would fail
 * earlier, in the registry, and answer `action_input_validation_failed`
 * instead. The handler makes the check.
 */
export const projectsCloseInputSchema = z.object({
  id: z.string().optional().describe('The project id (a uuid).'),
});
export type ProjectsCloseInput = z.infer<typeof projectsCloseInputSchema>;

/**
 * Close `project`'s RM pm_project — the archive's own RM step
 * (`closeRmProjectOfArchive`) — mapped to this contract's refusals:
 *   - RM holds no pm_project (no tenant tag, no row of this origin, RM's 404 on
 *     the close) ⇒ 409 `no_rm_project`; nothing was guessed;
 *   - any other RM failure ⇒ 502 `rm_project_close_failed`; nothing changed.
 * Exported for the DB test: a project with NO tenant tag is visible to no
 * tenant, so the handler 404s it before this point — that branch is proved
 * here directly, exactly as tests/unit/db/archive-closes-rm.test.ts proves the
 * archive's.
 */
export async function closeProjectRm(
  project: ProjectStateRow & { status: string },
): Promise<{ already_closed: boolean; rm_pm_project_id: string }> {
  let out: RmArchiveClose;
  try {
    out = await closeRmProjectOfArchive(project);
  } catch (err) {
    console.error(`[projects.close] closing the RM project of ${project.id} failed; nothing changed:`, err);
    throw new AppError(
      502,
      "the project's requirements_management project could not be closed — nothing changed; retry",
      { project_id: project.id },
    ).withCode('rm_project_close_failed');
  }
  if (out.kind === 'no_rm_project') {
    throw new AppError(
      409,
      `project ${project.id} has no requirements_management pm_project to close (${out.reason})`,
      { project_id: project.id },
    ).withCode('no_rm_project');
  }
  return { already_closed: out.alreadyClosed, rm_pm_project_id: out.rmPmProjectId };
}

/** The `projects.close` handler (the shape is the contract's, FR-CLOSE-CONTRACT.md § Response). */
export async function projectsCloseHandler(
  input: ProjectsCloseInput,
  ctx: ActionContext,
): Promise<ProjectsCloseOutput> {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!isUuidShape(id)) {
    throw new AppError(
      400,
      'projects.close needs the project id: projects.close {"id":"<project uuid>"}',
    ).withCode('invalid_input');
  }
  // The GET's own loader and don't-leak-existence 404: foreign, untagged and
  // missing are one answer.
  const project = await selectProjectVisibleToGetProject(agentProjectReader(ctx), id);
  if (!project) throw new NotFoundError('Project not found').withCode('project_not_found');
  // An archived row is a deleted project (services/project-archive.ts), not a
  // live one: refuse rather than close RM behind a project the UI has dropped.
  if (project.status === 'archived') {
    throw new AppError(409, `project ${project.id} is archived — no live project to close`).withCode('project_archived');
  }
  const closed = await closeProjectRm(project);
  // Re-derive AFTER the close, exactly as `projects.get` does: RM's closed row
  // is what makes the project read `delivered` (reads derive, they never
  // write — D-run12-9). A re-read that fails does not undo the close; it
  // answers the row's own state instead.
  const [state] = (await projectStatesFor([project])).values();
  const delivery = deliveryFromRm(project, state?.ok ? state.state : undefined);
  return {
    ...projectSummary({ ...project, status: delivery.status }),
    phase: state?.ok ? state.state.phase : null,
    delivered_at: delivery.delivered_at ? delivery.delivered_at.toISOString() : null,
    delivery_evidence: delivery.delivery_evidence ?? null,
    deliverables: await listProjectDeliverables(project.id),
    closed: true,
    already_closed: closed.already_closed,
    rm_pm_project_id: closed.rm_pm_project_id,
  };
}

export const projectsCloseAction: AgentCallableAction<ProjectsCloseInput, ProjectsCloseOutput> = {
  name: 'projects.close',
  kind: 'write',
  description:
    'Close this project — the requirements_management project behind it is set to closed and the project then reads ' +
    '`delivered`. Use it when the work is finished. The fr project is NOT archived. Idempotent: an already-closed ' +
    'project answers already_closed: true.',
  input: projectsCloseInputSchema,
  output: projectsCloseOutputSchema,
  approval: { type: 'single-approver', approver: 'initiator' },
  // A typed `projects.close {"id":…}` on a sender-verified channel (mcp) is the
  // member's own act and runs inline (shouldSelfApprove); any other initiator
  // still parks for a person.
  autoApproveForInitiator: true,
  cronSafe: true, // a cron invocation is not self-approved — it parks for review
  // `id` is the project parameter (fr-agui SPEC §5.7 rule 3): in a project-bound
  // thread it is injected from the thread and any other id is refused
  // `project_mismatch`; on the MCP channel the caller names it.
  projectParam: 'id',
  idempotencyKey: (i) => `projects.close:${i.id ?? ''}`,
  rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) },
  handler: projectsCloseHandler,
};

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`); idempotent. */
export function registerProjectLifecycleActions(): void {
  safeRegister(projectsCloseAction);
}

registerProjectLifecycleActions();
