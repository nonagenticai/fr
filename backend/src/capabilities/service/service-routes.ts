// fr-agui SPEC §3.5 / §13 P1b — the service-to-service and inbound-webhook routes
// (`/api/internal/*` 10, `/api/webhooks/*` 8) that had NO spec operation (they
// were pinned in LEGACY_UNDECLARED), declared as capabilities.
//
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
//
// ROUTES UNCHANGED. Each keeps its own `Request` handler (`legacyHandler`) and
// therefore its own authentication — a shared secret, an HMAC signature, an
// X-Internal-Token or a Keycloak role check inside the handler. The declaration
// only puts the operation in the spec (`x-internal`, not a typed-client op) and
// accounts for it in the capability guard. None is agent-exposed
// (`service-to-service`), and none is on the licence route allowlist.
//
// The `description` of each operation names the auth exactly as the handler
// enforces it; the request body is documented in prose (each handler parses
// its own schema), so no body schema here can drift from the handler's.
import { z } from 'zod';

import { defineCapability, LICENCE_ROUTE_DOOR_ERROR, type Capability, type ErrorSpec, type HttpMethod } from '../define';
import { lazyHandler } from '../lazy';

/** These routes never run through the registry or the agent: deny-all at that layer. */
const NEVER_THROUGH_REGISTRY = { type: 'custom' as const, check: async () => false };

interface ServiceRouteSpec {
  id: `${string}.${string}`;
  area: 'internal' | 'webhooks';
  principal: 'service' | 'webhook';
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  /** OpenAPI security; `[]` = no scheme models the header (it is named in the description). */
  security: Array<Record<string, string[]>>;
  errors: ErrorSpec[];
  successStatus?: 200 | 201;
  handler: { module: string; exportName: string; load: () => Promise<Record<string, unknown>> };
}

function pathInput(path: string): z.ZodTypeAny {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  return z.object(Object.fromEntries(names.map((n) => [n, z.string()]))).passthrough();
}

function serviceRoute(s: ServiceRouteSpec): Capability<any, any> {
  return defineCapability({
    id: s.id,
    area: s.area,
    summary: s.summary,
    description: s.description,
    http: {
      method: s.method,
      path: s.path,
      operationId: s.operationId,
      ...(s.successStatus ? { successStatus: s.successStatus } : {}),
    },
    input: pathInput(s.path),
    output: z.object({}).passthrough(),
    // P4d-1: the server's licence route door can answer every one of these (none is allowlisted).
    errors: s.errors.some((e) => e.status === 403) ? s.errors : [...s.errors, LICENCE_ROUTE_DOOR_ERROR],
    auth: { principal: s.principal, rbac: NEVER_THROUGH_REGISTRY },
    tenancy: 'tenant',
    effect: s.method === 'GET' ? 'read' : 'write',
    confirm: s.method === 'GET' ? 'none' : 'card',
    agent: { expose: false, reason: 'service-to-service' },
    openapi: { tags: [s.area === 'internal' ? 'Internal' : 'Webhooks'], security: s.security, internal: true },
    legacyHandler: lazyHandler(s.handler.load, { module: s.handler.module, exportName: s.handler.exportName }),
  });
}

const BEARER = [{ bearerAuth: [] }];
const INTERNAL_TOKEN = [{ internalToken: [] }];
const WEBHOOK_SECRET = [{ webhookSecret: [] }];
const NONE: Array<Record<string, string[]>> = [];

const UNAUTHORIZED: ErrorSpec = { status: 401, code: 'unauthorized' };

const internalCreate = ({
  id,
  operationId,
  kind,
  exportName,
}: {
  id: `internal.create_${string}`;
  operationId: string;
  kind: string;
  exportName: string;
}): Capability<any, any> =>
  serviceRoute({
    id,
    area: 'internal',
    principal: 'service',
    method: 'POST',
    path: `/api/internal/assets/${kind}`,
    operationId,
    summary: `Workflow-run create of a project-bound ${kind} asset`,
    description:
      'Keycloak bearer holding the `workflow-runner` role (403 otherwise). Body ' +
      '`{project_id: uuid, workflow_run_id, payload}`; the project must exist in the caller tenant ' +
      '(404 otherwise). 201 `{data:{asset, binding}}`.',
    security: BEARER,
    errors: [
      { status: 400, code: 'bad_request' },
      { status: 403, code: 'forbidden' },
      { status: 404, code: 'not_found' },
      { status: 422, code: 'validation_failed' },
      ...(kind === 'channel' ? [{ status: 409, code: 'channels_workspace_name_unique' }] : []),
    ],
    successStatus: 201,
    handler: {
      module: 'src/routes/assets/internal-create.ts',
      exportName,
      load: () => import('../../routes/assets/internal-create'),
    },
  });

export const SERVICE_ROUTE_CAPABILITIES: ReadonlyArray<Capability<any, any>> = [
  internalCreate({ id: 'internal.create_requirement', operationId: 'internalCreateRequirement', kind: 'requirement', exportName: 'handleInternalCreateRequirement' }),
  internalCreate({ id: 'internal.create_principle', operationId: 'internalCreatePrinciple', kind: 'principle', exportName: 'handleInternalCreatePrinciple' }),
  internalCreate({ id: 'internal.create_decision', operationId: 'internalCreateDecision', kind: 'decision', exportName: 'handleInternalCreateDecision' }),
  internalCreate({ id: 'internal.create_trigger', operationId: 'internalCreateTrigger', kind: 'trigger', exportName: 'handleInternalCreateTrigger' }),
  internalCreate({ id: 'internal.create_channel', operationId: 'internalCreateChannel', kind: 'channel', exportName: 'handleInternalCreateChannel' }),
  serviceRoute({
    id: 'internal.create_suggested_schedule',
    area: 'internal',
    principal: 'service',
    method: 'POST',
    path: '/api/internal/suggested-schedules',
    operationId: 'internalCreateSuggestedSchedule',
    summary: 'Create a suggested schedule for a project (admin-only stub)',
    description:
      'Keycloak bearer of a workspace-admin (401 otherwise). Body ' +
      '`{project_id: uuid, ad_hoc_summary, payload?, user_id?}` (strict). 201 with the row.',
    security: BEARER,
    errors: [{ status: 400, code: 'bad_request' }, UNAUTHORIZED, { status: 404, code: 'not_found' }, { status: 422, code: 'validation_failed' }],
    successStatus: 201,
    handler: {
      module: 'src/routes/suggested-schedules.ts',
      exportName: 'handleInternalCreateSuggestedSchedule',
      load: () => import('../../routes/suggested-schedules'),
    },
  }),
  serviceRoute({
    id: 'internal.get_andon',
    area: 'internal',
    principal: 'service',
    method: 'GET',
    path: '/api/internal/andon',
    operationId: 'internalGetAndon',
    summary: 'The platform andon state',
    description:
      'Unauthenticated by design (no secret; the same posture as the stream-status read). ' +
      '200 `{engaged, reason}`; a failed read answers `reason: unreadable`, never a 500.',
    security: NONE,
    errors: [],
    handler: { module: 'src/routes/andon.ts', exportName: 'handleGetAndonInternal', load: () => import('../../routes/andon') },
  }),
  serviceRoute({
    id: 'internal.get_github_app_binding',
    area: 'internal',
    principal: 'service',
    method: 'GET',
    path: '/api/internal/github-app/binding',
    operationId: 'internalGetGithubAppBinding',
    summary: "A tenant's GitHub App installation for an account owner",
    description:
      'X-Internal-Token compared constant-time to FR_GITHUB_BINDING_TOKEN (unset ⇒ 401 for everyone). ' +
      'Query `tenant_id` (uuid) and `owner` (GitHub login). 200 `{installation_id, account_login}` (null when unbound).',
    security: INTERNAL_TOKEN,
    errors: [UNAUTHORIZED, { status: 400, code: 'bad_request' }],
    handler: { module: 'src/routes/github-app.ts', exportName: 'handleGetGithubAppBinding', load: () => import('../../routes/github-app') },
  }),
  serviceRoute({
    id: 'webhooks.budget_threshold',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/billing/budget-threshold',
    operationId: 'webhookBudgetThreshold',
    summary: 'Billing: a tenant budget crossed a threshold',
    description:
      'HMAC-SHA256 of the raw body in X-Metering-Signature, keyed by PLATFORM_BUDGET_WEBHOOK_SECRET. ' +
      'Body `{event: budget.threshold_crossed, tenant_id, budget_id, threshold_pct, period_start, …}`. ' +
      'Always 200 on a valid call (skipped, no recipients, deduped or notified).',
    security: NONE,
    errors: [UNAUTHORIZED, { status: 400, code: 'bad_request' }, { status: 422, code: 'validation_failed' }],
    handler: {
      module: 'src/routes/webhooks/budget-threshold.ts',
      exportName: 'handleBudgetThresholdAlert',
      load: () => import('../../routes/webhooks/budget-threshold'),
    },
  }),
  serviceRoute({
    id: 'webhooks.email_incoming',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/email/incoming',
    operationId: 'webhookEmailIncoming',
    summary: 'Inbound email (channel dispatcher)',
    description:
      'X-Email-Webhook-Secret against EMAIL_WEBHOOK_SECRET (fails closed in production; a refused caller ' +
      'still gets 200). Body: the provider form, handed to the channel dispatcher. 200 `{received: true}`.',
    security: NONE,
    errors: [],
    handler: { module: 'src/routes/email-webhook.ts', exportName: 'handleEmailIncoming', load: () => import('../../routes/email-webhook') },
  }),
  serviceRoute({
    id: 'webhooks.mcp_incoming',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/mcp/incoming',
    operationId: 'webhookMcpIncoming',
    summary: 'Inbound MCP-server message (channel dispatcher)',
    description:
      'X-Channel-Timestamp + X-Channel-Signature (sha256 HMAC of "<timestamp>.<raw body>" under ' +
      'FR_MCP_CHANNEL_SECRET, ±300 s). Body `{address, text, correlation_id?}`: `text` is the channel command ' +
      'grammar or a `<action> {json}` invocation of any channel action, run as the linked fr user.',
    security: NONE,
    errors: [UNAUTHORIZED, { status: 400, code: 'bad_request' }, { status: 503, code: 'channel_dispatch_disabled' }],
    handler: { module: 'src/routes/mcp-webhook.ts', exportName: 'handleMcpIncoming', load: () => import('../../routes/mcp-webhook') },
  }),
  serviceRoute({
    id: 'webhooks.n8n_execution_event',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/n8n/execution-event',
    operationId: 'webhookN8nExecutionEvent',
    summary: 'n8n: an execution event to notify a project about',
    description:
      'X-Webhook-Secret (N8N_WEBHOOK_SECRET). Body `{event_type, project_id, title, tenant_id?, card_id?, ' +
      'execution_id?, message?, severity?, link?, correlation_id?, recipient_user_ids?, metadata?}`. 201 `{notified}`.',
    security: WEBHOOK_SECRET,
    errors: [UNAUTHORIZED, { status: 404, code: 'not_found' }, { status: 422, code: 'validation_failed' }],
    successStatus: 201,
    handler: { module: 'src/routes/webhooks.ts', exportName: 'handleN8nExecutionEvent', load: () => import('../../routes/webhooks') },
  }),
  serviceRoute({
    id: 'webhooks.n8n_router_dedupe',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/n8n/router-dedupe',
    operationId: 'webhookN8nRouterDedupe',
    summary: 'n8n: is this card move a duplicate delivery?',
    description:
      'X-Webhook-Secret (N8N_WEBHOOK_SECRET). Body `{card_id, list_id, updated_at_sec, planka_scope_id?, ' +
      'tenant_id?, dedupe_eligible?, board_id?}`. Always 200 `{duplicate}` (or the andon halt shape).',
    security: WEBHOOK_SECRET,
    errors: [UNAUTHORIZED, { status: 422, code: 'validation_failed' }],
    handler: { module: 'src/routes/webhooks.ts', exportName: 'handleN8nRouterDedupe', load: () => import('../../routes/webhooks') },
  }),
  serviceRoute({
    id: 'webhooks.n8n_project_request_outline',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/n8n/project-request-outline/:id',
    operationId: 'webhookN8nProjectRequestOutline',
    summary: 'n8n: the proposed outline for a submitted project request',
    description:
      'X-Webhook-Secret (N8N_WEBHOOK_SECRET). Body: a ProjectOutline plus `proposed_by?` and `phase_plan?`. ' +
      '201 `{data: {outline, approval_id}}`.',
    security: WEBHOOK_SECRET,
    errors: [
      UNAUTHORIZED,
      { status: 400, code: 'bad_request' },
      { status: 404, code: 'not_found' },
      { status: 409, code: 'invalid_transition' },
      { status: 422, code: 'project_outline_invalid' },
    ],
    successStatus: 201,
    handler: {
      module: 'src/routes/project-request-lifecycle.ts',
      exportName: 'handleProjectRequestOutline',
      load: () => import('../../routes/project-request-lifecycle'),
    },
  }),
  serviceRoute({
    id: 'webhooks.teams_incoming',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/teams',
    operationId: 'webhookTeamsIncoming',
    summary: 'Inbound Microsoft Teams approval action',
    description:
      'x-teams-signature equal to TEAMS_WEBHOOK_SECRET and/or (TEAMS_JWT_VERIFY=true) a Bot Framework JWT; ' +
      'neither configured ⇒ 401. Body `{approvalId, decision, approverId?, comment?}`.',
    security: NONE,
    errors: [UNAUTHORIZED, { status: 400, code: 'bad_request' }, { status: 403, code: 'TEAMS_IDENTITY_UNMAPPED' }, { status: 404, code: 'UPSTREAM_NOT_FOUND' }],
    handler: { module: 'src/routes/teams-webhook.ts', exportName: 'handleTeamsIncoming', load: () => import('../../routes/teams-webhook') },
  }),
  serviceRoute({
    id: 'webhooks.telegram_incoming',
    area: 'webhooks',
    principal: 'webhook',
    method: 'POST',
    path: '/api/webhooks/telegram/incoming',
    operationId: 'webhookTelegramIncoming',
    summary: 'Inbound Telegram update (channel dispatcher)',
    description:
      'X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET (a refused caller gets 200: Telegram ' +
      'disables a webhook that keeps failing). Body: a Telegram Update. 200 `{received: true}`.',
    security: NONE,
    errors: [],
    handler: { module: 'src/routes/telegram-webhook.ts', exportName: 'handleTelegramIncoming', load: () => import('../../routes/telegram-webhook') },
  }),
];
