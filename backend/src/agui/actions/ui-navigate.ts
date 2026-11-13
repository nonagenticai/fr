/**
 * fr-agui SPEC §5.4 — navigation intents (`ui.*`). Client-only: the handler
 * runs NOTHING but a route check and returns `{kind:'navigate', route}`; the
 * agent loop turns a successful `ui.*` call into a `ui-intent` event and the
 * rail calls SvelteKit `goto()` (frontend, P1c-b). A navigation needs no
 * confirmation.
 *
 * WHERE THE AGENT MAY SEND THE USER (never trusted from the model):
 *   - the PROJECT agent (a bound thread): its own shell only —
 *     `/projects/<bound id>` + one of PROJECT_SHELL_ROUTES (§7.3). Another
 *     project's id is refused `project_mismatch`, an unknown area 422.
 *   - the DOORWAY agent (unbound): the doorway pages (§6.0) and, after a
 *     create, a project shell the caller can READ (`ui.open_project`, the same
 *     gate `GET /api/projects/:id` uses).
 * External URLs, `..`, query strings and fragments are refused.
 *
 * PROJECT_SHELL_ROUTES is pinned against the SvelteKit manifest
 * (frontend/src/routes/(project)/projects/[id]/**) by
 * tests/unit/agent/ui-navigate.test.ts.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';
import { ProjectMismatchError } from '../../agent/project-binding';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path segment that stands for an id (`:uuid` = a UUID, `:id` = a Planka/opaque id). */
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The project shell's pages, relative to `/projects/<id>` (SPEC §7.3). `''` = the cockpit. */
export const PROJECT_SHELL_ROUTES: ReadonlyArray<string> = [
  '',
  // No 'approvals' / 'threads' (R4): both 308 to 'needs-you', which lists every ask, sign-off,
  // review and the caller's project threads. The detail pages stay.
  'approve/:uuid',
  // The project's Architecture hub: conformance, its ArchiMate/UML models, the code-graph views.
  'architecture',
  'architecture/dependencies',
  'architecture/graph',
  'architecture/quality-gate',
  'artifacts',
  'board',
  'cards/:id',
  // R6: Cost — spend vs budget, by phase / capability / card (Plan & scope replaced 'brief';
  // /projects/[id]/brief now 308s to 'plan').
  'cost',
  // R3 / DOC-3: the document reader.
  'documents/:uuid',
  // R5 (cockpit C5): Flow runs — the Execution hub and Project executions merged (both 308 here).
  'flow-runs',
  'goal',
  'governance',
  'knowledge',
  'library/architecture/elements',
  'library/architecture/relationships',
  'library/architecture/standards',
  'library/architecture/views',
  'library/channels',
  'library/decisions',
  'library/kag-documents',
  'library/kag/ask',
  'library/kag/benchmarks',
  'library/kag/capabilities',
  'library/kag/discover',
  'library/kag/documents',
  'library/kag/entities',
  'library/kag/graph',
  'library/kag/health',
  'library/kag/media',
  'library/kag/scientific',
  'library/kag/text-analysis',
  'library/kag/web-sources',
  'library/pm',
  'library/principles',
  'library/requirements',
  'library/triggers',
  'library/workflows',
  'needs-you',
  'plan',
  'quality',
  'reasoning',
  'registers',
  'repositories',
  'settings',
  'threads/:uuid',
  'traceability',
];

/** `ui.open_area` targets: the static shell pages (no id segment). */
export const PROJECT_AREAS = PROJECT_SHELL_ROUTES.filter((r) => r !== '' && !r.includes(':')) as readonly string[];

/** The doorway pages (SPEC §6.0). */
export const DOORWAY_ROUTES: ReadonlyArray<string> = ['/projects/new', '/projects/intake', '/projects/requests', '/projects/requests/:uuid'];

export class NavigationRefusedError extends AppError {
  constructor(route: string, why: string) {
    super(422, `ui.navigate: ${route} — ${why}`);
    this.name = 'NavigationRefusedError';
    this.code = 'navigation_refused';
  }
}

function segmentMatches(pattern: string, seg: string): boolean {
  if (pattern === ':uuid') return UUID_RE.test(seg);
  if (pattern === ':id') return OPAQUE_ID_RE.test(seg);
  return pattern === seg;
}

function matchesPattern(pattern: string, rest: string[]): boolean {
  const parts = pattern === '' ? [] : pattern.split('/');
  return parts.length === rest.length && parts.every((p, i) => segmentMatches(p, rest[i]!));
}

/** Split a candidate route into segments, refusing anything that is not a plain internal path. */
function internalSegments(route: string): string[] {
  if (!route.startsWith('/') || route.startsWith('//')) throw new NavigationRefusedError(route, 'only internal fr routes');
  if (/[?#\\\s]/.test(route) || /(^|\/)\.\.?(\/|$)/.test(route)) {
    throw new NavigationRefusedError(route, 'a route is a plain path (no query, fragment or dot segment)');
  }
  return route.replace(/\/+$/, '').split('/').slice(1);
}

/**
 * The route the agent may open for `ctx`, or a refusal. Exported for the tests.
 * `readable` is the doorway's read gate for a project shell root.
 */
export async function checkNavigation(
  route: string,
  ctx: Pick<ActionContext, 'projectId'>,
  readable: (projectId: string) => Promise<boolean>,
): Promise<string> {
  const segs = internalSegments(route);
  const bound = ctx.projectId;
  if (segs[0] === 'projects' && segs[1] !== undefined && UUID_RE.test(segs[1])) {
    const target = segs[1];
    const rest = segs.slice(2);
    if (bound) {
      if (target.toLowerCase() !== bound.toLowerCase()) throw new ProjectMismatchError('ui.navigate', 'route', bound);
      if (!PROJECT_SHELL_ROUTES.some((p) => matchesPattern(p, rest))) {
        throw new NavigationRefusedError(route, 'not a page of the project shell');
      }
      return `/${segs.join('/')}`;
    }
    // Doorway: the shell ROOT of a project the caller can read — nothing deeper.
    if (rest.length > 0) throw new NavigationRefusedError(route, 'outside a project the agent opens only the project itself');
    if (!(await readable(target))) throw new NavigationRefusedError(route, 'no readable project with this id');
    return `/${segs.join('/')}`;
  }
  if (bound) throw new NavigationRefusedError(route, "the project agent navigates inside its own project's shell only");
  if (!DOORWAY_ROUTES.some((p) => matchesPattern(p.slice(1), segs))) {
    throw new NavigationRefusedError(route, 'outside a project the agent opens only the doorway pages');
  }
  return `/${segs.join('/')}`;
}

const navigateOutput = z.object({ kind: z.literal('navigate'), route: z.string() });
type NavigateOutput = z.infer<typeof navigateOutput>;

/** The doorway read gate: the same visibility `GET /api/projects/:id` applies (lazy: db + routes). */
async function readable(ctx: ActionContext, projectId: string): Promise<boolean> {
  const { projectsGetHandler } = await import('./projects-read');
  try {
    await projectsGetHandler({ id: projectId }, ctx);
    return true;
  } catch {
    return false;
  }
}

function navigate(route: string, ctx: ActionContext): Promise<NavigateOutput> {
  return checkNavigation(route, ctx, (id) => readable(ctx, id)).then((r) => ({ kind: 'navigate' as const, route: r }));
}

function bound(ctx: ActionContext, name: string): string {
  if (!ctx.projectId) throw new AppError(409, `${name} works inside a project`).withCode('project_required');
  return ctx.projectId;
}

const READ = { kind: 'read' as const, approval: { type: 'auto' as const }, cronSafe: true, output: navigateOutput };

const navigateAction: AgentCallableAction<{ route: string }, NavigateOutput> = {
  ...READ,
  name: 'ui.navigate',
  description:
    "Open an fr page for the user. Inside a project: a page of this project's shell (e.g. /projects/<id>/board). Outside: the project doorway pages.",
  input: z.object({ route: z.string().min(1).max(300) }),
  idempotencyKey: (i) => `ui.navigate:${i.route}`,
  // The route check IS the authorisation (and the page itself loads under the human session).
  rbac: { type: 'public' },
  handler: (input, ctx) => navigate(input.route, ctx),
};

const openProjectAction: AgentCallableAction<{ project_id: string }, NavigateOutput> = {
  ...READ,
  name: 'ui.open_project',
  description: 'Open a project the user can read (its project shell, where its own project agent takes over).',
  input: z.object({ project_id: z.string().uuid() }),
  idempotencyKey: (i) => `ui.open_project:${i.project_id}`,
  rbac: { type: 'public' },
  handler: (input, ctx) => navigate(`/projects/${input.project_id}`, ctx),
};

const openBoardAction: AgentCallableAction<Record<string, never>, NavigateOutput> = {
  ...READ,
  name: 'ui.open_board',
  description: "Open this project's board.",
  input: z.object({}).strict(),
  idempotencyKey: () => 'ui.open_board',
  rbac: { type: 'project-member' },
  handler: async (_i, ctx) => navigate(`/projects/${bound(ctx, 'ui.open_board')}/board`, ctx),
};

const openApprovalAction: AgentCallableAction<{ approvalId: string }, NavigateOutput> = {
  ...READ,
  name: 'ui.open_approval',
  description: "Open one of this project's sign-offs / approvals for the user to review.",
  input: z.object({ approvalId: z.string().uuid() }),
  idempotencyKey: (i) => `ui.open_approval:${i.approvalId}`,
  rbac: { type: 'project-member' },
  handler: async (input, ctx) => navigate(`/projects/${bound(ctx, 'ui.open_approval')}/approve/${input.approvalId}`, ctx),
};

const openAreaAction: AgentCallableAction<{ area: string }, NavigateOutput> = {
  ...READ,
  name: 'ui.open_area',
  description: `Open an area of this project's shell. area: one of ${PROJECT_AREAS.join(', ')}.`,
  input: z.object({ area: z.enum(PROJECT_AREAS as [string, ...string[]]) }),
  idempotencyKey: (i) => `ui.open_area:${i.area}`,
  rbac: { type: 'project-member' },
  handler: async (input, ctx) => navigate(`/projects/${bound(ctx, 'ui.open_area')}/${input.area}`, ctx),
};

export const UI_ACTIONS: ReadonlyArray<AgentCallableAction<any, NavigateOutput>> = [
  navigateAction,
  openProjectAction,
  openBoardAction,
  openApprovalAction,
  openAreaAction,
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
export function registerUiActions(): void {
  for (const a of UI_ACTIONS) safeRegister(a);
}
