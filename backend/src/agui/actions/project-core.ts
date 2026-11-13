/**
 * fr-agui SPEC §8.1 "P1, project core" — the project agent's reads of ITS
 * project: cockpit, phase, brief (+ versions), plan, board, a card, the
 * project's approvals / sign-offs, one approval and its document, the
 * project's own agent threads.
 *
 * ⭐ HOW A READ RUNS — THE UI's OWN ROUTE, AS THE HUMAN (SPEC §10.3 parity by
 * construction). Each read calls the EXISTING route handler the project shell
 * page calls (`GET /api/projects/:id/cockpit`, …), with the human's own
 * VERIFIED Keycloak token as its bearer: the one `/api/agent/chat` already
 * verifies every turn and keeps only in the request frame
 * (`RequestContext.endUserToken`: same user as the agent session, a human
 * token, proving the session tenant — middleware/request-context.ts). So the
 * agent gets EXACTLY the UI's answer — same identity, same tenant/project
 * gates, same 404-for-everything, same RM-owned fields — and there is no second
 * authorisation path to drift. A super-admin SWITCHED into the workspace
 * (George 2026-10-27, #1647) has no such token (theirs names the HOME tenant):
 * the frame's `superAdminSwitchToken` is used instead, sent with
 * `X-Active-Tenant`, and the route runs in the frame `buildRequestContext`
 * builds for that request — the browser's own switch gate, re-applied
 * (`runSwitched`). No token in the frame ⇒ refused (401
 * `end_user_token_required`), never a weaker read. The token is never stored,
 * logged or returned (it rides only the in-process Request object).
 *
 * BOUND PROJECT ONLY. Every read here is project-scoped:
 *   - a `/api/projects/:id/…` read takes `id` from the thread (`projectParam`);
 *   - `cards.get` requires the card to sit on the bound project's board;
 *   - `approvals.get` / `approvals.get_document` require the approval's
 *     `project_id` to be the bound project.
 * Another project of the same tenant ⇒ 403 `project_mismatch` (binding
 * correctness; under P1-TEAM the member may open it in its own thread).
 * Outside a bound thread these actions are not in any agent catalog.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';
import {
  getEndUserToken,
  getSuperAdminSwitchToken,
  tryGetRequestContext,
  withRequestContext,
  type RequestContext,
} from '../../integrations/_lib/context';
import { ProjectMismatchError } from '../../agent/project-binding';
import { assertCardOnBoundProject } from './kanban-comment';

export type RouteHandler = (req: Request, ...params: string[]) => Promise<Response>;

export class EndUserTokenRequiredError extends AppError {
  constructor(action: string) {
    super(
      401,
      `${action} reads with your own signed-in session, and this request did not carry it. Reload the page and ask again.`,
    );
    this.name = 'EndUserTokenRequiredError';
    this.code = 'end_user_token_required';
  }
}

/** The browser's own frame builder, for the switched in-process request (lazy: request-context pulls in config). */
async function buildFrame(req: Request): Promise<RequestContext> {
  const { buildRequestContext } = await import('../../middleware/request-context');
  return buildRequestContext(req);
}

/** The UI route handler `exportName` of the module `load` imports (lazy: routes pull in the db). */
async function routeHandler(load: () => Promise<Record<string, unknown>>, exportName: string): Promise<RouteHandler> {
  const fn = (await load())[exportName];
  if (typeof fn !== 'function') throw new Error(`${exportName} is not exported`);
  return fn as RouteHandler;
}

async function threads(userId: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const [{ db }, { agentRuntimeSessions }, { and, desc, eq }] = await Promise.all([
    import('../../db/client'),
    import('../../db/schema'),
    import('drizzle-orm'),
  ]);
  const rows = await db
    .select({
      id: agentRuntimeSessions.id,
      thread_id: agentRuntimeSessions.thread_id,
      channel: agentRuntimeSessions.channel,
      updated_at: agentRuntimeSessions.updated_at,
      created_at: agentRuntimeSessions.created_at,
    })
    .from(agentRuntimeSessions)
    .where(and(eq(agentRuntimeSessions.user_id, userId), eq(agentRuntimeSessions.project_id, projectId)))
    .orderBy(desc(agentRuntimeSessions.updated_at))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    thread_id: r.thread_id,
    channel: r.channel,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    url: `/projects/${projectId}/threads/${r.id}`,
  }));
}

/** Origin of the synthetic in-process request (never dialled: the handler is called directly). */
const INPROCESS_ORIGIN = 'http://fr-backend.inprocess';

function pathOf(template: string, params: Record<string, string>): { path: string; ordered: string[] } {
  const ordered: string[] = [];
  const path = template.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === '') throw new AppError(422, `missing ${name}`).withCode('invalid_input');
    ordered.push(v);
    return encodeURIComponent(v);
  });
  return { path, ordered };
}

/**
 * Run the UI route `handler` for `template` as the human whose verified token
 * is in the request frame. Exported for the parity test.
 */
export async function readViaRoute(
  action: string,
  template: string,
  handler: RouteHandler,
  params: Record<string, string>,
  query: Record<string, string | undefined>,
  ctx: Pick<ActionContext, 'correlationId'>,
): Promise<unknown> {
  return callRouteAsHuman(action, { method: 'GET', template, handler, params, query }, ctx);
}

export interface RouteCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  template: string;
  handler: RouteHandler;
  params: Record<string, string>;
  query?: Record<string, string | undefined>;
  /** A JSON body (non-GET). */
  body?: unknown;
  /** Extra request headers the route reads (e.g. `Idempotency-Key`, `X-Visibility`); never an Authorization. */
  headers?: Record<string, string>;
}

/**
 * fr-agui P2 — the write counterpart of `readViaRoute`: run ONE UI route (any
 * method) as the human, so a project-agent write confirmed on its card does
 * EXACTLY what the project shell's button does (same identity, gates, refusals
 * and side effects; SPEC §10.3 parity by construction). Used by the confirmed
 * (`capability-invoke`) project-asset writes, where the human's own Keycloak
 * bearer is the request's and so the frame's `endUserToken`
 * (middleware/request-context.ts). No token ⇒ 401 `end_user_token_required`.
 * A non-2xx answer becomes an AppError carrying the route's status and code.
 */
export async function callRouteAsHuman(
  action: string,
  call: RouteCall,
  ctx: Pick<ActionContext, 'correlationId'>,
): Promise<unknown> {
  // The home/member lane: a token proving the frame tenant. Otherwise, a
  // SWITCHED super-admin (George 2026-10-27, #1647): their token names the HOME
  // tenant, so the route must also be told the workspace — exactly as the
  // browser tells it, with `X-Active-Tenant` — and runs in the frame the
  // browser's own builder makes for that request (below).
  const homeToken = getEndUserToken();
  const switched = homeToken ? undefined : getSuperAdminSwitchToken();
  const token = homeToken ?? switched?.token;
  if (!token) throw new EndUserTokenRequiredError(action);
  const { path, ordered } = pathOf(call.template, call.params);
  const url = new URL(path, INPROCESS_ORIGIN);
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(call.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'authorization')),
    Authorization: `Bearer ${token}`,
    'X-Correlation-Id': ctx.correlationId,
    Accept: 'application/json',
  };
  if (switched) headers['X-Active-Tenant'] = switched.tenantId;
  const withBody = call.method !== 'GET' && call.body !== undefined;
  if (withBody) headers['Content-Type'] = 'application/json';
  const req = new Request(url.toString(), {
    method: call.method,
    headers,
    ...(withBody ? { body: JSON.stringify(call.body) } : {}),
  });
  // A thrown AppError (NotFoundError, ForbiddenError, …) is the route's own
  // answer and propagates verbatim (SPEC §5.6).
  const res = switched
    ? await runSwitched(action, req, switched.tenantId, () => call.handler(req, ...ordered))
    : await call.handler(req, ...ordered);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = { text };
  }
  if (!res.ok) {
    let b = (body ?? {}) as { error?: unknown; code?: unknown; message?: unknown };
    // The integration-error envelope (`{ error: { code, message } }`, routes/assets/*)
    // carries its code and message one level down: read them there, verbatim.
    if (b.error !== null && typeof b.error === 'object' && !Array.isArray(b.error)) {
      b = b.error as { code?: unknown; message?: unknown };
    }
    const message =
      typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : `the route answered ${res.status}`;
    const err = new AppError(res.status, message);
    const code = typeof b.code === 'string' ? b.code : typeof b.error === 'string' && /^[a-z_]+$/.test(b.error) ? b.error : undefined;
    if (code !== undefined) err.code = code;
    throw err;
  }
  return body;
}

/**
 * Run `fn` in the frame a BROWSER request with this bearer + `X-Active-Tenant`
 * gets: `buildRequestContext` re-applies the switch gate from the token's
 * SIGNED claims (a refused target throws its 403) and yields the switched fields the route's gates read
 * (`activeTenantSource`/`activeTenantVia`, `jwtTenantId`, `callerIsSuperAdmin`).
 * Only those fields replace the outer frame's; correlation, initiator, channel
 * and project stay the agent's, and no credential is added (`endUserToken`
 * stays what the browser frame would hold: nothing). The result must be an
 * accepted switch into exactly `tenantId` by the frame's own user — otherwise
 * refused `end_user_token_required` (fail closed, never a home-tenant read).
 */
async function runSwitched(
  action: string,
  req: Request,
  tenantId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const outer = tryGetRequestContext();
  const built = await buildFrame(req);
  if (
    !outer ||
    built.activeTenantVia !== 'active-tenant-header' ||
    built.tenantId !== tenantId ||
    built.callerIsSuperAdmin !== true ||
    !built.userId ||
    built.userId !== outer.userId
  ) {
    throw new EndUserTokenRequiredError(action);
  }
  const frame: RequestContext = {
    ...outer,
    tenantId: built.tenantId,
    activeTenantSource: built.activeTenantSource,
    activeTenantVia: built.activeTenantVia,
    jwtTenantId: built.jwtTenantId,
    callerIsSuperAdmin: built.callerIsSuperAdmin,
    endUserToken: undefined,
  };
  return withRequestContext(frame, fn);
}

/** The bound project, or 409 `project_required` (exported for the P2 project-asset actions). */
export function bound(ctx: ActionContext, name: string): string {
  if (!ctx.projectId) throw new AppError(409, `${name} works inside a project`).withCode('project_required');
  return ctx.projectId;
}

/** The `project_id` an approval payload names (top level or under `data`). */
function approvalProjectId(body: unknown): string | null {
  const o = (body ?? {}) as Record<string, unknown>;
  const inner = (o.data ?? o.approval ?? o) as Record<string, unknown>;
  const v = inner.project_id ?? inner.projectId ?? o.project_id;
  return typeof v === 'string' ? v : null;
}

const anyOut = z.unknown();
const READ = {
  kind: 'read' as const,
  approval: { type: 'auto' as const },
  cronSafe: false,
  output: anyOut,
  rbac: { type: 'project-member' as const },
};

/** A UI route handler, loaded lazily by `routeHandler` (exported for the P2 project-asset actions). */
export const lazyRoute = (load: () => Promise<Record<string, unknown>>, exportName: string): RouteHandler => async (req, ...p) =>
  (await routeHandler(load, exportName))(req, ...p);
const lazy = lazyRoute;

const projectsRoutes = () => import('../../routes/projects');
const approvalsRoutes = () => import('../../routes/approvals');

interface ProjectRead {
  name: string;
  description: string;
  template: string;
  handler: RouteHandler;
  extra?: z.ZodRawShape;
  /** Path params beyond `:id` taken from the input, in order. */
  extraParams?: string[];
  /** Query params taken from the input. */
  query?: string[];
}

function projectRead(r: ProjectRead): AgentCallableAction<Record<string, unknown>, unknown> {
  return {
    ...READ,
    name: r.name,
    description: r.description,
    input: z.object({ id: z.string().uuid(), ...(r.extra ?? {}) }),
    // §5.7 rule 3: `id` is the project parameter — stripped from the model's
    // schema and injected from the thread (agent/project-binding.ts).
    projectParam: 'id',
    idempotencyKey: (i) => `${r.name}:${JSON.stringify(i)}`,
    handler: async (input, ctx) => {
      const id = bound(ctx, r.name);
      const params: Record<string, string> = { id };
      for (const p of r.extraParams ?? []) params[p] = String(input[p] ?? '');
      const query = Object.fromEntries((r.query ?? []).map((q) => [q, input[q] === undefined ? undefined : String(input[q])]));
      return readViaRoute(r.name, r.template, r.handler, params, query, ctx);
    },
  };
}

export const PROJECT_CORE_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  projectRead({
    name: 'projects.get_cockpit',
    description: "This project's cockpit: status, phase, board flow, what needs attention (the project shell's overview page).",
    template: '/api/projects/:id/cockpit',
    handler: lazy(() => import('../../routes/project-cockpit'), 'handleGetProjectCockpit'),
  }),
  projectRead({
    name: 'projects.get_phase',
    description: "This project's current phase (owned by the conveyor / requirements_management; read-only).",
    template: '/api/projects/:id/phase',
    handler: lazy(projectsRoutes, 'handleGetProjectPhase'),
  }),
  projectRead({
    name: 'projects.get_brief',
    description: "This project's brief (latest version). v1 is the user's; later versions belong to the conveyor — read-only.",
    template: '/api/projects/:id/brief',
    handler: lazy(projectsRoutes, 'handleGetProjectBrief'),
  }),
  projectRead({
    name: 'projects.list_brief_versions',
    description: "The versions of this project's brief.",
    template: '/api/projects/:id/brief/versions',
    handler: lazy(projectsRoutes, 'handleListProjectBriefVersions'),
  }),
  projectRead({
    name: 'projects.get_brief_version',
    description: "One version of this project's brief.",
    template: '/api/projects/:id/brief/versions/:version',
    handler: lazy(projectsRoutes, 'handleGetProjectBriefVersion'),
    extra: { version: z.number().int().min(1) },
    extraParams: ['version'],
  }),
  projectRead({
    name: 'projects.get_plan',
    description: "This project's plan (owned by the conveyor; read-only).",
    template: '/api/projects/:id/plan',
    handler: lazy(() => import('../../routes/project-plan'), 'handleGetProjectPlan'),
  }),
  projectRead({
    name: 'projects.get_board',
    description: "This project's kanban board: its lists and cards.",
    template: '/api/projects/:id/kanban',
    handler: lazy(() => import('../../routes/kanban'), 'handleGetProjectKanban'),
  }),
  projectRead({
    name: 'projects.list_approvals',
    description: "This project's approvals and sign-offs (what needs a decision, and what was decided).",
    template: '/api/projects/:id/approvals',
    handler: lazy(approvalsRoutes, 'handleListApprovals'),
  }),
  {
    ...READ,
    name: 'cards.get',
    description: "One card of this project's board, by its id.",
    input: z.object({ card_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }),
    idempotencyKey: (i: { card_id: string }) => `cards.get:${i.card_id}`,
    handler: async (input: { card_id: string }, ctx: ActionContext) => {
      bound(ctx, 'cards.get');
      await assertCardOnBoundProject(input.card_id, ctx, 'cards.get');
      return readViaRoute(
        'cards.get',
        '/api/kanban/cards/:cardId',
        lazy(() => import('../../routes/kanban'), 'handleGetCard'),
        { cardId: input.card_id },
        {},
        ctx,
      );
    },
  },
  {
    ...READ,
    name: 'approvals.get',
    description:
      'One approval / sign-off, with what it asks and its artifact reference. In a project it must be one of ' +
      "that project's; on a channel (no project) any approval the route lets the caller read in its tenant.",
    // Project-member inside a project, tenant member on a channel (rbac defaultRule): a channel
    // responder reads what it answers, like the web (owner ruling 2026-10-31).
    rbac: undefined,
    input: z.object({ approvalId: z.string().uuid() }),
    idempotencyKey: (i: { approvalId: string }) => `approvals.get:${i.approvalId}`,
    handler: async (input: { approvalId: string }, ctx: ActionContext) => {
      const id = ctx.projectId ?? null;
      const body = await readViaRoute(
        'approvals.get',
        '/api/approvals/:approvalId',
        lazy(approvalsRoutes, 'handleGetApproval'),
        { approvalId: input.approvalId },
        {},
        ctx,
      );
      if (id && approvalProjectId(body)?.toLowerCase() !== id.toLowerCase()) {
        throw new ProjectMismatchError('approvals.get', 'approvalId', id);
      }
      return body;
    },
  },
  {
    ...READ,
    name: 'approvals.get_document',
    description: "The document an approval of this project asks you to review.",
    input: z.object({ approvalId: z.string().uuid() }),
    idempotencyKey: (i: { approvalId: string }) => `approvals.get_document:${i.approvalId}`,
    handler: async (input: { approvalId: string }, ctx: ActionContext) => {
      const id = bound(ctx, 'approvals.get_document');
      // The approval's project is checked on the approval itself first, so a
      // document of another project's approval is never read.
      const approval = await readViaRoute(
        'approvals.get_document',
        '/api/approvals/:approvalId',
        lazy(approvalsRoutes, 'handleGetApproval'),
        { approvalId: input.approvalId },
        {},
        ctx,
      );
      if (approvalProjectId(approval)?.toLowerCase() !== id.toLowerCase()) {
        throw new ProjectMismatchError('approvals.get_document', 'approvalId', id);
      }
      return readViaRoute(
        'approvals.get_document',
        '/api/approvals/:approvalId/document',
        lazy(approvalsRoutes, 'handleGetApprovalDocument'),
        { approvalId: input.approvalId },
        {},
        ctx,
      );
    },
  },
  {
    ...READ,
    name: 'projects.list_agent_threads',
    description: "Your own agent conversations about this project (newest first).",
    input: z.object({}).strict(),
    idempotencyKey: () => 'projects.list_agent_threads',
    handler: async (_i: Record<string, never>, ctx: ActionContext) => ({
      threads: await threads(ctx.userId, bound(ctx, 'projects.list_agent_threads')),
    }),
  },
];

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerProjectCoreActions(): void {
  for (const a of PROJECT_CORE_ACTIONS) safeRegister(a);
}
