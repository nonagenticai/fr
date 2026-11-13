// src/services/urlCredentialsApiClient.ts
/**
 * HTTP client for the URL-credentials endpoints of secrets-service.
 * Distinct from ../integrations/secrets.ts (which wraps the generic tenant secrets
 * CRUD via the Orval-generated @fr/service-client-secrets). Both hit the same
 * upstream service but different resource trees.
 */
import { config } from '../config';
import { IntegrationError } from '../integrations/_lib/errors';
import { secretsTenantFetch } from '../integrations/secrets';

/**
 * URL Credentials API Client
 *
 * Talks to the external Secrets API for URL credential management. Separate
 * from the local user secrets stored in FR's database.
 *
 * **Auth transport:** `X-Tenant-Id: <tenantId>` on every request, plus
 * `Authorization: Bearer <the tenant's own minted secrets licence>` when one can
 * be had (George 2026-10-16; see `secretsTenantFetch` in
 * integrations/secrets.ts — no bundle / mint failure ⇒ bare `X-Tenant-Id` as
 * before). The tenantId must be provided by the route layer.
 */

export interface URLCredentialData {
  user_id: string;
  identifier: string;
  url: string;
  credentials: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ttl?: number;
}

export interface URLCredentialResponse {
  credential_id: string;
  user_id: string;
  identifier: string;
  created_at: string;
  expires_at?: string;
}

export interface URLCredentialRetrieveResponse {
  credential_id: string;
  user_id: string;
  identifier: string;
  url: string;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface URLCredentialListItem {
  credential_id: string;
  user_id: string;
  identifier: string;
  url: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface URLCredentialListResponse {
  credentials: URLCredentialListItem[];
  total: number;
}

class UrlCredentialsApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.services.secrets.baseUrl;
  }

  private async request<T>(
    path: string,
    options: RequestInit,
    tenantId: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';

    // Every failure below is an UPSTREAM failure, so it is raised as an
    // IntegrationError and mapped by `integrationErrorResponse` (502 for a
    // transport/config fault, passthrough for a real upstream 4xx). It must
    // NOT become a 400: the caller sent a well-formed request, and a 400 tells
    // both the client and our own dashboards that the CLIENT was at fault when
    // in fact secrets-service is down or `SECRETS_API_URL` is unset (it
    // defaults to '' — see config.ts — which makes fetch() reject the URL
    // outright).
    let response: Response;
    try {
      response = await secretsTenantFetch(
        url,
        {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
            ...options.headers,
          },
        },
        tenantId,
      );
    } catch (cause) {
      throw new IntegrationError({
        code: 'UPSTREAM_UNREACHABLE',
        message: `secrets-service unreachable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        service: 'secrets',
        path,
        method,
        cause,
      });
    }

    if (!response.ok) {
      const error = await response.text();
      // Message text is preserved verbatim from the previous bare `Error` so
      // callers/tests matching on it keep working; only the TYPE and the
      // resulting HTTP status change.
      throw new IntegrationError({
        code:
          response.status === 404 ? 'UPSTREAM_NOT_FOUND' : 'UPSTREAM_BAD_STATUS',
        message: `Secrets API error (${response.status}): ${error}`,
        service: 'secrets',
        path,
        method,
        upstreamStatus: response.status,
        upstreamBody: error,
      });
    }
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }

  async storeUrlCredential(
    data: URLCredentialData,
    tenantId: string,
  ): Promise<URLCredentialResponse> {
    return this.request<URLCredentialResponse>(
      '/url-credentials',
      { method: 'POST', body: JSON.stringify(data) },
      tenantId,
    );
  }

  async retrieveUrlCredential(
    credentialId: string,
    tenantId: string,
  ): Promise<URLCredentialRetrieveResponse> {
    return this.request<URLCredentialRetrieveResponse>(
      `/url-credentials/${credentialId}`,
      { method: 'GET' },
      tenantId,
    );
  }

  async updateUrlCredential(
    credentialId: string,
    data: URLCredentialData,
    tenantId: string,
  ): Promise<URLCredentialResponse> {
    return this.request<URLCredentialResponse>(
      `/url-credentials/${credentialId}`,
      { method: 'PUT', body: JSON.stringify(data) },
      tenantId,
    );
  }

  async deleteUrlCredential(
    credentialId: string,
    tenantId: string,
  ): Promise<void> {
    await this.request<void>(
      `/url-credentials/${credentialId}`,
      { method: 'DELETE' },
      tenantId,
    );
  }

  async listUrlCredentialsByUser(
    _userId: string,
    tenantId: string,
  ): Promise<URLCredentialListResponse> {
    // The secrets API scopes "list mine" off the X-Tenant-Id header. The
    // legacy `/url-credentials/user/:id` path doesn't exist on the upstream
    // (404). Caller's userId is kept in the signature for backward
    // compatibility but is unused — the tenant header is authoritative.
    return this.request<URLCredentialListResponse>(
      '/url-credentials/me',
      { method: 'GET' },
      tenantId,
    );
  }
}

export const urlCredentialsApiClient = new UrlCredentialsApiClient();
