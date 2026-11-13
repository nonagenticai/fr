// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: the caller's fr secret store, the
// tenant's GitHub App installations and the tenant usage reads that ALREADY had an operation in the
// openapi.ts literal, re-expressed with NO behaviour change (`legacyHandler`):
//   * `/api/secrets[/:id]` (the caller's own `user_secrets`; the `/api/me/secrets` alias is P4b's);
//   * `/api/github-app/{install-url,claims/:handle/confirm,installations[/:id]}` (workspace-admin or
//     super-admin for the writes; the callback and the internal binding read are P4b part 3's / P1b's);
//   * `GET /api/tenant/usage/breakdown` (workspace-admin or super-admin) and `GET /api/me/usage/funding`.
//
// Each literal operation moves VERBATIM into `openapi.frozen` (capabilities/frozen-routes.ts); the
// only edits are the measured ones, named by id in tests/unit/capabilities/p4d2d-capabilities.test.ts.
//
// Ids: `github_app.install_url` is a DOORWAY member not yet registered (agent/intake-catalog.ts
// DOORWAY_NOT_YET_REGISTERED); the route's declaration is `github_app.create_install_url`, out of
// agent scope, so the doorway set is unchanged.
//
// 🔐 The secret writes carry the value (`secret_value`): `secrets.input`. No route here returns it.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { isAuthenticatedUser, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { routeRule, workspaceAdminRule } from '../account/_shared';

const authenticated = routeRule(isAuthenticatedUser);
const resolvedTenant = routeRule(isAuthenticatedUserInResolvedTenant);
const workspaceAdmin = workspaceAdminRule({ superAdmin: true });

const ACCOUNT_ROUTES: FrozenRoute[] = [
  {
    id: 'secrets.list_secrets', method: 'GET', path: '/api/secrets', handler: 'handleListSecrets', effect: 'read',
    unauthorized401: "`error` 'Missing or invalid Authorization header' / 'Invalid or expired token' (validateAuth).",
    rule: authenticated,
    frozen: {
      summary: 'List user secrets',
      tags: ['Secrets'],
      operationId: 'listSecrets',
      responses: {
        '200': {
          description: 'List of secrets (values are not returned)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  secrets: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Secret' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'secrets.create_secret', method: 'POST', path: '/api/secrets', handler: 'handleCreateSecret', effect: 'write',
    unauthorized401: "`error` 'Missing or invalid Authorization header' / 'Invalid or expired token' (validateAuth).",
    nonJson400: true,
    rule: authenticated,
    secrets: { input: ['/secret_value'] },
    frozen: {
      summary: 'Create new secret',
      tags: ['Secrets'],
      operationId: 'createSecret',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SecretCreate' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Secret created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Secret' },
            },
          },
        },
      },
    },
  },
  {
    id: 'secrets.update_secret', method: 'PUT', path: '/api/secrets/:id', handler: 'handleUpdateSecret', effect: 'write',
    unauthorized401: "`error` 'Missing or invalid Authorization header' / 'Invalid or expired token' (validateAuth).",
    nonJson400: true,
    rule: authenticated,
    secrets: { input: ['/secret_value'] },
    frozen: {
      summary: 'Update secret',
      tags: ['Secrets'],
      operationId: 'updateSecret',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SecretUpdate' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Secret updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Secret' },
            },
          },
        },
      },
    },
  },
  {
    id: 'secrets.delete_secret', method: 'DELETE', path: '/api/secrets/:id', handler: 'handleDeleteSecret', effect: 'destructive',
    unauthorized401: "`error` 'Missing or invalid Authorization header' / 'Invalid or expired token' (validateAuth).",
    rule: authenticated,
    frozen: {
      summary: 'Delete secret',
      tags: ['Secrets'],
      operationId: 'deleteSecret',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '204': { description: 'Secret deleted' },
      },
    },
  },
  {
    area: 'github_app', id: 'github_app.create_install_url', method: 'POST', path: '/api/github-app/install-url', handler: 'handleCreateGithubAppInstallUrl', effect: 'write',
    rule: workspaceAdmin,
    tenancy: 'tenant',
    source: { module: 'src/routes/github-app.ts', load: () => import('../../routes/github-app') },
    frozen: {
      summary: 'Mint a GitHub App install URL carrying a signed, single-use state for (caller, active tenant)',
      tags: ['GitHub App'],
      operationId: 'createGithubAppInstallUrl',
      responses: {
        '200': {
          description: 'Install URL (state TTL 600 s)',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } },
            },
          },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: '`workspace_admin_required`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '503': { description: '`github_app_not_configured` — client id/secret/state key unset', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'github_app', id: 'github_app.confirm_claim', method: 'POST', path: '/api/github-app/claims/:handle/confirm', handler: 'handleConfirmGithubAppClaim', effect: 'write',
    rule: workspaceAdmin,
    tenancy: 'tenant',
    source: { module: 'src/routes/github-app.ts', load: () => import('../../routes/github-app') },
    frozen: {
      summary: 'Bind a pending GitHub App claim (parked by the install callback) to the active tenant — only for the user + tenant that started the install',
      tags: ['GitHub App'],
      operationId: 'confirmGithubAppClaim',
      parameters: [{ name: 'handle', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }],
      responses: {
        '200': {
          description: 'The binding',
          content: { 'application/json': { schema: { type: 'object', properties: { data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                installation_id: { type: 'integer', format: 'int64' },
                account_login: { type: 'string' },
                account_type: { type: 'string' },
                github_user_login: { type: 'string', nullable: true },
                installed_by_user_id: { type: 'string', format: 'uuid' },
                created_at: { type: 'string', format: 'date-time' },
                last_verified_at: { type: 'string', format: 'date-time' },
                revoked_at: { type: 'string', format: 'date-time', nullable: true },
                revoked: { type: 'boolean' },
              },
            } } } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: '`workspace_admin_required`, or `claim_not_yours` (claim consumed)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: '`claim_not_found` — unknown, expired or already used', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '409': { description: '`bound_to_other_tenant`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'github_app', id: 'github_app.list_installations', method: 'GET', path: '/api/github-app/installations', handler: 'handleListGithubAppInstallations', effect: 'read',
    rule: resolvedTenant,
    tenancy: 'tenant',
    source: { module: 'src/routes/github-app.ts', load: () => import('../../routes/github-app') },
    frozen: {
      summary: "List the active tenant's GitHub App installations",
      tags: ['GitHub App'],
      operationId: 'listGithubAppInstallations',
      parameters: [
        { name: 'include_revoked', in: 'query', required: false, schema: { type: 'boolean' } },
      ],
      responses: {
        '200': {
          description: 'Installations (active only unless include_revoked=true)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                installation_id: { type: 'integer', format: 'int64' },
                account_login: { type: 'string' },
                account_type: { type: 'string' },
                github_user_login: { type: 'string', nullable: true },
                installed_by_user_id: { type: 'string', format: 'uuid' },
                created_at: { type: 'string', format: 'date-time' },
                last_verified_at: { type: 'string', format: 'date-time' },
                revoked_at: { type: 'string', format: 'date-time', nullable: true },
                revoked: { type: 'boolean' },
              },
            } },
                },
              },
            },
          },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'github_app', id: 'github_app.revoke_installation', method: 'DELETE', path: '/api/github-app/installations/:id', handler: 'handleRevokeGithubAppInstallation', effect: 'destructive',
    rule: workspaceAdmin,
    tenancy: 'tenant',
    source: { module: 'src/routes/github-app.ts', load: () => import('../../routes/github-app') },
    frozen: {
      summary: 'Unbind (revoke) a GitHub App installation from the active tenant',
      tags: ['GitHub App'],
      operationId: 'revokeGithubAppInstallation',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        '200': {
          description: 'The revoked binding',
          content: { 'application/json': { schema: { type: 'object', properties: { data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                installation_id: { type: 'integer', format: 'int64' },
                account_login: { type: 'string' },
                account_type: { type: 'string' },
                github_user_login: { type: 'string', nullable: true },
                installed_by_user_id: { type: 'string', format: 'uuid' },
                created_at: { type: 'string', format: 'date-time' },
                last_verified_at: { type: 'string', format: 'date-time' },
                revoked_at: { type: 'string', format: 'date-time', nullable: true },
                revoked: { type: 'boolean' },
              },
            } } } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'workspace-admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'No active binding with this id in the active tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'billing', id: 'billing.get_tenant_usage_breakdown', method: 'GET', path: '/api/tenant/usage/breakdown', handler: 'handleGetTenantUsageBreakdown', effect: 'read',
    rule: workspaceAdmin,
    tenancy: 'tenant',
    source: { module: 'src/routes/tenant/usage-breakdown.ts', load: () => import('../../routes/tenant/usage-breakdown') },
    frozen: {
      summary: 'Workspace usage by project × member × funding',
      description:
        'Proxies billing `GET /api/usage/breakdown` pinned to the ACTIVE tenant (never a param). ' +
        'Authz: workspace-admin of the active tenant, or super-admin — per-member spend is admin ' +
        'data; anyone else gets 403 and reads `/api/me/usage/funding`. Cost: super-admin incurred, ' +
        'everyone else billed (markup); withheld (null, `cost_basis: unavailable`) when the markup ' +
        'is unknown. `tenant_byo` is never marked up. null project/actor/app dims are the ' +
        'unattributed bucket.',
      tags: ['Billing'],
      operationId: 'getTenantUsageBreakdown',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'group_by', in: 'query', description: 'CSV of project,actor,funding,app,provider,model,day (default project,actor,funding)', schema: { type: 'string' } },
        { name: 'project_id', in: 'query', description: 'CSV of uuids or none', schema: { type: 'string' } },
        { name: 'actor_id', in: 'query', description: 'CSV of uuids or none', schema: { type: 'string' } },
        { name: 'funding', in: 'query', description: 'CSV of local_gpu,platform_external,tenant_byo,unknown', schema: { type: 'string' } },
        { name: 'app', in: 'query', schema: { type: 'string' } },
        { name: 'provider', in: 'query', schema: { type: 'string' } },
        { name: 'model', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The breakdown',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/UsageFundingBreakdown' } } } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Not a workspace-admin of the active tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: 'Bad date range or group_by', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'billing', id: 'billing.get_my_usage_funding', method: 'GET', path: '/api/me/usage/funding', handler: 'handleGetMyUsageFunding', effect: 'read',
    rule: resolvedTenant,
    tenancy: 'self',
    source: { module: 'src/routes/tenant/usage-breakdown.ts', load: () => import('../../routes/tenant/usage-breakdown') },
    frozen: {
      summary: 'My usage by project × funding',
      description:
        'Proxies billing `GET /api/usage/breakdown/me` with the caller\'s verified sub as ' +
        '`X-Actor-Id` in the active tenant: a user only ever sees their own usage. Same params as ' +
        '`/api/tenant/usage/breakdown` minus `actor_id` (default group_by project,funding). Same ' +
        'cost lens.',
      tags: ['Billing'],
      operationId: 'getMyUsageFunding',
      security: [{ bearerAuth: [] }],
      // fr-agui P4d-1 (P4-carry): the query the handler reads (routes/tenant/usage-breakdown.ts ME_DIMS / ME_FILTERS).
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'group_by', in: 'query', description: 'CSV of project,funding,app,provider,model,day (default project,funding)', schema: { type: 'string' } },
        { name: 'project_id', in: 'query', description: 'CSV of uuids or none', schema: { type: 'string' } },
        { name: 'funding', in: 'query', description: 'CSV of local_gpu,platform_external,tenant_byo,unknown', schema: { type: 'string' } },
        { name: 'app', in: 'query', schema: { type: 'string' } },
        { name: 'provider', in: 'query', schema: { type: 'string' } },
        { name: 'model', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The caller\'s breakdown',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/UsageFundingBreakdown' } } } } },
        },
        '400': { description: 'Caller has no uuid sub', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: 'Bad date range or group_by', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
];

export const ACCOUNT_FROZEN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities(
  { area: 'secrets', tenancy: 'self', module: 'src/routes/secrets.ts', load: () => import('../../routes/secrets') },
  ACCOUNT_ROUTES,
);
