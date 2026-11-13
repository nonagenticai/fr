/**
 * Service Authenticator for OAuth2 Client Credentials Flow
 * Supports Keycloak and standard OAuth2 providers
 */

export interface ServiceAuthConfig {
  keycloakUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /**
   * Token refresh buffer in seconds (default: 60)
   * Refresh token this many seconds before expiry
   */
  refreshBuffer?: number;
  /**
   * Custom token endpoint (overrides Keycloak default)
   */
  tokenEndpoint?: string;
  /**
   * Token-request timeout in ms (default: 10000). Without one, a Keycloak that
   * HANGS (rather than refusing) stalls every caller waiting on this token —
   * including the agent-session refresh, whose user-status check needs an
   * admin token.
   */
  timeoutMs?: number;
}

const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in?: number;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ServiceAuthenticator {
  private config: Required<Omit<ServiceAuthConfig, 'tokenEndpoint'>> & Pick<ServiceAuthConfig, 'tokenEndpoint'>;
  private cachedToken: CachedToken | null = null;
  private tokenFetchPromise: Promise<string> | null = null;

  constructor(config: ServiceAuthConfig) {
    this.config = {
      ...config,
      refreshBuffer: config.refreshBuffer ?? 60,
      timeoutMs: config.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS,
    };

    // Validate configuration
    if (!this.config.keycloakUrl) {
      throw new Error('keycloakUrl is required');
    }
    if (!this.config.realm) {
      throw new Error('realm is required');
    }
    if (!this.config.clientId) {
      throw new Error('clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('clientSecret is required');
    }
  }

  /**
   * Get the token endpoint URL
   */
  private getTokenEndpoint(): string {
    if (this.config.tokenEndpoint) {
      return this.config.tokenEndpoint;
    }

    const baseUrl = this.config.keycloakUrl.replace(/\/$/, '');
    return `${baseUrl}/realms/${this.config.realm}/protocol/openid-connect/token`;
  }

  /**
   * Check if current token is valid and not expiring soon
   */
  private isTokenValid(): boolean {
    if (!this.cachedToken) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresWithBuffer = this.cachedToken.expiresAt - this.config.refreshBuffer;

    return now < expiresWithBuffer;
  }

  /**
   * Fetch a new access token from the OAuth2 provider
   */
  private async fetchNewToken(): Promise<CachedToken> {
    const tokenEndpoint = this.getTokenEndpoint();

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new AuthenticationError(
        `Failed to connect to token endpoint: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }

      throw new AuthenticationError(
        `Token request failed: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    let tokenResponse: TokenResponse;
    try {
      tokenResponse = await response.json() as TokenResponse;
    } catch (error) {
      throw new AuthenticationError(
        `Invalid JSON response from token endpoint: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!tokenResponse.access_token) {
      throw new AuthenticationError(
        'Token response missing access_token field',
        undefined,
        tokenResponse
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = tokenResponse.expires_in || 3600; // Default to 1 hour if not provided

    return {
      accessToken: tokenResponse.access_token,
      expiresAt: now + expiresIn,
      tokenType: tokenResponse.token_type || 'Bearer',
    };
  }

  /**
   * Get a valid access token, using cache or fetching new one
   * Handles concurrent requests with promise deduplication
   */
  async getAccessToken(): Promise<string> {
    // If token is valid, return immediately
    if (this.isTokenValid() && this.cachedToken) {
      return this.cachedToken.accessToken;
    }

    // If already fetching, wait for that promise
    if (this.tokenFetchPromise) {
      return this.tokenFetchPromise;
    }

    // Start new fetch
    this.tokenFetchPromise = (async () => {
      try {
        this.cachedToken = await this.fetchNewToken();
        return this.cachedToken.accessToken;
      } finally {
        this.tokenFetchPromise = null;
      }
    })();

    return this.tokenFetchPromise;
  }

  /**
   * Get authorization header object
   * @returns Object with Authorization header
   */
  async getAuthHeader(): Promise<{ Authorization: string }> {
    const token = await this.getAccessToken();
    const tokenType = this.cachedToken?.tokenType || 'Bearer';

    return {
      Authorization: `${tokenType} ${token}`,
    };
  }

  /**
   * Perform authenticated fetch request
   * Automatically adds authorization header
   *
   * @param url - Request URL
   * @param options - Fetch options (headers will be merged)
   * @returns Fetch Response
   */
  async authenticatedFetch(
    url: string,
    options?: RequestInit
  ): Promise<Response> {
    const authHeader = await this.getAuthHeader();

    const mergedOptions: RequestInit = {
      ...options,
      headers: {
        ...options?.headers,
        ...authHeader,
      },
    };

    return fetch(url, mergedOptions);
  }

  /**
   * Get authenticated axios config
   * Returns headers object that can be spread into axios config
   *
   * @example
   * const headers = await auth.getAxiosConfig();
   * axios.get(url, { headers });
   */
  async getAxiosConfig(): Promise<{ headers: { Authorization: string } }> {
    const authHeader = await this.getAuthHeader();
    return { headers: authHeader };
  }

  /**
   * Clear the cached token to force a refresh (bundle-token-minter does this on a rejected token).
   */
  clearCache(): void {
    this.cachedToken = null;
    this.tokenFetchPromise = null;
  }

  /**
   * Get token info (for debugging)
   * Returns null if no token cached
   */
  getTokenInfo(): { expiresAt: number; expiresIn: number } | null {
    if (!this.cachedToken) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    return {
      expiresAt: this.cachedToken.expiresAt,
      expiresIn: this.cachedToken.expiresAt - now,
    };
  }
}

/**
 * Create a ServiceAuthenticator instance from environment variables
 *
 * Expected env vars:
 * - KEYCLOAK_URL
 * - KEYCLOAK_REALM
 * - KEYCLOAK_CLIENT_ID
 * - KEYCLOAK_CLIENT_SECRET
 */
export function createAuthenticatorFromEnv(): ServiceAuthenticator {
  const keycloakUrl = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

  if (!keycloakUrl || !realm || !clientId || !clientSecret) {
    throw new Error(
      'Missing required environment variables: KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET'
    );
  }

  return new ServiceAuthenticator({
    keycloakUrl,
    realm,
    clientId,
    clientSecret,
  });
}
