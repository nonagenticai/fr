/**
 * fr-agui SPEC §6.0 / §13 P1b — the doorway agent's project-request tools,
 * DERIVED from the declarations in capabilities/project-requests/requests.ts.
 *
 * READS run server-side here, and each one runs the very query its route runs
 * (`listProjectRequestRows`, `loadRequestInTenant` + `projectRequestDetail`,
 * `projectRequestOutlineItems`, `assessRepoAccess`) in the session's tenant —
 * the same tenant scope and the same 404 the classic UI gets.
 *
 * WRITES are never executed here: on the web they are PROPOSED (SPEC §5.2 W) and
 * the `project-request` confirm card calls the route under the human's own
 * session; they are web-only, so a channel invocation is refused before parking.
 *
 * `project_requests.create` (the Common Practice bridge intake, service account
 * only) is declared but NOT agent-exposed, so it is not registered here.
 */
import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import { PROJECT_REQUEST_CAPABILITIES } from '../../capabilities/project-requests/requests';
import {
  listProjectRequestRows,
  loadRequestInTenant,
  projectRequestDetail,
} from '../../routes/project-requests';
import { projectRequestOutlineItems } from '../../routes/project-request-lifecycle';
import { assessRepoAccess } from '../../services/repo-access';
import { AppError } from '../../utils/errors';

function requireTenant(ctx: ActionContext): string {
  if (!ctx.tenantId) {
    throw new AppError(409, 'no workspace is resolved for this session').withCode('tenant_required');
  }
  return ctx.tenantId;
}

/** A list row the model can name and open; the full row is `project_requests.get`. */
export interface ProjectRequestListItem {
  id: string;
  status: string;
  name: string | null;
  project_type: string | null;
  project_id: string | null;
  created_at: string | null;
  url: string;
}

function payloadString(payload: unknown, key: string): string | null {
  const v = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() ? v : null;
}

export async function projectRequestsListHandler(
  _input: Record<string, never>,
  ctx: ActionContext,
): Promise<{ items: ProjectRequestListItem[]; total: number }> {
  const rows = await listProjectRequestRows(requireTenant(ctx));
  const items = rows.map((r) => ({
    id: r.id,
    status: r.status,
    name: payloadString(r.payload, 'name'),
    project_type: payloadString(r.payload, 'project_type'),
    project_id: r.project_id ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : null,
    url: `/projects/requests/${r.id}`,
  }));
  return { items, total: items.length };
}

export async function projectRequestsGetHandler(input: { id: string }, ctx: ActionContext) {
  return projectRequestDetail(await loadRequestInTenant(requireTenant(ctx), input.id));
}

export async function projectRequestsListOutlinesHandler(input: { id: string }, ctx: ActionContext) {
  const row = await loadRequestInTenant(requireTenant(ctx), input.id);
  return { items: await projectRequestOutlineItems(row) };
}

export async function projectRequestsVerifyRepoAccessHandler(input: { urls: string[] }, ctx: ActionContext) {
  // The ACTIVE tenant decides whether internal-owner repos may be probed, as on the route.
  return { items: await assessRepoAccess(input.urls, { tenantId: requireTenant(ctx) }) };
}

/** fr-agui SPEC §3.4 (c): DERIVED — one action per agent-exposed declaration. */
export const projectRequestActions: ReadonlyArray<AgentCallableAction> = PROJECT_REQUEST_CAPABILITIES.filter(
  (c) => c.agent.expose,
).map((c) => deriveAgentAction(c) as AgentCallableAction);

function safeRegister(a: AgentCallableAction): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

export function registerProjectRequestActions(): void {
  for (const a of projectRequestActions) safeRegister(a);
}

registerProjectRequestActions();
