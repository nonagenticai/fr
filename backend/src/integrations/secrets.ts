/**
 * Orval-generated client wrapper for generic tenant secrets CRUD.
 * Distinct from ../services/urlCredentialsApiClient.ts (which manages URL credentials).
 */
import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { getBundleTokenMinter } from '../lib/bundle-token-minter';
import {
  getCreateSecretUrl,
  getGetSecretUrl,
  getListMySecretsUrl,
  type SecretData,
  type SecretListResponse,
  type SecretResponse,
  type SecretRetrieveResponse,
} from '@fr/service-client-secrets';

// Secrets upstream is a synchronous CRUD service; keep the same 30s budget
// we use for requirements/etc.
const CRUD_TIMEOUT_MS = 30_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'secrets',
      baseUrl: config.services.secrets.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // NEVER the end user's Keycloak JWT: secrets introspects `Authorization`
      // as a LICENCE (auth/middleware.py `_extract_license_token`), so a JWT
      // there is a hard 401. The only thing fr puts in `Authorization` is the
      // tenant's own `secrets` licence (`tenantCredentialProvider` below).
      sendAuthorization: false,
      // THE TENANT'S OWN `secrets` LICENCE (George 2026-10-16), minted per
      // tenant exactly like the `workers` one (integrations/workers.ts). Sent
      // as `Authorization: Bearer <tenant secrets token>` beside the plain
      // `X-Tenant-Id: <tenant>`; secrets introspects it and refuses (403) a
      // plain tenant header that is not the licence's own tenant.
      //
      // FALLBACK: a tenant whose bundle lacks `secrets` (404 until licenses
      // migration 065 is live), an unconfigured minter, or any mint failure
      // yields no token and the request goes out as before: bare
      // `X-Tenant-Id`, the trusted-network branch. An auth-layer 401
      // (`WWW-Authenticate: Bearer`) invalidates and re-mints once.
      tenantCredentialProvider: getBundleTokenMinter('secrets'),
    });
  }
  return cachedClient;
}

// Scope note: list / get / create only.
//
// The generated surface also exposes deleteSecret, updateSecret, cleanupSecrets,
// and parallel BYOC / URL-credential verbs. We intentionally DO NOT proxy any
// delete verb here (Phase 3 plan — secret deletion is too destructive without
// a dedicated workflow), and we hold off on update/rotate until the frontend
// actually needs them. BYOC configs and URL credentials already have their own
// adapters / routes (see services/urlCredentialsApiClient.ts and routes/urlCredentials.ts);
// this adapter deliberately covers only the bare `/secrets` collection.

/**
 * Raw `fetch` to secrets-service for a NAMED tenant, carrying that tenant's
 * own minted `secrets` licence — for the call sites that do not go through
 * `http()` (they keep their own error shapes). Same contract as the
 * `tenantCredentialProvider` path of `HttpClient`:
 *
 *  * `Authorization: Bearer <tenant secrets token>` + plain `X-Tenant-Id`;
 *  * no token (no bundle / 404, unconfigured minter, mint error) ⇒ the bare
 *    `X-Tenant-Id` request, byte-identical to before;
 *  * an AUTH-LAYER 401 (`WWW-Authenticate: Bearer`) to a minted token
 *    invalidates it and replays ONCE with whatever the minter answers now (a
 *    re-mint, or nothing ⇒ bare tenant). Safe on any method: a 401 landed no
 *    side effect. A handler 401 is returned as is.
 *
 * Never logs a token.
 */
export async function secretsTenantFetch(
  url: string,
  init: RequestInit,
  tenantId: string,
): Promise<Response> {
  const tenant = tenantId.trim();
  const minter = getBundleTokenMinter('secrets');
  const mint = async (): Promise<string | undefined> => {
    if (!minter || !tenant) return undefined;
    try {
      return await minter.token(tenant);
    } catch {
      return undefined;
    }
  };
  const send = (token: string | undefined): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    if (!headers.has('x-tenant-id')) headers.set('x-tenant-id', tenantId);
    if (token) headers.set('authorization', `Bearer ${token}`);
    else headers.delete('authorization');
    return fetch(url, { ...init, headers });
  };
  const token = await mint();
  const res = await send(token);
  const challenge = res.headers.get('www-authenticate')?.trim().toLowerCase() ?? '';
  if (res.status !== 401 || challenge !== 'bearer' || token === undefined || !minter) {
    return res;
  }
  minter.invalidate(tenant, token);
  const fresh = await mint();
  if (fresh === token) return res;
  await res.body?.cancel().catch(() => {});
  return await send(fresh);
}

export async function listSecrets(): Promise<SecretListResponse> {
  return await http().json<SecretListResponse>(getListMySecretsUrl(), {
    method: 'GET',
  });
}

export async function getSecret(secretId: string): Promise<SecretRetrieveResponse> {
  return await http().json<SecretRetrieveResponse>(getGetSecretUrl(secretId), {
    method: 'GET',
  });
}

export async function createSecret(body: SecretData): Promise<SecretResponse> {
  return await http().json<SecretResponse>(getCreateSecretUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

