import { asAgentCredentialFailure, mapPlankaError, PlankaAuthError, PlankaNetworkError } from './errors';

export interface PlankaAuthConfig {
  baseUrl: string;
  email: string;
  password: string;
  termsPath: string;
  acceptTermsPath: string;
  defaultLanguage: string;
}

interface AccessTokenResponse {
  item?: string;
  pendingToken?: string;
  step?: string;
}

interface TermsPayload {
  signature: string;
  content?: string;
  language?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * fr's ONE Planka identity: the configured account (PLANKA_AGENT_EMAIL /
 * PLANKA_AGENT_PASSWORD) logged in to PLANKA_BASE_URL. Planka use is per
 * tenant, not per user (George, 2026-10-10): fr users are not Planka users,
 * and fr's own access checks decide who may act.
 */
export class PlankaAuth {
  private agentTokenCache: string | null = null;
  /**
   * The ONE in-flight agent login. Concurrent cold callers share it instead of
   * each POSTing /api/access-tokens (N parallel requests after a restart or a
   * 401-invalidate = N logins, N Planka sessions). Cleared when it settles, and
   * by `invalidateAgent`, so a rejected login is never cached and a login that
   * was invalidated mid-flight cannot repopulate the cache.
   */
  private agentLoginInFlight: Promise<string> | null = null;
  private termsSignatureCache = new Map<string, string>(); // keyed by language

  constructor(private readonly config: PlankaAuthConfig) {}

  async agentToken(): Promise<string> {
    if (this.agentTokenCache) return this.agentTokenCache;
    if (this.agentLoginInFlight) return this.agentLoginInFlight;
    const login: Promise<string> = this.loginAgent().then(
      (token) => {
        if (this.agentLoginInFlight === login) {
          this.agentTokenCache = token;
          this.agentLoginInFlight = null;
        }
        return token;
      },
      (err: unknown) => {
        if (this.agentLoginInFlight === login) this.agentLoginInFlight = null;
        throw err;
      },
    );
    this.agentLoginInFlight = login;
    return login;
  }

  invalidateAgent(): void {
    this.agentTokenCache = null;
    this.agentLoginInFlight = null;
  }

  /** The cached agent token, or null — NEVER logs in (http.ts `cachedTokenOnly`). */
  cachedAgentToken(): string | null {
    return this.agentTokenCache;
  }

  async fetchTermsSignature(language: string = this.config.defaultLanguage): Promise<string> {
    const cached = this.termsSignatureCache.get(language);
    if (cached) return cached;
    const url = `${this.config.baseUrl}${this.config.termsPath}?language=${encodeURIComponent(language)}`;
    const response = await this.get(url);
    if (!response.ok) throw await mapPlankaError(response, this.config.termsPath);
    const data = (await response.json()) as { item?: TermsPayload };
    const signature = data.item?.signature;
    if (!signature) {
      throw new PlankaAuthError('Planka /api/terms returned no signature', {
        status: response.status,
        path: this.config.termsPath,
      });
    }
    this.termsSignatureCache.set(language, signature);
    return signature;
  }

  invalidateTermsSignature(language?: string): void {
    if (language) this.termsSignatureCache.delete(language);
    else this.termsSignatureCache.clear();
  }

  private async loginAgent(): Promise<string> {
    const url = `${this.config.baseUrl}/api/access-tokens`;
    const response = await this.post(url, {
      emailOrUsername: this.config.email,
      password: this.config.password,
    });

    if (response.status === 403) {
      const data = (await response.clone().json().catch(() => ({}))) as AccessTokenResponse;
      if (data.pendingToken && data.step === 'accept-terms') {
        // ⚠️ STILL THE AGENT PATH. `acceptTerms` — and the `fetchTermsSignature`
        // it calls — throw through `mapPlankaError`, which classifies by HTTP
        // status and structurally cannot know whose credential was rejected, so
        // its `PlankaAuthError` defaults to 'user' and would surface an
        // agent-side ToS failure to the browser as `401 you are
        // unauthenticated`. That is the exact bug this file otherwise fixes.
        //
        // An earlier pass skipped these two sites believing they only threw
        // malformed-upstream-body faults. That is true of their trailing "no
        // data.item" throws, NOT of their `!response.ok` branches, which map a
        // real 401 straight through. Stamp here, where the credential source is
        // not in doubt; `asAgentCredentialFailure` passes non-auth errors
        // through untouched.
        try {
          return await this.acceptTerms(data.pendingToken);
        } catch (err) {
          throw asAgentCredentialFailure(err);
        }
      }
    }

    // Everything below this line is the AGENT credential being rejected — this
    // method logs in as fr's own service account and no caller identity is
    // involved. Stamp it, or a wrong/locked PLANKA_AGENT_PASSWORD reaches the
    // browser as `401 you are unauthenticated` for a user who is perfectly
    // authenticated. `mapPlankaError` classifies by status and cannot know
    // this; here it is not in doubt.
    if (!response.ok) throw asAgentCredentialFailure(await mapPlankaError(response, url));
    const data = (await response.json()) as AccessTokenResponse;
    if (!data.item) {
      throw new PlankaAuthError('Planka agent login returned no token', {
        status: response.status,
        path: url,
        credentialSource: 'agent',
      });
    }
    return data.item;
  }

  private async acceptTerms(pendingToken: string): Promise<string> {
    const signature = await this.fetchTermsSignature();
    const url = `${this.config.baseUrl}${this.config.acceptTermsPath}`;
    const response = await this.post(url, {
      pendingToken,
      signature,
      initialLanguage: this.config.defaultLanguage,
    });
    if (!response.ok) {
      // On invalid signature, drop the cached signature so the next attempt refetches
      if (response.status === 403) this.invalidateTermsSignature(this.config.defaultLanguage);
      throw await mapPlankaError(response, url);
    }
    const data = (await response.json()) as AccessTokenResponse;
    if (!data.item) {
      throw new PlankaAuthError('Planka accept-terms returned no token', {
        status: response.status,
        path: url,
      });
    }
    return data.item;
  }

  private async post(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlankaNetworkError(`Network failure reaching Planka: ${String(err)}`, { path: url, cause: err });
    }
  }

  private async get(url: string): Promise<Response> {
    try {
      return await fetch(url, { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new PlankaNetworkError(`Network failure reaching Planka: ${String(err)}`, { path: url, cause: err });
    }
  }
}
