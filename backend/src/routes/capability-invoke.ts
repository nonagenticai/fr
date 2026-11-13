/**
 * fr-agui SPEC §5.2 (W) — `POST /api/capabilities/:id/invoke`: the route a
 * confirm card calls for an AGENT-NATIVE write (one with no UI route of its
 * own), under the HUMAN's Keycloak session.
 *
 * Scope: the project agent's confirm-card writes only — an action that is in the
 * `project-core` pack AND whose confirm card names exactly this route
 * (`confirm.http.path === /api/capabilities/<id>/invoke`). Today those are
 * `toc.build_io_map`, `toc.evaporate_conflict` and `toc.evaluate_lenses` on
 * the project's TOC. (`agent.start_procedure` is a READ in code — see
 * agui/actions/agent-procedure.ts — so it has nothing to confirm.) Anything
 * else is 404 `not_invokable`: this is not a generic "run any action" door.
 *
 * Order (§5.2 W): Keycloak bearer → the action → the project named by the
 * input, which the caller must be able to READ (`loadProjectForRead`; a 404 for
 * every unreadable shape, as `GET /api/projects/:id`) → `invokeAction` with
 * `initiator:'human'`, `channel:'web'`, the project as `ctx.projectId` (so the
 * action's own RBAC — e.g. `project-role: editor` — and the project binding
 * apply) and a server-side "confirmed card" mark. The action keeps its declared
 * approval policy: a multi-party or project-owner policy still PARKS (202 with
 * the PendingAction), exactly as a UI write would. The agent token never
 * authorises this route (a Keycloak bearer is required).
 *
 * The response carries `invalidate` (agent/state-invalidate.ts) so the card can
 * raise `state-invalidate`. The request is audited by server.ts when it carries
 * `X-Agent-Proposal-Id` (services/capability-audit.ts).
 */
import { randomUUID } from 'node:crypto';

import { getAction, invokeAction } from '../agui/registry';
import { markConfirmedCard } from '../agui/context-provenance';
import { PROJECT_AGENT_ACTIONS } from '../agui/agent-surface';
import type { ActionContext, AgentCallableAction, PendingAction } from '../agui/types';
import { invalidationsFor } from '../agent/state-invalidate';
import { AppError, handleError } from '../utils/errors';

function invokeRoutePath(actionName: string): string {
  return `/api/capabilities/${actionName}/invoke`;
}

/** The action `id` names, when THIS route may run it; otherwise null. */
function invokableAction(id: string): AgentCallableAction | null {
  const a = getAction(id);
  if (!a || a.kind !== 'write' || !PROJECT_AGENT_ACTIONS.has(a.name)) return null;
  if (a.confirm?.http.method !== 'POST' || a.confirm.http.path !== invokeRoutePath(a.name)) return null;
  return a;
}

interface Who {
  userId: string;
  tenantId: string;
  roles: string[];
  tenantClaim?: string;
}

async function callerPrincipal(req: Request): Promise<Who> {
  const { validateAuthWithToken } = await import('../middleware/auth');
  const { user } = await validateAuthWithToken(req);
  return {
    userId: user.id,
    tenantId: user.tenantId,
    roles: [...(user.roles ?? [])],
    ...(user.tenantClaim !== undefined ? { tenantClaim: user.tenantClaim } : {}),
  };
}

/** `loadProjectForRead` for the caller (404 for every unreadable shape). */
async function assertReadable(who: Who, projectId: string): Promise<void> {
  const [{ db }, { loadProjectForRead }] = await Promise.all([
    import('../db/client'),
    import('../lib/project-access'),
  ]);
  await loadProjectForRead(db, { id: who.userId, tenantId: who.tenantId, roles: who.roles }, projectId);
}

function isPending(v: unknown): v is PendingAction {
  return !!v && typeof v === 'object' && (v as { status?: unknown }).status === 'pending';
}

export async function handleCapabilityInvoke(req: Request, id: string): Promise<Response> {
  try {
    const who = await callerPrincipal(req);
    const action = invokableAction(id);
    if (!action) {
      throw new AppError(404, `${id} is not invokable through this route`).withCode('not_invokable');
    }
    let body: unknown;
    try {
      const text = await req.text();
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      throw new AppError(400, 'Request body is not valid JSON').withCode('invalid_json');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'Request body must be a JSON object').withCode('invalid_input');
    }
    const input = body as Record<string, unknown>;
    // The project the write targets: the action's project key (agui/agent-surface.ts
    // PROJECT_BINDING). Every project-agent native write is project-scoped.
    const param = action.projectParam;
    const projectId = param ? input[param] : undefined;
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new AppError(422, `${id} needs ${param ?? 'a project'}`).withCode('project_required');
    }
    await assertReadable(who, projectId);

    const ctx: ActionContext = markConfirmedCard({
      userId: who.userId,
      projectId,
      correlationId: req.headers.get('x-correlation-id') ?? randomUUID(),
      initiator: 'human',
      channel: 'web',
      tenantRoles: who.roles,
      tenantId: who.tenantId,
      ...(who.tenantClaim !== undefined ? { tenantClaim: who.tenantClaim } : {}),
      realmRoles: who.roles,
    });
    const result = await invokeAction(id, input, ctx);
    const invalidate = invalidationsFor(id, projectId);
    return Response.json({ data: result, invalidate }, { status: isPending(result) ? 202 : 200 });
  } catch (err) {
    return handleError(err);
  }
}
