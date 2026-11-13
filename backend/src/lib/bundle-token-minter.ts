// src/lib/bundle-token-minter.ts
//
// Per-tenant tenant×app licence tokens, minted by licenses' bundle-token route.
//
// WHY (George, 2026-10-15): licences are tenant×app only — there are no
// app-to-app licences. fr must stop calling worker_management with its OWN
// `coding` licence plus `X-Effective-Tenant-Id` delegation, and instead present
// the TENANT's own `workers` licence. That token is minted per tenant:
//
//     POST {LICENSES_SERVICE_URL}/internal/tenants/{t}/bundle-token?app=<app>&ttl_minutes=60
//     Authorization: Bearer <SA JWT of fr-bundle-minter (realm secure-apps)>
//     201 {token, expires_at, tenant_id, bundle, app, license_id, token_id}
//
// The route admits ONLY the `bundle-token-minter` realm role, held by the
// dedicated `fr-bundle-minter` client (BUNDLE_MINTER_CLIENT_ID/SECRET in fr-env),
// never the shared fr-backend client.
//
// Shape copied from worker_management `src/services/ir_bundle_tokens.py`
// `BundleTokenCache`:
//  * in memory only, per (tenant, app), until `expires_at - 5 min`;
//  * single-flight per (tenant, app): N concurrent cold calls ⇒ ONE mint;
//  * fail SOFT: 404 (`no_bundle`, `no_app_licence`), 403, 409, 5xx, transport
//    and SA failures ⇒ `undefined`, negative-cached for NEGATIVE_TTL_MS so a
//    tenant without a bundle cannot turn every upstream call into a licenses
//    call. The caller decides what `undefined` means (workers.ts: transitional
//    delegation fallback);
//  * a 2xx whose `tenant_id` is not the requested tenant is discarded
//    (`tenant_mismatch`, negative-cached, logged once) — never sent;
//  * 409 `ambiguous_bundle` (the tenant holds several bundles that reach `app`
//    with DIFFERENT licences — e.g. `non-agentic-ai` and `conveyor` both list
//    workers and secrets): retried ONCE with `&bundle=<key>`,
//    the key from a FIXED per-app map (`BUNDLE_TOKEN_BUNDLE_BY_APP`, default
//    every fr-minted app → `conveyor`, the bundle fr ensures), and only when
//    licenses lists that key exactly once among `detail.bundles` — never a
//    guess. No match ⇒ the soft `ambiguous_unresolved` refusal, logged with the
//    bundles. Shape of worker_management #365;
//  * `invalidate(tenant)` drops a token the upstream answered 401 to;
//  * NEVER logs a token, the SA JWT or the client secret. One log line per
//    (tenant, app, outcome) so observe-mode work can see who is still delegated.

import { ServiceAuthenticator } from './service-auth';
import { config } from '../config';

/** Re-mint this long before the token's own expiry (WM ruling: expiry - 5 min). */
export const REFRESH_LEAD_MS = 5 * 60_000;
/** How long a refusal / failure is remembered before the next mint attempt. */
export const NEGATIVE_TTL_MS = 60_000;
/** licenses caps bundle tokens at 60 minutes. */
const TTL_MINUTES = 60;
const MINT_TIMEOUT_MS = 5_000;

export const BUNDLE_MINTER_CLIENT_ID_ENV = 'BUNDLE_MINTER_CLIENT_ID';
export const BUNDLE_MINTER_CLIENT_SECRET_ENV = 'BUNDLE_MINTER_CLIENT_SECRET';

/** Stable log tag. Grep / Loki-query this, never the free-text message. */
export const BUNDLE_TOKEN_LOG_TAG = '[bundle-token]';

export type BundleTokenOutcome =
  | 'ok'
  | 'no_bundle'
  | 'not_found'
  | 'conflict'
  | 'ambiguous_unresolved'
  | 'ambiguous_retry'
  | 'forbidden'
  | 'server_error'
  | 'transport_error'
  | 'bad_response'
  | 'tenant_mismatch'
  | 'sa_error';

interface Entry {
  token: string | undefined;
  /** Epoch ms; the entry is used while now < validUntil. */
  validUntil: number;
}

/** Source of the minter's own Keycloak SA JWT. `ServiceAuthenticator` fits. */
export interface MinterAuth {
  getAccessToken(): Promise<string>;
  clearCache(): void;
}

export interface BundleTokenMinterOptions {
  licensesUrl: string;
  app: string;
  auth: MinterAuth;
  /**
   * The ONE bundle key to retry under when licenses answers 409
   * `ambiguous_bundle` (see the header). Absent ⇒ no retry.
   */
  disambiguationBundle?: string;
}

export class BundleTokenMinter {
  private readonly licensesUrl: string;
  private readonly app: string;
  private readonly auth: MinterAuth;
  private readonly disambiguationBundle: string | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  /** `${tenant}|${outcome}` already logged — one line per tenant per outcome. */
  private readonly logged = new Set<string>();

  constructor(opts: BundleTokenMinterOptions) {
    this.licensesUrl = opts.licensesUrl.replace(/\/+$/, '');
    this.app = opts.app;
    this.auth = opts.auth;
    this.disambiguationBundle = opts.disambiguationBundle?.trim() || undefined;
  }

  /** The tenant's token for `app`, or `undefined` when none can be had. */
  async token(tenantId: string): Promise<string | undefined> {
    const tenant = tenantId.trim().toLowerCase();
    if (!tenant) return undefined;
    const entry = this.entries.get(tenant);
    if (entry && Date.now() < entry.validUntil) return entry.token;
    const pending = this.inflight.get(tenant);
    if (pending) return await pending;
    const p = this.mint(tenant).finally(() => this.inflight.delete(tenant));
    this.inflight.set(tenant, p);
    return await p;
  }

  /**
   * Drop the cached token for `tenantId` (the upstream answered 401 to it).
   * With `rejected`, only drops it if it is still the cached one, so a 401 on a
   * stale request cannot evict a token a concurrent caller just re-minted.
   */
  invalidate(tenantId: string, rejected?: string): void {
    const tenant = tenantId.trim().toLowerCase();
    const entry = this.entries.get(tenant);
    if (!entry) return;
    if (rejected !== undefined && entry.token !== rejected) return;
    this.entries.delete(tenant);
  }

  private logOnce(tenant: string, outcome: BundleTokenOutcome, line: string): void {
    const key = `${tenant}|${outcome}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    if (outcome === 'ok') console.info(line);
    else console.warn(line);
  }

  private refuse(
    tenant: string,
    outcome: BundleTokenOutcome,
    status: number | undefined,
    error: string,
  ): undefined {
    this.entries.set(tenant, { token: undefined, validUntil: Date.now() + NEGATIVE_TTL_MS });
    this.logOnce(
      tenant,
      outcome,
      `${BUNDLE_TOKEN_LOG_TAG} app=${this.app} tenant=${tenant} outcome=${outcome} ` +
        `status=${status ?? '-'} error=${error || '-'} -- no tenant ${this.app} token; ` +
        `caller falls back (retry in ${NEGATIVE_TTL_MS / 1000}s)`,
    );
    return undefined;
  }

  private async mint(tenant: string): Promise<string | undefined> {
    let sa: string;
    try {
      sa = await this.auth.getAccessToken();
    } catch (err) {
      return this.refuse(tenant, 'sa_error', undefined, err instanceof Error ? err.name : 'error');
    }
    return await this.attempt(tenant, sa, undefined);
  }

  /** One mint request; `bundle` set only on the single `ambiguous_bundle` retry. */
  private async attempt(tenant: string, sa: string, bundle: string | undefined): Promise<string | undefined> {
    const url =
      `${this.licensesUrl}/internal/tenants/${encodeURIComponent(tenant)}/bundle-token` +
      `?app=${encodeURIComponent(this.app)}&ttl_minutes=${TTL_MINUTES}` +
      (bundle === undefined ? '' : `&bundle=${encodeURIComponent(bundle)}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${sa}`, accept: 'application/json' },
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (err) {
      return this.refuse(
        tenant,
        'transport_error',
        undefined,
        err instanceof Error ? err.name : 'error',
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (res.status !== 201 && res.status !== 200) {
      const detail = (body as { detail?: unknown } | undefined)?.detail;
      const error =
        detail && typeof detail === 'object'
          ? String((detail as { error?: unknown }).error ?? '')
          : '';
      if (res.status === 409 && error === 'ambiguous_bundle' && bundle === undefined) {
        const raw = (detail as { bundles?: unknown }).bundles;
        const bundles = Array.isArray(raw) ? raw.filter((b): b is string => typeof b === 'string') : [];
        const target = this.disambiguationBundle;
        if (target && bundles.filter((b) => b === target).length === 1) {
          this.logOnce(
            tenant,
            'ambiguous_retry',
            `${BUNDLE_TOKEN_LOG_TAG} app=${this.app} tenant=${tenant} outcome=ambiguous_retry ` +
              `bundles=${bundles.join(',')} bundle=${target} -- re-minting once under the configured bundle`,
          );
          return await this.attempt(tenant, sa, target);
        }
        return this.refuse(
          tenant,
          'ambiguous_unresolved',
          res.status,
          `ambiguous_bundle bundles=${bundles.join(',') || '-'} configured=${target ?? '-'}`,
        );
      }
      let outcome: BundleTokenOutcome;
      if (res.status === 404) outcome = error === 'no_bundle' ? 'no_bundle' : 'not_found';
      else if (res.status === 409) outcome = 'conflict';
      else if (res.status === 401 || res.status === 403) {
        outcome = 'forbidden';
        // A 401/403 is OUR SA, not the tenant: drop it so the next try re-mints.
        this.auth.clearCache();
      } else if (res.status >= 500) outcome = 'server_error';
      else outcome = 'bad_response';
      return this.refuse(tenant, outcome, res.status, bundle === undefined ? error : `${error} bundle=${bundle}`);
    }
    const token = (body as { token?: unknown } | undefined)?.token;
    const expiresRaw = (body as { expires_at?: unknown } | undefined)?.expires_at;
    if (typeof token !== 'string' || token.length === 0 || typeof expiresRaw !== 'string') {
      return this.refuse(tenant, 'bad_response', res.status, 'unparseable_body');
    }
    // The token must be FOR the tenant asked about. A token for any other
    // tenant would make WM run this request as that tenant (licence tenant
    // wins), so it is discarded and the caller falls back.
    const mintedTenant = (body as { tenant_id?: unknown }).tenant_id;
    if (typeof mintedTenant !== 'string' || mintedTenant.trim().toLowerCase() !== tenant) {
      return this.refuse(tenant, 'tenant_mismatch', res.status, 'tenant_id_mismatch');
    }
    // licenses returns `expires_at.isoformat()`; a naive value is UTC.
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(expiresRaw) ? expiresRaw : `${expiresRaw}Z`;
    const expiresAt = Date.parse(iso);
    if (Number.isNaN(expiresAt)) {
      return this.refuse(tenant, 'bad_response', res.status, 'unparseable_expires_at');
    }
    const validUntil = expiresAt - REFRESH_LEAD_MS;
    if (validUntil > Date.now()) {
      this.entries.set(tenant, { token, validUntil });
    } else {
      // licenses caps expiry at the licence's own: still valid, not cacheable.
      this.entries.delete(tenant);
    }
    const tokenId = (body as { token_id?: unknown }).token_id;
    this.logOnce(
      tenant,
      'ok',
      `${BUNDLE_TOKEN_LOG_TAG} app=${this.app} tenant=${tenant} outcome=ok ` +
        `token_id=${typeof tokenId === 'string' ? tokenId : '-'} expires_at=${new Date(expiresAt).toISOString()}` +
        (bundle === undefined ? '' : ` bundle=${bundle}`),
    );
    return token;
  }
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * The bundle each fr-minted app is retried under on a 409 `ambiguous_bundle`.
 * Measured from licenses' migrations (028/039/059/065/066): workers and
 * secrets are each members of BOTH `non-agentic-ai` and `conveyor`
 * (workers also reached through app_requires closures of kag/w2v/marketing/
 * sales), so a tenant holding two of those bundles is ambiguous. fr is the
 * ensurer of `conveyor` (059) and licenses #282/#283 put secrets there for
 * fr to mint, so `conveyor` is the default.
 */
export const DEFAULT_BUNDLE_BY_APP: Readonly<Record<string, string>> = {
  workers: 'conveyor',
  secrets: 'conveyor',
};
export const BUNDLE_BY_APP_ENV = 'BUNDLE_TOKEN_BUNDLE_BY_APP';

/**
 * `BUNDLE_TOKEN_BUNDLE_BY_APP` = `app=bundle[,app=bundle…]` overrides the
 * default per app (an empty value `app=` turns the retry off for that app).
 * A malformed pair is ignored, never fatal.
 */
export function parseBundleByApp(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_BUNDLE_BY_APP };
  for (const pair of (raw ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const app = pair.slice(0, eq).trim();
    const bundle = pair.slice(eq + 1).trim();
    if (!app) continue;
    if (bundle) out[app] = bundle;
    else delete out[app];
  }
  return out;
}

const minters = new Map<string, BundleTokenMinter>();

/**
 * The process-wide minter for `app`, or `undefined` when fr is not configured
 * to mint (BUNDLE_MINTER_CLIENT_ID/SECRET or the licenses URL absent). Absent
 * is absent: the caller keeps its pre-existing path.
 *
 * Keycloak: the minter client lives in realm `secure-apps`, reached at
 * KEYCLOAK_SECURE_APPS_URL (fr's existing secure-apps base URL).
 */
export function getBundleTokenMinter(app: string): BundleTokenMinter | undefined {
  const existing = minters.get(app);
  if (existing) return existing;
  const clientId = env(BUNDLE_MINTER_CLIENT_ID_ENV);
  const clientSecret = env(BUNDLE_MINTER_CLIENT_SECRET_ENV);
  // Env first (read per construction, so a test or a pod roll sees it), then the
  // config value captured at import — the same two names `services/licenses.ts` reads.
  const licensesUrl =
    env('LICENSES_SERVICE_URL') ?? env('LICENSES_URL') ?? config.services.licenses.baseUrl?.trim();
  const keycloakUrl = env('KEYCLOAK_SECURE_APPS_URL') ?? config.keycloak.url;
  if (!clientId || !clientSecret || !licensesUrl || !keycloakUrl) return undefined;
  const minter = new BundleTokenMinter({
    licensesUrl,
    app,
    disambiguationBundle: parseBundleByApp(env(BUNDLE_BY_APP_ENV))[app],
    auth: new ServiceAuthenticator({
      keycloakUrl,
      realm: env('KEYCLOAK_SECURE_APPS_REALM') ?? 'secure-apps',
      clientId,
      clientSecret,
      refreshBuffer: 30,
    }),
  });
  minters.set(app, minter);
  return minter;
}
