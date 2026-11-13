// fr-agui SPEC §6.0 / §8.1 P1b — the project-request lifecycle (11 routes,
// `/api/project-requests*`), declared as capabilities. The doorway agent's
// request-intake tool set (agent/intake-catalog.ts).
//
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
//
// ROUTES UNCHANGED. Every route keeps its existing `Request` handler
// (`legacyHandler`): the route, its auth, its conveyor gate and its
// validation are exactly what the classic UI calls. These are NEW spec
// operations (the routes were spec-less, pinned in LEGACY_UNDECLARED), so
// their operationIds are new — camelCase(id), SPEC §3.3 — and no existing
// operationId moves.
//
// AGENT (SPEC §5.2 W). Writes are PROPOSED: the confirm card
// (`project-request`) calls the route under the human's own session. They have
// no server-side handler, so they are web-only: a channel invocation is refused
// before any approval is parked (derive-agent.ts `webOnly`). Reads run server-side
// through agui/actions/project-requests.ts, which shares each route's query.
//
// ⛔ `project_requests.create` is NOT agent-exposed: `POST /api/project-requests`
// is the Common Practice BRIDGE intake (middleware/bridge-auth.ts
// requireBridgeWriter — a service account holding `project-request-writer`
// plus an edge-injected X-Tenant-Id). A human's confirm card would always be
// refused 403 there, so offering it to the agent would be a write nobody can
// confirm. A person's request starts at `project_requests.draft_from_text`.
import { z } from 'zod';

import { defineCapability, LICENCE_ROUTE_DOOR_ERROR, type ErrorSpec } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedTenantUser } from '../rbac-rules';

const tenantUser = {
  principal: 'user' as const,
  rbac: {
    type: 'custom' as const,
    check: (ctx: Parameters<typeof isAuthenticatedTenantUser>[0]) => isAuthenticatedTenantUser(ctx),
  },
};

const requestId = z.string().uuid().describe('The project request id');

const CONVEYOR_OFF: ErrorSpec = { status: 503, code: 'conveyor_not_configured' };
const NOT_FOUND: ErrorSpec = { status: 404, code: 'not_found' };

function routeHandler(module: string, exportName: string, load: () => Promise<Record<string, unknown>>) {
  return lazyHandler(load, { module, exportName });
}

const REQUESTS = 'src/routes/project-requests.ts';
const LIFECYCLE = 'src/routes/project-request-lifecycle.ts';
const REPO_ACCESS = 'src/routes/project-request-repo-access.ts';
const AGENT = 'src/agui/actions/project-requests.ts';

const loadRequests = () => import('../../routes/project-requests');
const loadLifecycle = () => import('../../routes/project-request-lifecycle');
const loadRepoAccess = () => import('../../routes/project-request-repo-access');
const loadAgent = () => import('../../agui/actions/project-requests');

function agentRead(exportName: string) {
  return lazyActionHandler<any, any>(loadAgent, { module: AGENT, exportName });
}

function webWrite(key: (i: any) => string) {
  return {
    expose: true as const,
    tier: 'core' as const,
    card: 'project-request' as const,
    cronSafe: false,
    idempotencyKey: key,
  };
}

function read(key: (i: any) => string) {
  return { expose: true as const, tier: 'core' as const, cronSafe: true, idempotencyKey: key };
}

/** A request row (the routes return the full row; the agent output is not narrowed here). */
const requestRow = z.object({ id: z.string(), status: z.string() }).passthrough();

/** Every routed doorway operation's OpenAPI tag (declared in openapi.ts top-level tags[]). */
const REQUESTS_OPENAPI = { tags: ['Project Requests'] };

// ── reads ──────────────────────────────────────────────────────────────────

export const projectRequestsListCapability = defineCapability({
  id: 'project_requests.list',
  area: 'project_requests',
  summary: "List this workspace's project requests, newest first",
  openapi: REQUESTS_OPENAPI,
  http: { method: 'GET', path: '/api/project-requests', operationId: 'projectRequestsList' },
  input: z.object({}).strict(),
  output: z.object({ items: z.array(requestRow), total: z.number().int() }),
  errors: [LICENCE_ROUTE_DOOR_ERROR],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'read',
  confirm: 'none',
  agent: read(() => 'project_requests.list'),
  handler: agentRead('projectRequestsListHandler'),
  legacyHandler: routeHandler(REQUESTS, 'handleListProjectRequests', loadRequests),
});

export const projectRequestsGetCapability = defineCapability({
  id: 'project_requests.get',
  area: 'project_requests',
  summary: 'Get one project request with its repositories and their recorded access verdicts',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'GET', path: '/api/project-requests/:id', operationId: 'projectRequestsGet' },
  input: z.object({ id: requestId }),
  output: requestRow,
  errors: [LICENCE_ROUTE_DOOR_ERROR, NOT_FOUND],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'read',
  confirm: 'none',
  agent: read((i: { id: string }) => `project_requests.get:${i.id}`),
  handler: agentRead('projectRequestsGetHandler'),
  legacyHandler: routeHandler(REQUESTS, 'handleGetProjectRequest', loadRequests),
});

export const projectRequestsListOutlinesCapability = defineCapability({
  id: 'project_requests.list_outlines',
  area: 'project_requests',
  summary: "A project request's proposed outlines, newest version first",
  openapi: REQUESTS_OPENAPI,
  http: { method: 'GET', path: '/api/project-requests/:id/outlines', operationId: 'projectRequestsListOutlines' },
  input: z.object({ id: requestId }),
  output: z.object({ items: z.array(z.object({}).passthrough()) }),
  errors: [LICENCE_ROUTE_DOOR_ERROR, NOT_FOUND],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'read',
  confirm: 'none',
  agent: read((i: { id: string }) => `project_requests.list_outlines:${i.id}`),
  handler: agentRead('projectRequestsListOutlinesHandler'),
  legacyHandler: routeHandler(LIFECYCLE, 'handleListProjectRequestOutlines', loadLifecycle),
});

export const projectRequestsVerifyRepoAccessCapability = defineCapability({
  id: 'project_requests.verify_repo_access',
  area: 'project_requests',
  summary: 'Check whether fr can read the given repositories (public, private and granted, or not readable)',
  description: 'A read: it probes access and changes nothing. Up to 20 repository URLs.',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'POST', path: '/api/project-requests/verify-repo-access', operationId: 'projectRequestsVerifyRepoAccess' },
  input: z.object({ urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(20) }).strict(),
  output: z.object({
    items: z.array(z.object({ url: z.string(), access_state: z.string() }).passthrough()),
  }),
  errors: [LICENCE_ROUTE_DOOR_ERROR, { status: 401, code: 'unauthorized' }, { status: 422, code: 'invalid request body' }],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'read',
  confirm: 'none',
  agent: read((i: { urls: string[] }) => `project_requests.verify_repo_access:${[...i.urls].sort().join(',')}`),
  handler: agentRead('projectRequestsVerifyRepoAccessHandler'),
  legacyHandler: routeHandler(REPO_ACCESS, 'handleVerifyRepoAccess', loadRepoAccess),
});

// ── writes (web proposals: the human's card calls the route) ───────────────

export const projectRequestsDraftFromTextCapability = defineCapability({
  id: 'project_requests.draft_from_text',
  area: 'project_requests',
  summary:
    'Turn a plain-language description into a DRAFT project request the user then reviews, submits and ' +
    'approves. On the web this opens a card the user confirms; the agent never creates it.',
  openapi: REQUESTS_OPENAPI,
  http: {
    method: 'POST',
    path: '/api/project-requests/draft-from-text',
    operationId: 'projectRequestsDraftFromText',
    successStatus: 201,
  },
  input: z.object({
    text: z.string().min(1).max(20_000).describe('What the user wants the project to do, in their words'),
    name: z.string().min(1).max(255).optional().describe('An optional project name'),
  }),
  output: z.object({ project_request_id: z.string() }).passthrough(),
  errors: [LICENCE_ROUTE_DOOR_ERROR, CONVEYOR_OFF, { status: 409, code: 'catalogue_not_initialised' }, { status: 422, code: 'name_required' }, { status: 502, code: 'intake_extraction_failed' }],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  conveyorGated: true,
  agent: webWrite((i: { text: string; name?: string }) => `project_requests.draft_from_text:${i.name ?? ''}:${i.text}`),
  approval: { type: 'single-approver', approver: 'initiator' },
  legacyHandler: routeHandler(REQUESTS, 'handleCreateProjectRequestFromText', loadRequests),
});

export const projectRequestsPatchCapability = defineCapability({
  id: 'project_requests.patch',
  area: 'project_requests',
  summary: 'Edit a draft (or failed) project request. On the web this opens a card the user confirms.',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'PATCH', path: '/api/project-requests/:id', operationId: 'projectRequestsPatch' },
  input: z.object({
    id: requestId,
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    project_type: z.string().optional().describe('A project type NAME from conveyor.list_project_types'),
    problem_statement: z.string().optional(),
    desired_outcome: z.string().optional(),
    business_case: z.string().optional(),
    repository_url: z.string().url().optional().describe('The primary repository URL'),
  }),
  output: requestRow,
  errors: [LICENCE_ROUTE_DOOR_ERROR, NOT_FOUND, { status: 422, code: 'project_request_not_editable' }],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  agent: webWrite((i: { id: string }) => `project_requests.patch:${i.id}`),
  approval: { type: 'single-approver', approver: 'initiator' },
  legacyHandler: routeHandler(REQUESTS, 'handlePatchProjectRequest', loadRequests),
});

export const projectRequestsSubmitCapability = defineCapability({
  id: 'project_requests.submit',
  area: 'project_requests',
  summary:
    'Submit a draft project request for analysis (checks the repositories can be read first). ' +
    'On the web this opens a card the user confirms.',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'POST', path: '/api/project-requests/:id/submit', operationId: 'projectRequestsSubmit' },
  input: z.object({ id: requestId }),
  output: z.object({ data: requestRow }),
  errors: [LICENCE_ROUTE_DOOR_ERROR, 
    CONVEYOR_OFF,
    NOT_FOUND,
    { status: 409, code: 'invalid_transition' },
    { status: 422, code: 'repository_url_required' },
    { status: 422, code: 'repo_access_denied' },
  ],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  conveyorGated: true,
  agent: webWrite((i: { id: string }) => `project_requests.submit:${i.id}`),
  approval: { type: 'single-approver', approver: 'initiator' },
  legacyHandler: routeHandler(LIFECYCLE, 'handleSubmitProjectRequest', loadLifecycle),
});

export const projectRequestsApproveCapability = defineCapability({
  id: 'project_requests.approve',
  area: 'project_requests',
  summary:
    'Approve a project request: promotes it to a real project through the one create door. ' +
    'On the web this opens a card the user confirms; the card then offers "Open project".',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'POST', path: '/api/project-requests/:id/approve', operationId: 'projectRequestsApprove' },
  input: z.object({ id: requestId }),
  output: z.object({ project: z.object({ id: z.string() }).passthrough() }).passthrough(),
  errors: [LICENCE_ROUTE_DOOR_ERROR, 
    CONVEYOR_OFF,
    NOT_FOUND,
    { status: 409, code: 'project_request_already_promoted' },
    { status: 409, code: 'project_request_withdrawn' },
    { status: 409, code: 'project_request_approve_conflict' },
    { status: 422, code: 'project_request_rejected' },
    { status: 422, code: 'repository_url_required' },
    { status: 422, code: 'repo_access_denied' },
  ],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  conveyorGated: true,
  agent: webWrite((i: { id: string }) => `project_requests.approve:${i.id}`),
  approval: { type: 'single-approver', approver: 'initiator' },
  legacyHandler: routeHandler(REQUESTS, 'handleApproveProjectRequest', loadRequests),
});

export const projectRequestsRejectCapability = defineCapability({
  id: 'project_requests.reject',
  area: 'project_requests',
  summary: 'Reject a project request with a reason. On the web this opens a card the user confirms.',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'POST', path: '/api/project-requests/:id/reject', operationId: 'projectRequestsReject' },
  input: z.object({ id: requestId, reason: z.string().min(1).max(2000) }),
  output: requestRow,
  errors: [LICENCE_ROUTE_DOOR_ERROR, 
    NOT_FOUND,
    { status: 409, code: 'project_request_reject_conflict' },
    { status: 422, code: 'project_request_already_promoted' },
  ],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  agent: webWrite((i: { id: string }) => `project_requests.reject:${i.id}`),
  approval: { type: 'single-approver', approver: 'initiator' },
  legacyHandler: routeHandler(REQUESTS, 'handleRejectProjectRequest', loadRequests),
});

export const projectRequestsWithdrawCapability = defineCapability({
  id: 'project_requests.withdraw',
  area: 'project_requests',
  summary: 'Withdraw your own project request (terminal). On the web this opens a card the user confirms.',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'POST', path: '/api/project-requests/:id/withdraw', operationId: 'projectRequestsWithdraw' },
  input: z.object({ id: requestId }),
  output: z.object({ data: requestRow }),
  errors: [NOT_FOUND, { status: 403, code: 'not_the_requester' }, { status: 409, code: 'invalid_transition' }],
  auth: tenantUser,
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  agent: webWrite((i: { id: string }) => `project_requests.withdraw:${i.id}`),
  approval: { type: 'single-approver', approver: 'initiator' },
  legacyHandler: routeHandler(LIFECYCLE, 'handleWithdrawProjectRequest', loadLifecycle),
});

// ── the bridge intake (service-to-service; never agent-exposed) ────────────

export const projectRequestsCreateCapability = defineCapability({
  id: 'project_requests.create',
  area: 'project_requests',
  summary: 'Bridge intake: Common Practice posts a draft project request (service account only)',
  description:
    'Service-account only: a Keycloak SA token holding `project-request-writer` plus the edge-resolved ' +
    'X-Tenant-Id. Idempotent on (tenant, external_ref). Creates a DRAFT only: no board, no n8n.',
  openapi: REQUESTS_OPENAPI,
  http: { method: 'POST', path: '/api/project-requests', operationId: 'projectRequestsCreate' },
  input: z.object({
    external_ref: z.union([z.string().min(1), z.number()]).describe('The caller-side id (idempotency key)'),
    external_origin: z.record(z.string(), z.unknown()).optional(),
    payload: z.record(z.string(), z.unknown()).describe('A ProjectCreate body (repository_url may be the CP sentinel)'),
  }),
  output: requestRow,
  errors: [
    CONVEYOR_OFF,
    { status: 400, code: 'missing or invalid X-Tenant-Id' },
    { status: 403, code: 'project-request-writer role required' },
    { status: 409, code: 'project_request_already_promoted' },
  ],
  auth: { principal: 'service', rbac: { type: 'custom', check: async () => false } },
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  conveyorGated: true,
  agent: { expose: false, reason: 'service-to-service' },
  legacyHandler: routeHandler(REQUESTS, 'handleCreateProjectRequest', loadRequests),
});

/** All 11, in route-table order (server.ts). */
export const PROJECT_REQUEST_CAPABILITIES = [
  projectRequestsCreateCapability,
  projectRequestsDraftFromTextCapability,
  projectRequestsVerifyRepoAccessCapability,
  projectRequestsListCapability,
  projectRequestsGetCapability,
  projectRequestsPatchCapability,
  projectRequestsApproveCapability,
  projectRequestsRejectCapability,
  projectRequestsSubmitCapability,
  projectRequestsWithdrawCapability,
  projectRequestsListOutlinesCapability,
] as const;
