// fr-agui SPEC §13 P4b — spec drain: the secret stores re-expressed with NO
// behaviour change (`legacyHandler`):
//
//   * `/api/assets/secrets` (routes/assets/secrets.ts) — the tenant's generic
//     secrets in secrets-service (list / get / create; no delete is proxied);
//   * `GET /api/me/secrets` (routes/secrets.ts handleListSecrets) — the caller's
//     own fr `user_secrets` rows, METADATA ONLY (the select names no value column).
//
// Gate (all four): validateAuth (its licence / conveyor doors) and nothing else —
// the secrets client sends the request-context tenant as X-Tenant-Id when there
// is one and does not require it; `/api/me/secrets` is keyed by the caller's id.
//
// 🔐 SECRETS. `GET /api/assets/secrets/:secretId` RETURNS the decrypted `secrets`
// and `env_vars` of the secret (secrets-service retrieve, relayed in `{ data }`):
// declared in `secrets.output`, because the handler does not redact them. The
// create body's `secrets` / `env_vars` are secret INPUTS. The list answers and
// `/api/me/secrets` carry no value.
import { z } from 'zod';

import type { ResponseSpec } from '../define';
import { isAuthenticatedUser } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody, type SettingsRoute } from './_shared';

const listItem = z.object({
  secret_id: z.string(),
  user_id: z.string(),
  identifier: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

const PROXY_RESPONSES: ResponseSpec[] = [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      "400: `error.code` 'BAD_REQUEST' (create: the body is not JSON; nothing sent). " +
      DOOR_403 +
      " Any other status is secrets-service's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx " +
      "or no answer is 502, a timeout 504), or fr's own 500.",
    schema: frErrorBody,
  },
];

const ASSET_ROUTES: SettingsRoute[] = [
  {
    id: 'secrets.list_assets', method: 'GET', path: '/api/assets/secrets', handler: 'handleListSecretAssets',
    summary: "The request tenant's secrets in secrets-service (metadata only)", effect: 'read',
    input: z.object({}), output: z.object({ data: z.object({ secrets: z.array(listItem), total: z.number() }).passthrough() }),
    responses: PROXY_RESPONSES,
  },
  {
    id: 'secrets.get_asset', method: 'GET', path: '/api/assets/secrets/:secretId', handler: 'handleGetSecretAsset',
    summary: 'One secret of the request tenant, WITH its decrypted values', effect: 'read',
    description: '🔐 The answer carries the decrypted `secrets` and `env_vars` (secrets.output): never hand it to an agent.',
    input: z.object({ secretId: pathId('Secret id (secrets-service)') }),
    output: z.object({
      data: listItem
        .extend({
          secrets: z.record(z.unknown()).describe('🔐 SECRET: the decrypted secret values.'),
          env_vars: z.record(z.unknown()).describe('🔐 SECRET: the decrypted environment variables.'),
        })
        .passthrough(),
    }),
    responses: PROXY_RESPONSES,
    secrets: { output: ['/data/secrets', '/data/env_vars'] },
  },
  {
    id: 'secrets.create_asset', method: 'POST', path: '/api/assets/secrets', handler: 'handleCreateSecretAsset',
    summary: 'Store a secret for the request tenant in secrets-service', effect: 'write', successStatus: 201,
    description:
      'fr forwards the body VERBATIM to secrets-service (`SecretData`, secrets/main.py): fr checks only that it is JSON ' +
      'and enforces none of the fields below. They are the END-TO-END contract: a body that does not match them is ' +
      "relayed to secrets-service and answered 422 there. `identifier` is required; `secrets` / `env_vars` map string " +
      'keys to string values (each value at most 10000 characters); `ttl` is seconds (60–604800, default 3600), or null.',
    input: z
      .object({
        identifier: z.string().max(255).describe('A user-friendly identifier, unique per user (secrets-service requires it).'),
        secrets: z
          .record(z.string().max(10000))
          .optional()
          .describe('🔐 SECRET values: string keys to string values (secrets-service defaults it to {}).'),
        env_vars: z
          .record(z.string().max(10000))
          .optional()
          .describe('🔐 SECRET environment variables: string keys to string values (secrets-service defaults it to {}).'),
        metadata: z.record(z.unknown()).nullable().optional().describe('Additional metadata (any JSON object), or null.'),
        ttl: z
          .number()
          .int()
          .min(60)
          .max(604800)
          .nullable()
          .optional()
          .describe('Time-to-live in seconds (60–604800; secrets-service defaults it to 3600), or null.'),
      })
      .passthrough(),
    output: z.object({
      data: z
        .object({ secret_id: z.string(), user_id: z.string(), identifier: z.string(), created_at: z.string(), expires_at: z.string().nullable().optional() })
        .passthrough(),
    }),
    responses: PROXY_RESPONSES,
    secrets: { input: ['/secrets', '/env_vars'] },
  },
];

export const SECRET_ASSET_CAPABILITIES = settingsCapabilities(
  {
    area: 'secrets', tag: 'Secrets', tenancy: 'tenant',
    module: 'src/routes/assets/secrets.ts', load: () => import('../../routes/assets/secrets'),
    rule: routeRule(isAuthenticatedUser),
  },
  ASSET_ROUTES,
);

const MY_SECRET = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  secret_type: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_used: z.string().nullable(),
  is_valid: z.boolean().nullable(),
});

export const MY_SECRET_CAPABILITIES = settingsCapabilities(
  {
    area: 'secrets', tag: 'Secrets', tenancy: 'self',
    module: 'src/routes/secrets.ts', load: () => import('../../routes/secrets'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'secrets.list_mine', method: 'GET', path: '/api/me/secrets', handler: 'handleListSecrets',
      summary: "The caller's own fr secrets (metadata only; no value is selected)", effect: 'read',
      input: z.object({}), output: z.object({ items: z.array(MY_SECRET), total: z.number() }),
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        { status: 'default', description: `${DOOR_403} 500: fr's own (\`error\`), e.g. the database is unreachable.`, schema: frErrorBody },
      ],
    },
  ],
);
