// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: the tenant LLM-provider, pricing,
// inference and conveyor-admin routes that ALREADY had an operation in the openapi.ts literal,
// re-expressed with NO behaviour change (`legacyHandler`):
//   * `/api/settings/llm-provider/{audit,test}` (workspace-admin of the active tenant, or a platform
//     super-admin — the rest of /api/settings/llm-provider is P4b's, capabilities/settings/llm-provider.ts);
//   * the super-admin mirror `/api/admin/tenants/:tenantId/llm-provider[/all|/catalog|/audit|/test]`;
//   * `/api/admin/pricing/fx-rates` (GET, PUT; the other pricing routes are P4c part 3's);
//   * the super-admin tenant inference routes (`/api/admin/inference/config`,
//     `/api/admin/tenants/:tenantId/inference-policy[/activate]`, `…/inference/apply`);
//   * `GET /api/conveyor/priority-levels` and the super-admin
//     `POST /api/admin/tenants/:tenantId/catalogue/import-defaults`.
//
// Each literal operation moves VERBATIM into `openapi.frozen` (capabilities/frozen-routes.ts); the
// only edits are the measured ones, named by id in tests/unit/capabilities/p4d2d-capabilities.test.ts.
//
// Ids: `conveyor.list_priority_levels` is a DOORWAY agent action (agent/intake-catalog.ts, served by
// agui/actions/projects-create.ts); the route's declaration is `conveyor.list_tenant_priority_levels`,
// out of agent scope, and the doorway action is unchanged (re-homing it is the doorway's change).
//
// 🔐 `PUT /api/admin/tenants/:tenantId/llm-provider` takes the tenant's provider key (`apiKey`,
// write-only): `secrets.input`. No route here returns a key (`hasKey` only).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { isAuthenticatedSuperAdmin, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { routeRule, workspaceAdminRule } from '../account/_shared';

const superAdmin = routeRule(isAuthenticatedSuperAdmin);
const tenantAdmin = workspaceAdminRule({ superAdmin: true, frameTenant: true });
const resolvedTenant = routeRule(isAuthenticatedUserInResolvedTenant);

const ADMIN_ROUTES: FrozenRoute[] = [
  {
    area: 'settings', id: 'settings.list_llm_provider_audit', method: 'GET', path: '/api/settings/llm-provider/audit', handler: 'handleGetLlmProviderAudit', effect: 'read',
    rule: tenantAdmin,
    tenancy: 'tenant',
    source: { module: 'src/routes/settings/llm-provider.ts', load: () => import('../../routes/settings/llm-provider') },
    frozen: {
      summary: 'Who set, removed or tested this workspace’s LLM provider keys',
      description:
        'Proxies worker_management `GET /tenant-config/llm/audit` for the caller’s own (or switched) ' +
        'workspace, newest first. Owner ruling 2026-10-02: when the platform operator sets, tests or ' +
        'removes a customer’s BYO key, the customer must be able to see it (`actor: platform_operator`). ' +
        'No key, key hash or user id is ever returned.\n\n' +
        'Authz: workspace-admin of the active tenant, or a platform super-admin.',
      tags: ['LLM Provider'],
      operationId: 'listLlmProviderAudit',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 }, description: 'Max entries (default 50 at worker_management)' }],
      responses: {
        '200': {
          description: 'Change history, newest first',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['entries'],
                properties: {
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['at', 'tier', 'action', 'actor', 'provider', 'keyId'],
                      properties: {
                        at: { type: 'string', format: 'date-time' },
                        tier: { type: 'string', enum: ['small', 'medium', 'high'], nullable: true, description: 'null = the default row' },
                        action: { type: 'string', enum: ['set_key', 'clear_key', 'update', 'remove', 'test'] },
                        actor: { type: 'string', enum: ['platform_operator', 'workspace_admin', 'service'] },
                        provider: { type: 'string', nullable: true },
                        keyId: { type: 'string', description: "12-hex key fingerprint, or 'none'. Never the key." },
                      },
                    },
                  },
                },
              },
            },
          } } },
        },
        '400': { description: 'limit is not an integer in 1..200', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'workspace-admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'settings', id: 'settings.test_llm_provider_key', method: 'POST', path: '/api/settings/llm-provider/test', handler: 'handleTestLlmProvider', effect: 'write',
    rule: tenantAdmin,
    tenancy: 'tenant',
    source: { module: 'src/routes/settings/llm-provider.ts', load: () => import('../../routes/settings/llm-provider') },
    frozen: {
      summary: 'Live-test the workspace’s LLM provider key for a tier',
      description:
        'Proxies worker_management `POST /tenant-config/llm/test` (owner ruling 2026-10-01): ONE ' +
        'minimal live call (the provider’s model list) with the credential of the tenant row the ' +
        'tier resolves to — the tier row, else the `__default__` row. Drives the green/red dot per ' +
        'tier on `/settings/llm-provider`.\n\n' +
        'Body `{tier?}` (absent/null ⇒ the default row) OR `{provider, model?}`; both is a 400. ' +
        '`ok:false` is a normal 200 answer (no row, a withheld/undecryptable key, a vendor ' +
        'rejection) with `error` saying which. The key is never returned.\n\n' +
        'A DELEGATED call: fr forwards the signed-in user’s portal token as `X-End-User-Token`, ' +
        'which worker_management#316 requires before it decrypts the tenant’s key.\n\n' +
        'Authz: workspace-admin of the active tenant, or a platform super-admin.',
      tags: ['LLM Provider'],
      operationId: 'testLlmProviderKey',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: false,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            tier: { type: 'string', enum: ['small', 'medium', 'high'], nullable: true },
            provider: { type: 'string' },
            model: { type: 'string' },
          },
        } } },
      },
      responses: {
        '200': {
          description: 'The verdict of the live call',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['ok'],
                properties: {
                  ok: { type: 'boolean' },
                  provider: { type: 'string', nullable: true },
                  model: { type: 'string', nullable: true },
                  latency_ms: { type: 'integer', nullable: true },
                  error: { type: 'string', nullable: true },
                  warning: { type: 'string', nullable: true },
                },
              },
            },
          } } },
        },
        '400': { description: 'Unknown tier, or both `tier` and `provider` sent', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'workspace-admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_get_tenant_provider', method: 'GET', path: '/api/admin/tenants/:tenantId/llm-provider', handler: 'handleAdminGetTenantLlmProvider', effect: 'read',
    rule: superAdmin,
    frozen: {
      summary: 'Owner: read a customer tenant’s LLM config for a tier (key masked)',
      description: 'Owner-only mirror of `/api/settings/llm-provider` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned (`hasKey` only). Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminGetTenantLlmProvider',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'tier', in: 'query', required: false, schema: { type: 'string', enum: ['small', 'medium', 'high'] } }],
      responses: {
        '200': { description: 'OK' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_put_tenant_provider', method: 'PUT', path: '/api/admin/tenants/:tenantId/llm-provider', handler: 'handleAdminPutTenantLlmProvider', effect: 'write',
    nonJson400: { error: 'Invalid JSON request body' },
    rule: superAdmin,
    secrets: { input: ['/apiKey'] },
    frozen: {
      summary: 'Owner: set a customer tenant’s BYO provider/key for a tier',
      description: 'Owner-only mirror of `/api/settings/llm-provider` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned (`hasKey` only). Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminPutTenantLlmProvider',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'tier', in: 'query', required: false, schema: { type: 'string', enum: ['small', 'medium', 'high'] } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['provider', 'model'], properties: { provider: { type: 'string' }, model: { type: 'string' }, baseUrl: { type: 'string' }, temperature: { type: 'number' }, maxTokens: { type: 'integer' }, params: { type: 'object' }, apiKey: { type: 'string', description: 'Write-only. Omit to preserve, empty string to clear.', 'x-secret': true } } } } } }, // P4d-2e: x-secret (P4d-2d carry)
      responses: {
        '200': { description: 'OK' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_delete_tenant_provider', method: 'DELETE', path: '/api/admin/tenants/:tenantId/llm-provider', handler: 'handleAdminDeleteTenantLlmProvider', effect: 'destructive',
    rule: superAdmin,
    frozen: {
      summary: 'Owner: revert a customer tenant’s tier to local-llm',
      description: 'Owner-only mirror of `/api/settings/llm-provider` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned (`hasKey` only). Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminDeleteTenantLlmProvider',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'tier', in: 'query', required: false, schema: { type: 'string', enum: ['small', 'medium', 'high'] } }],
      responses: {
        '204': { description: 'Removed — the tier falls back to the default row, then local-llm' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_list_tenant_providers', method: 'GET', path: '/api/admin/tenants/:tenantId/llm-provider/all', handler: 'handleAdminListTenantLlmProviders', effect: 'read',
    rule: superAdmin,
    frozen: {
      summary: 'Owner: every configured LLM row of a customer tenant',
      description: 'Owner-only mirror of `/api/settings/llm-provider` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned (`hasKey` only). Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminListTenantLlmProviders',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }],
      responses: {
        '200': { description: 'OK' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_get_tenant_catalog', method: 'GET', path: '/api/admin/tenants/:tenantId/llm-provider/catalog', handler: 'handleAdminGetTenantLlmCatalog', effect: 'read',
    rule: superAdmin,
    frozen: {
      summary: 'Owner: BYO provider catalog as seen for a customer tenant',
      description: 'Owner-only mirror of `/api/settings/llm-provider` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned (`hasKey` only). Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminGetTenantLlmCatalog',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }],
      responses: {
        '200': { description: 'OK' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_list_tenant_audit', method: 'GET', path: '/api/admin/tenants/:tenantId/llm-provider/audit', handler: 'handleAdminGetTenantLlmAudit', effect: 'read',
    rule: superAdmin,
    frozen: {
      summary: 'Owner: a customer tenant’s LLM provider change history',
      description: 'Owner-only mirror of `/api/settings/llm-provider/audit` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned. Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminListTenantLlmAudit',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 }, description: 'Max entries (default 50 at worker_management)' }],
      responses: {
        '200': {
          description: 'Change history, newest first',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['entries'],
                properties: {
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['at', 'tier', 'action', 'actor', 'provider', 'keyId'],
                      properties: {
                        at: { type: 'string', format: 'date-time' },
                        tier: { type: 'string', enum: ['small', 'medium', 'high'], nullable: true, description: 'null = the default row' },
                        action: { type: 'string', enum: ['set_key', 'clear_key', 'update', 'remove', 'test'] },
                        actor: { type: 'string', enum: ['platform_operator', 'workspace_admin', 'service'] },
                        provider: { type: 'string', nullable: true },
                        keyId: { type: 'string', description: "12-hex key fingerprint, or 'none'. Never the key." },
                      },
                    },
                  },
                },
              },
            },
          } } },
        },
        '400': { description: 'limit is not an integer in 1..200', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'llm_provider.admin_test_tenant_provider', method: 'POST', path: '/api/admin/tenants/:tenantId/llm-provider/test', handler: 'handleAdminTestTenantLlmProvider', effect: 'write',
    rule: superAdmin,
    frozen: {
      summary: 'Owner: live-test a customer tenant’s key for a tier (ok:false = red, incl. withheld)',
      description: 'Owner-only mirror of `/api/settings/llm-provider` for a CUSTOMER tenant named in the path. ' +
        'No key is ever returned (`hasKey` only). Authz: platform super-admin (signed realm role); ' +
        'a tenant_admin of the target is 403. Unknown or archived tenant is 404.',
      tags: ['LLM Provider'],
      operationId: 'adminTestTenantLlmProvider',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { tier: { type: 'string', enum: ['small', 'medium', 'high'], nullable: true }, provider: { type: 'string' }, model: { type: 'string' } } } } } },
      responses: {
        '200': { description: 'OK' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'pricing', id: 'pricing.list_fx_rates', method: 'GET', path: '/api/admin/pricing/fx-rates', handler: 'handleListFxRates', effect: 'read',
    rule: superAdmin,
    source: { module: 'src/routes/settings/pricing-admin.ts', load: () => import('../../routes/settings/pricing-admin') },
    frozen: {
      summary: 'Owner: USD→EUR FX rates (billing), newest first',
      description: 'Proxies billing GET /api/config/fx-rates. EUR money budgets consume fx × USD price, so a tenant ' +
        'cannot be EUR-provisioned until a rate exists. Authz: platform super-admin.',
      tags: ['Pricing'],
      operationId: 'adminListFxRates',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': { description: 'OK — {data: FxRate[]}' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'pricing', id: 'pricing.put_fx_rate', method: 'PUT', path: '/api/admin/pricing/fx-rates', handler: 'handlePutFxRate', effect: 'write',
    nonJson400: { error: 'body must be valid JSON' },
    rule: superAdmin,
    source: { module: 'src/routes/settings/pricing-admin.ts', load: () => import('../../routes/settings/pricing-admin') },
    frozen: {
      summary: 'Owner: open a new USD→EUR FX rate (billing)',
      description: 'Proxies billing PUT /api/config/fx-rates. Effective-dated: opens a new rate at effective_from ' +
        '(default now) and closes the open one. Back-date the FIRST rate to before the first money tenant’s first call. ' +
        'Authz: platform super-admin presenting their own verified portal token, which is relayed to billing ' +
        '(X-Forwarded-User-Authorization) so set_by records the human; a service-account or agent token is 403.',
      tags: ['Pricing'],
      operationId: 'adminPutFxRate',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['base', 'quote', 'rate'],
              properties: {
                base: { type: 'string', enum: ['USD'] },
                quote: { type: 'string', enum: ['EUR'] },
                rate: { type: 'string', example: '0.9200' },
                effective_from: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'OK — {data: FxRate}' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin, or presented no verified super_admin portal token (owner_portal_token_required)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: 'Invalid body, or effective_from not after the open rate', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'inference', id: 'inference.get_config', method: 'GET', path: '/api/admin/inference/config', handler: 'handleGetInferenceConfig', effect: 'read',
    rule: superAdmin,
    source: { module: 'src/routes/admin/tenant-inference.ts', load: () => import('../../routes/admin/tenant-inference') },
    frozen: {
      summary: 'Owner: tenant inference provisioning flags and per-setup availability',
      description: 'Whether FR_INFERENCE_PROVISIONING / FR_SETUP2_ENABLED are on, and for each setup ' +
        '(local | owner_commercial | byo) whether it may be chosen and, if not, why. ' +
        'Authz: platform super-admin (verified realm role).',
      tags: ['Tenant Inference'],
      operationId: 'adminGetInferenceConfig',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': { description: 'OK — {data: {enabled, setup2_enabled, setups[]}}' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Caller is not a platform super-admin (verified realm role)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'inference', id: 'inference.get_tenant_policy', method: 'GET', path: '/api/admin/tenants/:tenantId/inference-policy', handler: 'handleGetTenantInferencePolicy', effect: 'read',
    rule: superAdmin,
    source: { module: 'src/routes/admin/tenant-inference.ts', load: () => import('../../routes/admin/tenant-inference') },
    frozen: {
      summary: 'Owner: a customer tenant’s inference policy and version history',
      description: 'Proxies inference-router GET /api/admin/tenants/{t}/inference-policy with the owner’s ' +
        'portal JWT forwarded. Authz: platform super-admin. 404 while FR_INFERENCE_PROVISIONING is off, ' +
        'or for an unknown/archived tenant.',
      tags: ['Tenant Inference'],
      operationId: 'adminGetTenantInferencePolicy',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }],
      responses: {
        '200': { description: 'OK — {data: {active_version, doc, versions[]}}' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Not a platform super-admin, or no verified owner portal token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Flag off, or tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'inference', id: 'inference.activate_tenant_policy', method: 'POST', path: '/api/admin/tenants/:tenantId/inference-policy/activate', handler: 'handleActivateTenantInferencePolicy', effect: 'write',
    rule: superAdmin,
    source: { module: 'src/routes/admin/tenant-inference.ts', load: () => import('../../routes/admin/tenant-inference') },
    frozen: {
      summary: 'Owner: activate a stored inference policy version (rollback/forward)',
      description: 'Proxies inference-router POST …/inference-policy/activate {version}. Authz: platform super-admin. ' +
        '404 while FR_INFERENCE_PROVISIONING is off, or for an unknown/archived tenant.',
      tags: ['Tenant Inference'],
      operationId: 'adminActivateTenantInferencePolicy',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer', minimum: 1 } } } } },
      },
      responses: {
        '200': { description: 'OK — {data: {active_version}}' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Not a platform super-admin, or no verified owner portal token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Flag off, tenant unknown/archived, or version not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'inference', id: 'inference.apply_tenant', method: 'POST', path: '/api/admin/tenants/:tenantId/inference/apply', handler: 'handleApplyTenantInference', effect: 'write',
    rule: superAdmin,
    source: { module: 'src/routes/admin/tenant-inference.ts', load: () => import('../../routes/admin/tenant-inference') },
    frozen: {
      summary: 'Owner: apply (edit / re-check) a customer tenant’s inference configuration',
      description: 'Runs provisioning POST /api/tenants/{t}/inference/apply with a FRESH idempotency key and the ' +
        'owner’s portal JWT forwarded: licences byo_mode + EUR currency + bundle, billing money budget + markup + ' +
        'quote, IR policy, then a 1-token smoke per tier proved by an IR ledger read-back (`verified` only on a ' +
        'matching read-back). Body: {setup, tiers[], byo_mode, budget_eur (integer EUR), markup[], limits?}. ' +
        'Setup 2 is refused unless FR_SETUP2_ENABLED; setup 3 is refused until BYO key custody ships. No key or ' +
        'token is echoed or stored. Authz: platform super-admin.',
      tags: ['Tenant Inference'],
      operationId: 'adminApplyTenantInference',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target tenant id (or name) as the licences service resolves it' }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: {
        '200': { description: 'OK — {data: {status, policy_version, idempotency_key, replayed, steps[], smoke[]}}' },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Not a platform super-admin, or no verified owner portal token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Flag off, or tenant unknown or archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '409': { description: 'Refused upstream (setup2_disabled, setup3_not_yet_available, apply_in_progress, …)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: 'Invalid body (decimal EUR, unknown setup, setup 2/3 unavailable, …)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'conveyor', id: 'conveyor.list_tenant_priority_levels', method: 'GET', path: '/api/conveyor/priority-levels', handler: 'handleListTenantPriorityLevels', effect: 'read',
    rule: resolvedTenant,
    tenancy: 'tenant',
    source: { module: 'src/routes/conveyor-catalogue.ts', load: () => import('../../routes/conveyor-catalogue') },
    frozen: {
      summary: "The caller tenant's priority levels, ordered by rank (from requirements_management)",
      description: 'Read through the tenant catalogue reader (design Q3 = b: fr stores the level id). Rank 0 is the highest; the conveyor may never set the highest level. A tenant with no RM priority levels is 409 `catalogue_not_initialised`.',
      tags: ['Conveyor'],
      operationId: 'listTenantPriorityLevels',
      responses: {
        '200': { description: '{ data: [{ id, name, title, rank, is_default, conveyor_may_set, description }] }' },
        '401': { description: 'Unauthenticated' },
        '409': { description: '`catalogue_not_initialised` (details.tenant_id, details.missing)' },
      },
    },
  },
  {
    area: 'conveyor', id: 'conveyor.admin_import_tenant_catalogue_defaults', method: 'POST', path: '/api/admin/tenants/:tenantId/catalogue/import-defaults', handler: 'handleSuperAdminImportCatalogueDefaults', effect: 'write',
    rule: superAdmin,
    source: { module: 'src/routes/conveyor-catalogue.ts', load: () => import('../../routes/conveyor-catalogue') },
    frozen: {
      summary: 'Seed a named tenant PM catalogue from requirements_management defaults (super-admin)',
      description: 'The remedy for a `catalogue_not_initialised` (409) tenant. Calls RM `POST /pm/catalogue/import-defaults` for the PATH tenant (idempotent by name; never overwrites). Tenant provisioning makes the same call.',
      tags: ['Conveyor'],
      operationId: 'adminImportTenantCatalogueDefaults',
      parameters: [
        { name: 'tenantId', in: 'path', required: true, description: 'Tenant to seed', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': { description: '{ data: <RM import result> }' },
        '400': { description: '`invalid_tenant_id` or `invalid_json`' },
        '401': { description: 'Unauthenticated' },
        '403': { description: '`super_admin_required`' },
        '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
      },
    },
  },
];

export const ADMIN_FROZEN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities(
  { area: 'llm_provider', tenancy: 'platform', module: 'src/routes/admin/tenant-llm-provider.ts', load: () => import('../../routes/admin/tenant-llm-provider') },
  ADMIN_ROUTES,
);
