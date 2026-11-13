// fr-agui SPEC §13 P4b — spec drain: the BYO LLM provider settings
// (routes/settings/llm-provider.ts) re-expressed as capabilities with NO
// behaviour change (`legacyHandler`).
//
// Five routes were undeclared; `POST .../test` and `GET .../audit` already have
// operations in the openapi.ts literal and stay there (rows in server.ts).
//
// Gate (every route): validateAuth (its licence / conveyor doors), then
// `isTenantAdmin` — a super_admin, or a workspace-admin of `ctxTenantId(user.tenantId)`
// — else 403 'workspace-admin role required'. The worker_management client is
// `requireTenant`, so with no non-blank REQUEST-CONTEXT tenant nothing is sent
// (409 MISSING_TENANT): the declared rule is the route-aware `workspace-admin`
// rule with `superAdmin` and `frameTenant` (agui/rbac.ts).
//
// 🔐 `apiKey` is a secret INPUT (PUT). It is never returned: worker_management
// answers `hasKey`, and `pickLlmConfigView` (integrations/workers.ts) copies only
// the declared view fields, so no declared output carries a key.
import { z } from 'zod';

import type { ResponseSpec } from '../define';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, settingsCapabilities, unauthorizedBody, workspaceAdminRule, type SettingsRoute } from './_shared';

const MODULE = { module: 'src/routes/settings/llm-provider.ts', load: () => import('../../routes/settings/llm-provider') };

const TIERS = ['small', 'medium', 'high'] as const;

/** `?tier=`: absent or '' ⇒ the `__default__` row; anything else but a tier is a 400 before worker_management. */
const tier = z
  .enum([...TIERS, ''])
  .optional()
  .describe("Work-size tier: 'small' | 'medium' | 'high'; absent or empty = the default row. Any other value is a 400.");

/** The masked config view (`pickLlmConfigView`): the key itself is never present, only `hasKey`. */
const configView = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  params: z.record(z.unknown()),
  hasKey: z.boolean().describe('Whether a key is stored. The key itself is never returned.'),
  updatedAt: z.string().nullable(),
});

const configRow = configView.extend({ role: z.string(), tier: z.enum(TIERS).nullable() });

const catalogProvider = z
  .object({
    key: z.string(),
    label: z.string(),
    provider: z.string(),
    default_base_url: z.string().nullable(),
    requires_api_key: z.boolean(),
    requires_base_url: z.boolean(),
    is_external: z.boolean(),
    models: z.array(z.string()),
    model_classes: z.record(z.string()),
    required_params: z.array(z.string()),
  })
  .passthrough();

/** The PUT body (`buildLlmUpdate`): every check the route makes, and no more. */
const putBody = z.object({
  tier,
  provider: z.string().min(1).describe('Required, non-empty.'),
  model: z.string().min(1).describe('Required, non-empty.'),
  baseUrl: z.string().nullable().optional().describe('An empty string or null is dropped (no base URL).'),
  temperature: z.number().nullable().optional(),
  maxTokens: z.number().int().nullable().optional(),
  params: z.record(z.unknown()).nullable().optional(),
  apiKey: z
    .string()
    .optional()
    .describe('🔐 SECRET. Absent = keep the stored key; empty string = clear it; a value = set it. Never returned.'),
});

const RESPONSES: ResponseSpec[] = [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      "400: fr refused the input (`error`: an unknown `tier`, 'Invalid JSON request body', 'body must be an object', " +
      "'provider is required', 'model is required' or a field-type message; nothing sent). 403: `error` 'workspace-admin " +
      "role required' (neither a workspace-admin of the request tenant nor a super_admin), or " +
      DOOR_403 +
      " 409: `error.code` 'MISSING_TENANT' (no request tenant: nothing is sent to worker_management). Any other status " +
      "is worker_management's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no answer is " +
      "502, a timeout 504), or fr's own 500 (e.g. no tenant resolvable for a non-super-admin).",
    schema: frErrorBody,
  },
];

const ROUTES: SettingsRoute[] = [
  {
    id: 'settings.list_llm_providers', method: 'GET', path: '/api/settings/llm-provider/all', handler: 'handleListLlmProviders',
    summary: "Every configured LLM provider row of the request tenant (default + tiers), keys masked", effect: 'read',
    input: z.object({}), output: z.object({ data: z.object({ configs: z.array(configRow) }) }), responses: RESPONSES,
  },
  {
    id: 'settings.get_llm_catalog', method: 'GET', path: '/api/settings/llm-provider/catalog', handler: 'handleGetLlmCatalog',
    summary: 'The BYO LLM providers the request tenant may configure', effect: 'read',
    input: z.object({}), output: z.object({ data: z.object({ providers: z.array(catalogProvider) }).passthrough() }), responses: RESPONSES,
  },
  {
    id: 'settings.get_llm_provider', method: 'GET', path: '/api/settings/llm-provider', handler: 'handleGetLlmProvider',
    summary: "The request tenant's LLM provider config for a tier (key masked)", effect: 'read',
    input: z.object({ tier }), output: z.object({ data: configView }), responses: RESPONSES,
  },
  {
    id: 'settings.set_llm_provider', method: 'PUT', path: '/api/settings/llm-provider', handler: 'handlePutLlmProvider',
    summary: "Create or update the request tenant's LLM provider config for a tier", effect: 'write',
    description: '`tier` is a query parameter; the rest is the JSON body. The answer is the masked view (`hasKey`, never the key).',
    input: putBody, output: z.object({ data: configView }), responses: RESPONSES,
    queryFields: ['tier'],
    secrets: { input: ['/apiKey'] },
  },
  {
    id: 'settings.delete_llm_provider', method: 'DELETE', path: '/api/settings/llm-provider', handler: 'handleDeleteLlmProvider',
    summary: "Remove the request tenant's LLM provider config for a tier (back to platform routing)", effect: 'destructive',
    input: z.object({ tier }), output: z.null(), successStatus: 204, responses: RESPONSES,
  },
];

export const LLM_PROVIDER_CAPABILITIES = settingsCapabilities(
  { area: 'settings', tag: 'LLM Provider', tenancy: 'tenant', ...MODULE, rule: workspaceAdminRule({ superAdmin: true, frameTenant: true }) },
  ROUTES,
);
