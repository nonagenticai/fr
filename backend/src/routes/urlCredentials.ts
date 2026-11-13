// src/routes/urlCredentials.ts
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { jsonResponse, createdResponse, noContentResponse } from '../utils/response';
import { URLCredentialCreateSchema } from '../types/urlCredentials';
import { urlCredentialsApiClient } from '../services/urlCredentialsApiClient';
import {
  isIntegrationError,
  integrationErrorResponse,
} from '../integrations/_lib/errors';

/**
 * Map a failure from the secrets upstream to an honest status.
 *
 * Previously EVERY caught error in this file became a `BadRequestError` (400).
 * That is a misdiagnosis with real consequences: when secrets-service is down,
 * unreachable, or `SECRETS_API_URL` is unset, the client was told IT sent a bad
 * request — so it will never retry — and the failure was counted as a 4xx, so
 * it never showed up as an outage. `integrationErrorResponse` applies the
 * repo's canonical mapping instead (502 unreachable / 504 timeout / 404
 * passthrough / real upstream 4xx passthrough).
 *
 * Returns a Response for an upstream failure, or null when the error is not an
 * upstream failure and the caller should keep its own handling.
 */
function upstreamFailureResponse(error: unknown): Response | null {
  return isIntegrationError(error) ? integrationErrorResponse(error) : null;
}

/**
 * URL Credentials Routes
 *
 * Proxy to the external Secrets API for URL credential management. Separate
 * from the local user secrets stored in FR's database.
 *
 * **Tenant transport:** each handler derives the tenant identity from
 * `user.tenantId` (set by `validateAuth` from Keycloak claims via
 * `deriveTenantId`) and passes it to urlCredentialsApiClient, which sends it as
 * `X-Tenant-Id` on every outbound call. Credentials are stored/owned under
 * the user's tenant, not under any service account.
 *
 * **DB ownership marker:** the `user_id` field in request bodies and the
 * `credential.user_id !== user.id` ownership checks stay bound to
 * `user.id` (the Keycloak `sub`). That's the local DB ownership marker —
 * semantically distinct from tenantId.
 */

// GET /api/url-credentials - List user's URL credentials
export async function handleListUrlCredentials(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  try {
    const credentials = await urlCredentialsApiClient.listUrlCredentialsByUser(user.id, ctxTenantId(user.tenantId));

    return jsonResponse({
      items: credentials.credentials,
      total: credentials.total,
    });
  } catch (error) {
    const upstream = upstreamFailureResponse(error);
    if (upstream) return upstream;
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Failed to list credentials'
    );
  }
}

// POST /api/url-credentials - Create new URL credential
export async function handleCreateUrlCredential(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const body = await req.json();
  const validated = URLCredentialCreateSchema.parse(body);

  try {
    const credential = await urlCredentialsApiClient.storeUrlCredential(
      {
        user_id: user.id,
        identifier: validated.identifier,
        url: validated.url,
        credentials: validated.credentials as Record<string, unknown>,
        metadata: {
          ...validated.metadata,
          auth_type: validated.credentials.auth_type,
        },
        ttl: validated.ttl,
      },
      ctxTenantId(user.tenantId),
    );

    return createdResponse({
      ...credential,
      message: 'URL credential created successfully',
    });
  } catch (error) {
    const upstream = upstreamFailureResponse(error);
    if (upstream) return upstream;
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Failed to create credential'
    );
  }
}

// GET /api/url-credentials/:id - Get URL credential details
export async function handleGetUrlCredential(req: Request, credentialId: string): Promise<Response> {
  const user = await validateAuth(req);

  try {
    const credential = await urlCredentialsApiClient.retrieveUrlCredential(credentialId, ctxTenantId(user.tenantId));

    // Verify ownership (user_id is the local DB ownership marker, distinct from tenantId).
    if (credential.user_id !== user.id) {
      throw new NotFoundError('Credential not found');
    }

    return jsonResponse(credential);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw error;
    }
    const upstream = upstreamFailureResponse(error);
    if (upstream) return upstream;
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Failed to retrieve credential'
    );
  }
}

// PUT /api/url-credentials/:id - Update URL credential
export async function handleUpdateUrlCredential(req: Request, credentialId: string): Promise<Response> {
  const user = await validateAuth(req);

  const body = await req.json();
  const validated = URLCredentialCreateSchema.parse(body);

  try {
    // First verify ownership by retrieving (user_id is local DB owner, tenantId is transport).
    const existing = await urlCredentialsApiClient.retrieveUrlCredential(credentialId, ctxTenantId(user.tenantId));
    if (existing.user_id !== user.id) {
      throw new NotFoundError('Credential not found');
    }

    const updated = await urlCredentialsApiClient.updateUrlCredential(
      credentialId,
      {
        user_id: user.id,
        identifier: validated.identifier,
        url: validated.url,
        credentials: validated.credentials as Record<string, unknown>,
        metadata: {
          ...validated.metadata,
          auth_type: validated.credentials.auth_type,
        },
        ttl: validated.ttl,
      },
      ctxTenantId(user.tenantId),
    );

    return jsonResponse({
      ...updated,
      message: 'URL credential updated successfully',
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw error;
    }
    const upstream = upstreamFailureResponse(error);
    if (upstream) return upstream;
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Failed to update credential'
    );
  }
}

// DELETE /api/url-credentials/:id - Delete URL credential
export async function handleDeleteUrlCredential(req: Request, credentialId: string): Promise<Response> {
  const user = await validateAuth(req);

  try {
    // First verify ownership (user_id is local DB owner, tenantId is transport).
    const existing = await urlCredentialsApiClient.retrieveUrlCredential(credentialId, ctxTenantId(user.tenantId));
    if (existing.user_id !== user.id) {
      throw new NotFoundError('Credential not found');
    }

    await urlCredentialsApiClient.deleteUrlCredential(credentialId, ctxTenantId(user.tenantId));

    return noContentResponse();
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw error;
    }
    const upstream = upstreamFailureResponse(error);
    if (upstream) return upstream;
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Failed to delete credential'
    );
  }
}
