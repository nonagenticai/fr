// fr-agui SPEC §13 P4b (part 2) — spec drain: the workers asset surface
// `/api/assets/workers` (routes/assets/workers.ts), re-expressed with NO behaviour
// change (`legacyHandler`). Every route proxies worker_management, whose client is
// `requireTenant`: with no non-blank REQUEST-CONTEXT tenant nothing is sent (409
// MISSING_TENANT), so every declared rule names the FRAME tenant.
//
// Gates, as the handlers enforce them (after validateAuth and its doors):
//   * reads (list, get)                  — the frame tenant:
//                                          `isAuthenticatedUserInFrameTenant`;
//   * registry writes (create, update, delete) — a workspace-admin of the request
//                                          tenant (403 'workspace-admin role required'),
//                                          then the frame tenant: route-aware
//                                          `workspace-admin` + `frameTenant`;
//   * the key-SPENDING routes (send message, the provider list and models, chat
//     completions) — a workspace-admin OR a platform super_admin, then the frame
//     tenant: `workspace-admin` + `superAdmin` + `frameTenant` (the /chat pair,
//     the same rule as the LLM settings).
//
// INPUTS. fr forwards the create / update / message / chat bodies VERBATIM and
// enforces none of their fields (only that the body is JSON). The declared inputs
// are therefore the END-TO-END contract — worker_management's own request models
// (src/api/workers/models.py WorkerCreateRequest / MessageRequest,
// src/api/providers/_chat_router.py ChatCompletionsRequest, origin/main 2f2c628),
// typed so a generated client sends objects and numbers. The create / update and
// chat bodies keep `.passthrough()`: WorkerCreateRequest (`extra="ignore"`) and
// ChatCompletionsRequest drop a key this declaration does not name. The message
// body is `.strict()`: MessageRequest is `extra="forbid"`, so worker_management
// answers an unknown key with a 422 (relayed).
//
// 🔐 Three worker fields are secret-bearing, by worker_management's own rule
// (crud_endpoints.py `_secrets_withheld_reason` / `_overrides_for_caller`):
// `api_key_override` (a per-worker provider key), `base_url_override` (a URL can
// embed credentials) and `mcp_config` (it can carry an auth dict). All three are
// secret INPUTS of create / update. They are a secret OUTPUT of GET only, under
// worker_management's two-flag rule (`identity_proven` AND `tenant_proven`; null
// otherwise), and fr relays the view unchanged. The create / update answer NEVER
// carries them: worker_management builds it with `echo_overrides=False` (an
// upsert's reply lands in n8n's execution log), so they are always null there and
// that answer's schema does not declare them.
import { z } from 'zod';

import type { ResponseSpec } from '../define';
import { isAuthenticatedUserInFrameTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody, workspaceAdminRule, type SettingsRoute } from '../settings/_shared';

const MODULE = { module: 'src/routes/assets/workers.ts', load: () => import('../../routes/assets/workers') };

const name = z.object({ name: pathId('Worker name (unique per tenant)') });

const workTier = z.enum(['small', 'medium', 'high']);
const jsonObject = z.record(z.unknown());

/** worker_management `WorkerCreateRequest` (create and PUT update; WM ignores unknown keys). */
const workerRequest = z
  .object({
    worker_name: z.string().min(1),
    tool_names: z.array(z.string()).optional(),
    agent_role: z.string().nullable().optional(),
    agent_type: z.string().nullable().optional(),
    model_provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    ir_provider: z.string().nullable().optional().describe('inference-router provider to pin (X-Provider), e.g. pgx-local.'),
    seed: z.number().int().nullable().optional(),
    repetition_penalty: z.number().gt(0).max(2).nullable().optional(),
    frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
    enforce_schema_bounds: z.boolean().nullable().optional(),
    max_tokens: z.number().int().min(1).max(16384).nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    instruction: z.string().nullable().optional(),
    user_prompt: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    deps: z.array(z.string()).nullable().optional(),
    mcp_config: z.union([z.string(), jsonObject]).nullable().optional().describe('🔐 SECRET (can carry auth). MCP server config.'),
    mcp_config_preset: z.string().nullable().optional(),
    mcp_servers: z.array(z.string()).nullable().optional(),
    base_url_override: z.string().nullable().optional().describe('🔐 SECRET (a URL can embed credentials). An allowlisted OpenAI-compatible base URL.'),
    api_key_override: z.string().min(1).nullable().optional().describe('🔐 SECRET. A per-worker provider key.'),
    tools_dir_override: z.string().min(1).nullable().optional(),
    output_schema: jsonObject.nullable().optional().describe('JSON Schema the model output must satisfy.'),
    output_validator: z.string().nullable().optional().describe('UNSUPPORTED: must be null or empty.'),
    output_retries: z.number().int().min(0).max(10).nullable().optional(),
    container_id: z.string().nullable().optional(),
    executor_endpoint: z.string().nullable().optional(),
    workspace: z.string().nullable().optional(),
    disable_state_storage: z.boolean().optional(),
    config_revision: z.string().max(64).nullable().optional(),
    work_tier: workTier.nullable().optional(),
  })
  .passthrough()
  .describe("Forwarded verbatim to worker_management (WorkerCreateRequest); fr checks only that the body is JSON.");

/** worker_management `WorkerResponse`, as GET answers it. */
const worker = z
  .object({
    id: z.union([z.number(), z.string()]).nullable().optional(),
    name: z.string(),
    status: z.string(),
    db_path: z.string().nullable().optional(),
    is_agent: z.boolean(),
    agent_type: z.string().nullable().optional(),
    model_provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    instruction: z.string().nullable().optional(),
    temperature: z.number().nullable().optional(),
    max_tokens: z.number().int().nullable().optional(),
    tool_names: z.array(z.string()).optional(),
    output_schema: jsonObject.nullable().optional(),
    output_validator: z.string().nullable().optional(),
    output_retries: z.number().int().nullable().optional(),
    mcp_config: z
      .union([z.string(), jsonObject])
      .nullable()
      .optional()
      .describe("🔐 SECRET. GET only, under worker_management's two-flag rule (identity AND tenant proven); null (withheld) otherwise."),
    base_url_override: z
      .string()
      .nullable()
      .optional()
      .describe("🔐 SECRET. GET only, under worker_management's two-flag rule (identity AND tenant proven); null (withheld) otherwise."),
    api_key_override: z
      .string()
      .nullable()
      .optional()
      .describe("🔐 SECRET. GET only, under worker_management's two-flag rule (identity AND tenant proven); null (withheld) otherwise."),
    config_revision: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * worker_management `WorkerResponse` as create / update answer it: built with
 * `echo_overrides=False`, so `api_key_override`, `base_url_override` and
 * `mcp_config` are always null and are not declared here (GET only).
 */
const workerUpsertEcho = worker
  .omit({ api_key_override: true, base_url_override: true, mcp_config: true })
  .describe(
    "The worker as stored. api_key_override, base_url_override and mcp_config are always null in this answer (worker_management never " +
      "echoes them on an upsert); read them with GET, under worker_management's two-flag rule.",
  );

/** The secret-bearing worker fields (worker_management `_secrets_withheld_reason`), in schema order. */
const WORKER_SECRET_KEYS = ['mcp_config', 'base_url_override', 'api_key_override'] as const;
const secretInputs = WORKER_SECRET_KEYS.map((k) => `/${k}`);
const secretOutputs = WORKER_SECRET_KEYS.map((k) => `/data/${k}`);

const contentBlock = z.union([
  z.object({ type: z.literal('text'), text: z.string().min(1) }).passthrough(),
  z
    .object({
      type: z.literal('image'),
      data: z.string().min(1).describe('Base64-encoded image bytes (decoded at most 10 MB).'),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']).optional(),
    })
    .passthrough(),
]);

/** worker_management `MessageRequest`. */
const messageRequest = z
  .object({
    trust_content: z.boolean().optional(),
    message: z.union([z.string(), z.array(contentBlock)]),
    context: jsonObject.nullable().optional(),
    system_prompt: z.string().max(1_000_000).nullable().optional(),
    instruction: z.string().max(1_000_000).nullable().optional(),
    output_schema: jsonObject.nullable().optional(),
    output_validator: z.string().nullable().optional().describe('UNSUPPORTED: must be null or empty.'),
    disable_state_storage: z.boolean().optional(),
    require_existing: z.boolean().optional().describe('404 instead of auto-creating a promptless worker of this name.'),
    model_override: z.string().nullable().optional(),
    work_tier: workTier.nullable().optional(),
    product: z.string().nullable().optional(),
    max_tokens: z.number().int().nullable().optional(),
    enable_reasoning: z.boolean().nullable().optional(),
    seed: z.number().int().nullable().optional(),
    repetition_penalty: z.number().gt(0).max(2).nullable().optional(),
    frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
    temperature: z.number().min(0).max(1).nullable().optional(),
    enforce_schema_bounds: z.boolean().nullable().optional(),
    correlation_id: z.string().uuid().nullable().optional(),
    prompt_versions: z.record(z.number().int()).nullable().optional(),
  })
  .strict()
  .describe(
    'Forwarded verbatim to worker_management (MessageRequest, extra="forbid": an unknown key is its 422, relayed); ' +
      'fr checks only that the body is JSON.',
  );

/** worker_management `MessageResponse`. */
const messageResponse = z
  .object({
    output: z.unknown(),
    output_type: z.enum(['string', 'object', 'array', 'boolean', 'enum', 'other']),
    output_schema_used: jsonObject.nullable().optional(),
    metadata: jsonObject.nullable().optional(),
    usage_metrics: jsonObject.nullable().optional(),
    served_provider: z.string().nullable().optional(),
    served_model: z.string().nullable().optional(),
    served_model_root: z.string().nullable().optional(),
  })
  .passthrough();

/** worker_management `ChatCompletionsRequest`. */
const chatRequest = z
  .object({
    provider: z.string().describe('A provider name from GET /api/assets/workers/providers.'),
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).passthrough()).min(1),
    system_prompt: z.string().nullable().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(16384).nullable().optional(),
    seed: z.number().int().nullable().optional(),
    repetition_penalty: z.number().gt(0).max(2).nullable().optional(),
    frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
    correlation_id: z.string().uuid().nullable().optional(),
    output_schema: jsonObject.nullable().optional(),
    stream: z.boolean().optional().describe('true: the answer is a text/event-stream (SSE) of deltas instead of the JSON body.'),
  })
  .passthrough()
  .describe('Forwarded verbatim to worker_management (ChatCompletionsRequest); fr only proxies it.');

/** worker_management `ChatCompletionsResponse` (stream: false). */
const chatResponse = z
  .object({
    output: z.string(),
    provider: z.string(),
    model: z.string(),
    usage: jsonObject,
    resolved_model: z.string().nullable().optional(),
    resolved_provider: z.string().nullable().optional(),
    served_provider: z.string().nullable().optional(),
    served_model: z.string().nullable().optional(),
    served_model_root: z.string().nullable().optional(),
  })
  .passthrough();

const ADMIN_403 = "403: `error` 'workspace-admin role required' (not a workspace-admin of the request tenant";
const relayed =
  " 409: `error.code` 'MISSING_TENANT' (no request tenant: nothing is sent to worker_management). Any other status is " +
  "worker_management's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no answer is 502, a " +
  "timeout 504), or fr's own 500 (`error`).";

const responses = (o: { body?: boolean; admin?: 'workspace' | 'spend'; byo?: boolean; models?: boolean }): ResponseSpec[] => [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      (o.body ? "400: `error.code` 'BAD_REQUEST' ('Invalid JSON request body'; nothing sent). " : '') +
      (o.admin === 'workspace' ? `${ADMIN_403}). ` : '') +
      (o.admin === 'spend' ? `${ADMIN_403} nor a super_admin). ` : '') +
      (o.byo
        ? "A worker_management BYO-key refusal (`error.code` e.g. 'BYO_KEY_WITHHELD', `error.message` the user sentence, " +
          '`error.details` the provider / tier / model) keeps its 4xx; any other status of it is 424. '
        : '') +
      (o.models
        ? "403 `error.code` 'PROVIDER_NOT_ENABLED' (worker_management refused the provider for this workspace) or " +
          "'END_TENANT_NOT_PROVEN'; 424 'PROVIDER_UNAVAILABLE' (the provider's backend, or worker_management, did not answer). "
        : '') +
      DOOR_403 +
      relayed,
    schema: frErrorBody,
  },
];

const ROUTES: SettingsRoute[] = [
  {
    id: 'workers.list_providers', method: 'GET', path: '/api/assets/workers/providers', handler: 'handleListWorkerProviders',
    summary: 'The LLM providers a worker or the chat console can use', effect: 'read',
    input: z.object({}),
    output: z
      .object({
        object: z.string().optional(),
        data: z.array(z.object({ name: z.string(), label: z.string(), description: z.string(), requires_api_key: z.boolean() }).passthrough()),
      })
      .passthrough(),
    responses: responses({ admin: 'spend', byo: true }),
    rule: workspaceAdminRule({ superAdmin: true, frameTenant: true }),
  },
  {
    id: 'workers.list_provider_models', method: 'GET', path: '/api/assets/workers/providers/:provider/models', handler: 'handleListWorkerProviderModels',
    summary: "A provider's models, listed live on the tenant's key", effect: 'read',
    input: z.object({ provider: pathId('Provider name') }),
    output: z
      .object({ object: z.string().optional(), provider: z.string(), data: z.array(z.object({ id: z.string(), object: z.string().optional() }).passthrough()) })
      .passthrough(),
    responses: responses({ admin: 'spend', byo: true, models: true }),
    rule: workspaceAdminRule({ superAdmin: true, frameTenant: true }),
  },
  {
    id: 'workers.list', method: 'GET', path: '/api/assets/workers', handler: 'handleListWorkers',
    summary: "The request tenant's worker names", effect: 'read',
    input: z.object({
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ data: z.array(z.string()) }),
    responses: [
      responses({})[0]!,
      { ...responses({})[1]!, description: "422: `error` 'Validation error' (`limit` not 1-1000 / `offset` negative; nothing sent). " + responses({})[1]!.description },
    ],
    rule: routeRule(isAuthenticatedUserInFrameTenant),
  },
  {
    id: 'workers.create', method: 'POST', path: '/api/assets/workers', handler: 'handleCreateWorker',
    summary: 'Register a worker in the request tenant', effect: 'write', successStatus: 201,
    description:
      "The answer never carries api_key_override, base_url_override or mcp_config (always null: worker_management does not echo " +
      "them on an upsert). They are returned by GET only, under worker_management's two-flag rule.",
    input: workerRequest, output: z.object({ data: workerUpsertEcho }), responses: responses({ body: true, admin: 'workspace' }),
    secrets: { input: secretInputs },
  },
  {
    id: 'workers.get', method: 'GET', path: '/api/assets/workers/:name', handler: 'handleGetWorker',
    summary: 'One worker of the request tenant', effect: 'read',
    description:
      "api_key_override, base_url_override and mcp_config are returned only under worker_management's two-flag rule (the caller's " +
      'licence token proved its identity AND this tenant); null (withheld) otherwise.',
    input: name, output: z.object({ data: worker }), responses: responses({}),
    rule: routeRule(isAuthenticatedUserInFrameTenant),
    secrets: { output: secretOutputs },
  },
  {
    id: 'workers.update', method: 'PUT', path: '/api/assets/workers/:name', handler: 'handleUpdateWorker',
    summary: "Replace a worker's configuration", effect: 'write',
    description:
      "The answer never carries api_key_override, base_url_override or mcp_config (always null: worker_management does not echo " +
      "them on an upsert). They are returned by GET only, under worker_management's two-flag rule.",
    input: workerRequest.extend(name.shape), output: z.object({ data: workerUpsertEcho }), responses: responses({ body: true, admin: 'workspace' }),
    secrets: { input: secretInputs },
  },
  {
    id: 'workers.delete', method: 'DELETE', path: '/api/assets/workers/:name', handler: 'handleDeleteWorker',
    summary: 'Delete a worker', effect: 'destructive', successStatus: 204,
    input: name, output: z.null(), responses: responses({ admin: 'workspace' }),
  },
  {
    id: 'workers.send_message', method: 'POST', path: '/api/assets/workers/:name/message', handler: 'handleSendWorkerMessage',
    summary: 'Send one message to a worker (runs it on the tenant key)', effect: 'write',
    input: messageRequest.extend(name.shape), output: z.object({ data: messageResponse }),
    responses: responses({ body: true, admin: 'spend', byo: true }),
    rule: workspaceAdminRule({ superAdmin: true, frameTenant: true }),
  },
  {
    id: 'workers.chat_completions', method: 'POST', path: '/api/assets/workers/chat/completions', handler: 'handleWorkerChatCompletions',
    summary: 'A chat completion from a chosen provider and model (the /chat console)', effect: 'write',
    description: 'Proxied to worker_management unbuffered: with `stream: true` the answer is a text/event-stream; otherwise this JSON body.',
    input: chatRequest, output: chatResponse,
    responses: [
      {
        status: 401,
        description: `${VALIDATE_AUTH_401} Or worker_management's own 401, relayed unchanged (its body).`,
        schema: z.union([unauthorizedBody, z.object({ detail: z.unknown() }).passthrough()]),
      },
      {
        status: 'default',
        description:
          `${ADMIN_403} nor a super_admin). ${DOOR_403} 409: \`error.code\` 'MISSING_TENANT' (no request tenant: nothing is sent). ` +
          "502 / 504: worker_management unreachable / timed out (`error.code` 'UPSTREAM_…'). Any other status and body are " +
          "worker_management's own, relayed UNCHANGED (unbuffered proxy): e.g. its 404 unknown provider or 422 `{ detail }`.",
        schema: z.union([frErrorBody, z.object({ detail: z.unknown() }).passthrough()]),
      },
    ],
    rule: workspaceAdminRule({ superAdmin: true, frameTenant: true }),
  },
];

export const WORKER_CAPABILITIES = settingsCapabilities(
  { area: 'workers', tag: 'Workers', tenancy: 'tenant', ...MODULE, rule: workspaceAdminRule({ frameTenant: true }) },
  ROUTES,
);
