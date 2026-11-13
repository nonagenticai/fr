/**
 * fr-agui SPEC §6.0 / §13 P1b — the doorway agent's project reads,
 * `projects.list` and `projects.get` (capabilities/projects/{list,get}.ts), so the
 * request-intake agent can find the caller's projects and open one.
 *
 * ⭐ ONE QUERY, NOT TWO. Each handler runs the very query its route runs —
 * `selectListedProjectRows` (GET /api/projects) and
 * `selectProjectVisibleToGetProject` (GET /api/projects/:id) — for the agent's
 * read identity: the session's user + tenant plus the realm roles of the
 * VERIFIED forwarded portal token (`ctx.realmRoles`, routes/agent.ts). So the
 * agent sees exactly the projects the classic UI shows the same person; a
 * super-admin in home view gets the GET's tag-bounded relaxation, everyone
 * else the owner-scoped answer.
 *
 * The output is a SUMMARY (id, name, type, status, the shell url; `projects.get`
 * adds phase + the delivery record + deliverables), not the route's full row: the agent needs enough to name and open a project, and the
 * route's enrichments (repositories, RM state) are the project shell's job.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import { projectsListCapability } from '../../capabilities/projects/list';
import { projectsGetCapability } from '../../capabilities/projects/get';
import { ctxTenantId } from '../../middleware/request-context';
import {
  selectListedProjectRows,
  selectProjectVisibleToGetProject,
  type ProjectReadUser,
} from '../../routes/projects';
import { projectStatesFor } from '../../services/catalogue/project-state';
import { deliveryFromRm, listProjectDeliverables, type ProjectDeliverable } from '../../services/project-delivered';
import { AppError, NotFoundError } from '../../utils/errors';

/** At most this many projects go back to the model; `total` is always the true count. */
export const AGENT_PROJECT_LIST_LIMIT = 50;

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  project_type: z.string().nullable(),
  status: z.string(),
  url: z.string(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

interface ProjectRowLike {
  id: string;
  name: string;
  project_type?: string | null;
  status: string;
}

export function projectSummary(p: ProjectRowLike): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    project_type: p.project_type ?? null,
    status: p.status,
    url: `/projects/${p.id}`,
  };
}

/** The agent's read identity — what `validateAuth` would yield for the GET, minus nothing it reads. */
export function agentProjectReader(ctx: ActionContext): ProjectReadUser {
  if (!ctx.tenantId) {
    throw new AppError(409, 'no workspace is resolved for this session').withCode('tenant_required');
  }
  return { id: ctx.userId, tenantId: ctx.tenantId, roles: [...(ctx.realmRoles ?? [])] };
}

const TRUE_FLAGS = ['1', 'true', 'yes'];

export async function projectsListHandler(
  input: { include_archived?: string; programme_id?: string },
  ctx: ActionContext,
): Promise<{ projects: ProjectSummary[]; total: number; shown: number }> {
  const user = agentProjectReader(ctx);
  const rows = await selectListedProjectRows(user, ctxTenantId(user.tenantId), {
    includeArchived: TRUE_FLAGS.includes((input.include_archived ?? '').trim().toLowerCase()),
    programmeId: input.programme_id ?? null,
  });
  const listed = rows.slice(0, AGENT_PROJECT_LIST_LIMIT);
  // RM closed ⇒ the row reads delivered, derived per read like the web list (services/project-delivered.ts;
  // the reconcile worker is the only writer, and this read writes nothing).
  const states = await projectStatesFor(listed.map((r) => r.project));
  const shown = listed.map((r) => {
    const st = states.get(r.project.id);
    return projectSummary({ ...r.project, status: deliveryFromRm(r.project, st?.ok ? st.state : undefined).status });
  });
  // `total` is the full count the query admitted; `shown` how many came back.
  return { projects: shown, total: rows.length, shown: shown.length };
}

export interface ProjectDetail extends ProjectSummary {
  phase: string | null;
  delivered_at: string | null;
  delivery_evidence: unknown;
  deliverables: ProjectDeliverable[];
}

export async function projectsGetHandler(input: { id: string }, ctx: ActionContext): Promise<ProjectDetail> {
  const project = await selectProjectVisibleToGetProject(agentProjectReader(ctx), input.id);
  // The GET's own don't-leak-existence 404: foreign, untagged and missing are one answer.
  if (!project) throw new NotFoundError('Project not found');
  // The closure an MCP project task waits for (services/project-delivered.ts):
  // RM's phase, the delivery record, and the agreed deliverables.
  const [state] = (await projectStatesFor([project])).values();
  const delivery = deliveryFromRm(project, state?.ok ? state.state : undefined);
  return {
    ...projectSummary({ ...project, status: delivery.status }),
    phase: state?.ok ? state.state.phase : null,
    delivered_at: delivery.delivered_at ? delivery.delivered_at.toISOString() : null,
    delivery_evidence: delivery.delivery_evidence ?? null,
    deliverables: await listProjectDeliverables(project.id),
  };
}

/** fr-agui SPEC §3.4 (c): DERIVED from the declarations. */
export const projectsListAction: AgentCallableAction = deriveAgentAction(projectsListCapability) as AgentCallableAction;
export const projectsGetAction: AgentCallableAction = deriveAgentAction(projectsGetCapability) as AgentCallableAction;

function safeRegister(a: AgentCallableAction): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

export function registerProjectsReadActions(): void {
  safeRegister(projectsListAction);
  safeRegister(projectsGetAction);
}

registerProjectsReadActions();
