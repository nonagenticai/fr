// fr-agui SPEC §13 P4b — spec drain: `/api/url-credentials` (routes/urlCredentials.ts),
// the caller's own credentials for scraped URLs, stored in secrets-service.
// Re-expressed with NO behaviour change (`legacyHandler`).
//
// Gate: validateAuth (its doors), then `ctxTenantId(user.tenantId)` — the frame
// tenant, else the JWT tenant — which the handler resolves inside its try block:
// with neither, the throw becomes a 400 and nothing is sent upstream. Ownership is
// a row check after that (another user's credential is the same 404 as an absent
// one), not part of the principal rule.
//
// 🔐 SECRETS. `credentials` is a secret INPUT on create / update (a password, a
// bearer token, an API key, cookies or custom headers). `GET /api/url-credentials/:id`
// RETURNS the decrypted `credentials` (secrets-service retrieve, relayed verbatim):
// declared in `secrets.output` and kept in the output schema, because the handler
// does not redact it. The list, create and update answers carry no credential.
import { z } from 'zod';

import { URLCredentialCreateSchema } from '../../types/urlCredentials';
import type { ResponseSpec } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody, type SettingsRoute } from './_shared';

const MODULE = { module: 'src/routes/urlCredentials.ts', load: () => import('../../routes/urlCredentials') };

const id = z.object({ id: pathId('URL credential id (secrets-service); forwarded as given') });

const listItem = z.object({
  credential_id: z.string(),
  user_id: z.string(),
  identifier: z.string(),
  url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

/** secrets-service's store / update answer, relayed with fr's `message` added. */
const stored = z
  .object({
    credential_id: z.string(),
    user_id: z.string(),
    identifier: z.string(),
    created_at: z.string(),
    expires_at: z.string().nullable().optional(),
    message: z.string(),
  })
  .passthrough();

const retrieved = listItem.extend({
  credentials: z.record(z.unknown()).describe('🔐 SECRET: the DECRYPTED credential (secrets.output). Fetch it with the human session only.'),
});

const RESPONSES: ResponseSpec[] = [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      "400: `error` from fr — no tenant resolvable for the caller, or 'invalid JSON body' (create / update: the body is " +
      "not JSON; the server tags the inbound parse error); nothing is sent upstream. 404: `error` 'Credential not " +
      "found' (absent, or another user's). " +
      DOOR_403 +
      " 422: `error` 'Validation error' (create / update: the body fails the credential schema; `details`). Any other " +
      "status is secrets-service's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, unreachable is 502), or " +
      "fr's own 500.",
    schema: frErrorBody,
  },
];

const body = URLCredentialCreateSchema;

const ROUTES: SettingsRoute[] = [
  {
    id: 'url_credentials.list', method: 'GET', path: '/api/url-credentials', handler: 'handleListUrlCredentials',
    summary: "The caller's URL credentials (metadata only, no credential values)", effect: 'read',
    input: z.object({}), output: z.object({ items: z.array(listItem), total: z.number() }), responses: RESPONSES,
  },
  {
    id: 'url_credentials.create', method: 'POST', path: '/api/url-credentials', handler: 'handleCreateUrlCredential',
    summary: 'Store a URL credential for the caller', effect: 'write', successStatus: 201,
    input: body, output: stored, responses: RESPONSES, secrets: { input: ['/credentials'] },
  },
  {
    id: 'url_credentials.get', method: 'GET', path: '/api/url-credentials/:id', handler: 'handleGetUrlCredential',
    summary: "One of the caller's URL credentials, WITH its decrypted credential", effect: 'read',
    description: '🔐 The answer carries the decrypted `credentials` (secrets.output): never hand it to an agent.',
    input: id, output: retrieved, responses: RESPONSES, secrets: { output: ['/credentials'] },
  },
  {
    id: 'url_credentials.update', method: 'PUT', path: '/api/url-credentials/:id', handler: 'handleUpdateUrlCredential',
    summary: "Replace one of the caller's URL credentials", effect: 'write',
    input: body.extend(id.shape), output: stored, responses: RESPONSES, secrets: { input: ['/credentials'] },
  },
  {
    id: 'url_credentials.delete', method: 'DELETE', path: '/api/url-credentials/:id', handler: 'handleDeleteUrlCredential',
    summary: "Delete one of the caller's URL credentials", effect: 'destructive', successStatus: 204,
    input: id, output: z.null(), responses: RESPONSES,
  },
];

export const URL_CREDENTIAL_CAPABILITIES = settingsCapabilities(
  { area: 'url_credentials', tag: 'URL Credentials', tenancy: 'self', ...MODULE, rule: routeRule(isAuthenticatedUserInResolvedTenant) },
  ROUTES,
);
