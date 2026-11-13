import {
  getBearerToken,
  getCorrelationId,
  getEndUserToken,
  getProjectId,
  getSubjectId,
  getTenantId,
  getUserId,
} from './context';
import { IntegrationError, busyRetrySeconds } from './errors';
import { serviceCredential } from './service-credential';

/**
 * An `Authorization` credential that fr *obtains* rather than reads.
 *
 * `serviceTokenEnvVar` covers the static case — a licence sitting in an env var,
 * valid until someone rotates the secret and rolls the pod. This covers the case
 * where the upstream mints the credential itself: Planka hands out its own JWT in
 * exchange for a service login, and that JWT can be revoked out from under us, so
 * an unauthorized response has to be able to drop the cached copy and ask again.
 *
 * Implementations are expected to cache — `token()` is called on every request.
 */
export interface CredentialProvider {
  /** The raw bearer token to present, or `undefined` to send no header. */
  token(): Promise<string | undefined>;
  /** Drop any cached token so the next `token()` mints a fresh one. */
  invalidate(): void;
}

/**
 * A per-TENANT credential fr obtains for the tenant it is calling for: the
 * tenant's OWN tenant×app licence (George 2026-10-15: no app-to-app licences).
 * `token(tenant)` answers `undefined` when that tenant has none, and the client
 * then keeps its pre-existing path for that request. See
 * `HttpClientOptions.tenantCredentialProvider`.
 */
export interface TenantCredentialProvider {
  token(tenantId: string): Promise<string | undefined>;
  /** Drop `rejected` (the cached token the upstream answered 401 to). */
  invalidate(tenantId: string, rejected?: string): void;
}

export interface HttpClientOptions {
  serviceName: string;
  baseUrl: string;
  /**
   * Relay an upstream 503 / 429 as `UPSTREAM_BUSY` — the SAME status, its
   * `Retry-After` header and the body's busy fields — instead of the default
   * mapping (503 → 502, 429 → 429 with the header dropped). For an upstream
   * whose 503 is a deliberate, retryable admission-control answer (the
   * Scientific Processor's GPU lanes). Off by default: for every other
   * upstream a 503 still reads as a gateway failure, exactly as before.
   */
  passThroughBusy?: boolean;
  defaultTimeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  retry?: {
    attempts: number;
    backoffMs: number;
    /**
     * Attempts for CONNECTION-level failures, separate from `attempts`.
     *
     * A timeout costs a full `defaultTimeoutMs` before it is known, so extra
     * timeout attempts extend the user-visible budget (n8n documents 15,000 ms
     * x 2 + 200 ms = ~30.2 s, and things are sized against it). A connection
     * that dies costs ~0 ms, so retrying THAT is free and must not be capped by
     * the same number.
     *
     * MEASURED 2026-09-01: n8n advertises `Keep-Alive: timeout=5` while fr's
     * ActivityTray polls every 15 s, so the pooled socket is ALWAYS past the
     * server's idle window on reuse. Whether a poll fails is just a race
     * between undici reaping the socket and reusing it, which is why the
     * failures are sparse (34 over 4.7 d) rather than constant, recur for days,
     * and show no n8n restart. Those 34 are the residue where BOTH the first
     * attempt and its single retry drew a dead socket.
     */
    connectionAttempts?: number;
  };
  /**
   * Attach `Authorization: Bearer <ALS token>` — the END USER's Keycloak JWT,
   * lifted from the request context — to every request this client sends.
   *
   * REQUIRED, and deliberately so. It used to default to `true`, which meant
   * the identity fr presents upstream was decided by omission at 22 of 24 call
   * sites: nobody had written it down, and `sendAuthorization: true` appeared
   * nowhere in the repo. That default is how the kanban defect shipped
   * (2026-08-26, #848) — Planka issues its own tokens and answers a Keycloak
   * JWT with 401, so every verb on `/api/assets/kanban/*` failed for any
   * super-admin without a Planka account. It was never a weaker identity; it
   * was a guaranteed failure that no reviewer could see, because the wrong
   * behaviour was spelled by the ABSENCE of a line.
   *
   * Making it required moves that from a default to a decision: `bunx tsc
   * --noEmit` (`bun run ci:verify`, over a tsconfig with no `include`/`exclude`)
   * refuses to compile a call site that does not say which identity it means.
   *
   * `true`  — the upstream authenticates the end user by their Keycloak bearer.
   * `false` — it does not. Say so, and say WHY at the call site, citing the
   *           upstream file:line that proves it. The fleet convention is
   *           licence-token-as-`X-Tenant-Id`, never `Authorization`; sending a
   *           bearer to such a service is at best inert and at worst the
   *           2026-04-26 outage class, where fr's Keycloak JWT was introspected
   *           as a licence token and 401'd production.
   *
   * Suppressed entirely by `credentialProvider` (see below), which names a
   * different identity for the same header.
   */
  sendAuthorization: boolean;
  /**
   * Present fr's OWN service licence in `Authorization: Bearer <token>`, read
   * from this env var at call time.
   *
   * Distinct from `sendAuthorization`, which forwards the END USER's Keycloak
   * JWT — the thing fr must never send to coding (S6/S8). This sends a
   * credential that belongs to fr, so the upstream can verify WHO is asserting
   * the tenant while the CUSTOMER tenant keeps riding the plain `X-Tenant-Id`
   * header untouched.
   *
   * Needed because the coding-* services no longer trust a bare `X-Tenant-Id`
   * (`TRUST_TENANT_HEADER=false`). Without a credential every proxied call
   * reaches a backend with nothing to introspect and 401s; coding-gateway
   * honours fr's asserted tenant only because `svc-fr-backend`'s subject is in
   * its `CODING_ONBEHALF_SUBJECTS`.
   *
   * Read per request, not at construction, so a token rotation needs no
   * restart. Unset ⇒ no header, exactly as before.
   */
  serviceTokenEnvVar?: string;
  /**
   * Mint the `Authorization` header per request from an async source, and
   * re-mint it once if the upstream answers 401.
   *
   * Setting this SUPPRESSES the `sendAuthorization` JWT forward — the two are
   * different identities competing for one header, and this one wins. An
   * upstream that issues its own tokens (Planka) rejects the end user's Keycloak
   * JWT outright, so forwarding it is not a degraded outcome, it is a guaranteed
   * 401. Pass `sendAuthorization: false` too, to say so at the call site.
   */
  credentialProvider?: CredentialProvider;
  /**
   * Present fr's OWN service licence in `Authorization` — but only on the
   * requests whose PATH the predicate accepts, and OUTRANKING the ambient
   * end-user JWT on those paths.
   *
   * Distinct from `serviceTokenEnvVar` on both axes:
   *
   *  - SCOPE. `serviceTokenEnvVar` is all-or-nothing for the client. Some
   *    upstreams (kag) fan a single base URL out to a dozen backends and
   *    FORWARD the inbound `Authorization` on to each of them, so swapping the
   *    credential client-wide changes what every downstream sees. This option
   *    lets one client speak with two identities, chosen by destination.
   *  - PRECEDENCE. `serviceTokenEnvVar` yields to the end-user JWT (it is a
   *    `!h.has('authorization')` fallback, and `sendAuthorization` runs first).
   *    That is wrong for a licence-introspecting destination: the end-user
   *    Keycloak JWT introspects `active=false` there, so forwarding it is a
   *    guaranteed refusal, not a degraded outcome. This option therefore runs
   *    BEFORE the JWT block and wins.
   *
   * An explicit per-call `headers.authorization` still outranks BOTH — the
   * caller naming an identity is always the most specific statement.
   *
   * Read per request, not at construction, so a token rotation needs no
   * restart. Env var unset ⇒ no header at all (absent is absent) and the
   * ordinary `sendAuthorization` path resumes, exactly as before.
   */
  serviceTokenForPath?: {
    envVar: string;
    matches: (req: ServiceTokenRequest) => boolean;
  };
  /**
   * Present fr's OWN service licence in `X-Tenant-Id: Bearer <token>` and name
   * the tenant being acted for in `X-Effective-Tenant-Id`.
   *
   * ⛔ NOT A SPELLING VARIANT OF `serviceTokenEnvVar`. That option writes
   * `Authorization`, and for a licence-introspecting FastAPI service in this
   * fleet that slot is the WRONG one: worker_management's
   * `_extract_license_token` reads `X-Tenant-Id` and NOTHING else
   * (`src/api/auth_middleware.py:740-752`), reserving `Authorization` for the
   * upstream caller's own auth — accepting a licence there is what caused the
   * 2026-04-26 prod 401s. So a credential put in `Authorization` for such a
   * service is inert: it is never introspected, no subject is resolved, and the
   * delegation gate never fires. Two different slots, two different contracts.
   *
   * WHAT IT UNLOCKS. `auth_middleware.py:548-549` lets an introspected subject
   * listed in `AUTH_DELEGATING_SUBJECTS` re-scope the request to the tenant
   * named in `X-Effective-Tenant-Id`, so BYO resolution and the cost event
   * follow the CUSTOMER rather than fr's service account. Without the
   * credential there is no introspected subject, so the gate cannot fire and
   * the header is ignored (`:623`, which logs a rejection and moves on).
   *
   * ⛔ BOTH HEADERS OR NEITHER, and that is a safety property, not tidiness.
   * `auth_middleware.py:501` validates a token whenever one is present, EVEN
   * from a trusted network, and answers 401 on `active:false` — it does not
   * fall through to the tokenless trusted-network branch that these calls
   * currently succeed on. And a Bearer that DOES introspect but arrives with no
   * effective tenant leaves `tenant_id` set to fr's own service-account tenant,
   * i.e. a silent wrong-tenant read. So the pair is attached only when the env
   * var resolves to a non-blank token AND a trimmed-non-empty tenant is
   * actually going out. Either one missing ⇒ the request is byte-identical to
   * what it was before this option existed (plain `X-Tenant-Id`, tokenless
   * trusted-network branch), which is why an unset secret cannot break a
   * working path.
   *
   * Read per request, not at construction, so a token rotation needs no
   * restart.
   */
  tenantBearerEnvVar?: string;
  /**
   * FAIL CLOSED when `tenantBearerEnvVar` holds no token (R351 (7): every RM caller presents a
   * token). Set ⇒ an unset or blank token REFUSES the call before anything is sent, with
   * `SERVICE_NOT_CONFIGURED` naming the env var — never the plain-uuid `X-Tenant-Id` request,
   * which a trusted-network upstream would serve without knowing who asked.
   */
  tenantBearerRequired?: boolean;
  /**
   * Present the TENANT's own licence in `Authorization: Bearer <token>`,
   * resolved per request for the tenant the request is FOR (an explicit
   * per-call `x-tenant-id`, else the ambient frame; blank is absent).
   *
   * When it yields a token, the request is a plain tenant×app call: the
   * `tenantBearerEnvVar` delegation pair (`X-Tenant-Id: Bearer <fr licence>` +
   * `X-Effective-Tenant-Id`) is NOT attached. The plain `X-Tenant-Id:
   * <tenant>` still goes out, naming the licence's own tenant, and
   * `forwardEndUserToken` still sends the signed-in user's token when it
   * proves that same tenant: the licence names the TENANT, the end-user token
   * names the USER inside it (worker ownership, `visibility='user'`, per-user
   * cost attribution).
   *
   * When it yields nothing (tenant without the bundle, licenses down), the
   * request goes out exactly as it would without this option — the
   * transitional delegation fallback.
   *
   * On a LICENCE-refused 401 (`WWW-Authenticate` exactly `Bearer`, no
   * params — see `isAuthLayer401`; `Bearer error="invalid_token"` refuses the
   * end-user/caller token instead and is NOT replayed) the token is invalidated and the request
   * replayed ONCE with whatever the provider now answers (a re-mint, or the
   * fallback path). A handler 401 without that header (e.g. WM's
   * `crud_endpoints.py` "Invalid API credentials" for a provider key) is
   * about something else: it is returned as is, nothing invalidated or
   * re-minted, nothing replayed.
   */
  tenantCredentialProvider?: TenantCredentialProvider;
  /**
   * On a DELEGATED request (the `tenantBearerEnvVar` pair actually attached),
   * or a TENANT-LICENCE request (`tenantCredentialProvider` token attached),
   * also send the signed-in user's own portal token as
   * `X-End-User-Token: Bearer <token>` (worker_management#316). That is the
   * proof WM requires before it decrypts the tenant's BYO key for fr's service
   * account; without it every BYO call answers `BYO_KEY_WITHHELD`.
   *
   * Sent only when the ambient frame holds an `endUserToken` (a verified human
   * portal token that proves the frame's tenant via `tenant_id` or
   * `member_tenant_ids` (fr#1385) — see
   * `RequestContext.endUserToken`) AND the tenant the request is for (the
   * outgoing `X-Effective-Tenant-Id`, or the tenant the licence was minted
   * for) is that same tenant. Agent-token, conveyor, cron and switched-tenant frames
   * have no such token and send nothing. Opt-in per client: it is a user
   * credential, so no other upstream may receive it.
   */
  forwardEndUserToken?: boolean;
  /**
   * FAIL CLOSED when no tenant can be named (WM#324, fr row 15).
   *
   * Every request must carry a tenant: an explicit per-call `x-tenant-id`, a
   * default `x-tenant-id`, or the ambient request frame's tenant. When none
   * resolves (a call made outside any request frame — a background loop, a
   * boot-time hook — or a frame with a blank tenant), the call is REFUSED
   * before anything is sent, with `MISSING_TENANT`.
   *
   * Why refuse rather than send: without a tenant the upstream does not fail —
   * worker_management serves its DEFAULT tenant on a tokenless trusted-network
   * call, i.e. the wrong tenant's data, silently. And fr must never fill the
   * gap with its own service licence or the system tenant: that would let the
   * system frame read customer data (strict tenant separation, 2026-10-03
   * ruling). Derive the tenant from the project or caller, or do not call.
   */
  requireTenant?: boolean;
  /**
   * Per-request headers resolved at BUILD time (so they can read the ALS
   * request frame), e.g. kag's `X-Actor-Id`. Same precedence as
   * `defaultHeaders`: a header the call site already set wins, and an
   * `undefined` value is omitted rather than sent empty. Applied on `json`,
   * `fetch` and `proxy` alike — `proxy` builds its headers from scratch, so an
   * inbound client header can never reach the upstream under these names.
   */
  dynamicHeaders?: () => Record<string, string | undefined>;
}

/** worker_management#316 wire name (`src/auth/end_user_token.py`). Frozen. */
export const END_USER_TOKEN_HEADER = 'X-End-User-Token';

/**
 * The facts `serviceTokenForPath.matches` gets to decide on.
 *
 * It used to be a bare `path`, which was enough while the only question was
 * "is this destination the licence-introspecting gateway?". Two more facts are
 * needed now, and BOTH must be resolved where the header is actually built —
 * guessing either at the call site is how the wrong-tenant purge below ships.
 */
export interface ServiceTokenRequest {
  /** The upstream path as handed to the client; may carry a query string. */
  path: string;
  /** Upper-cased HTTP method. Some paths are destructive on one verb only. */
  method: string;
  /**
   * Will a NON-BLANK `X-Tenant-Id` actually go out on THIS request?
   *
   * ⛔ Load-bearing for destructive routes. kag's trust ladder has a rung for
   * "Authorization present, X-Tenant-Id ABSENT" that adopts the LICENCE'S OWN
   * tenant — which is fr's, not the customer's. A background/worker invocation
   * outside an async request frame has no ambient tenant and sets no header
   * (see the `x-tenant-id` block below), so attaching a credential there would
   * silently retarget the call at fr's tenant. Every kag DELETE is
   * tenant-scoped AND idempotent, so that lands as a 200 having deleted
   * nothing — indistinguishable from success. A predicate can therefore refuse
   * to vouch unless a tenant rides along, which keeps the no-tenant request
   * byte-identical to what it was before any credential existed.
   *
   * True when the CALLER set an explicit, trimmed-non-empty `x-tenant-id`
   * (e.g. `kag.deleteDocument`, which replays the document's recorded tenant)
   * OR the ambient request frame resolves a trimmed-non-empty one. BLANK IS
   * FALSE: kag treats `""` / `"   "` as absent (`.strip()` at
   * `auth/tenant.py:292`), so fr must too — and the setter below must not
   * write a blank value either, or the two sides disagree and the credential
   * rides a request kag reads as tenant-less.
   */
  hasTenantHeader: boolean;
}

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Bun.HeadersInit;
  /** When true, errors from upstream are not retried even on 5xx/network. */
  noRetry?: boolean;
  /**
   * Opt a non-idempotent method (POST/PATCH) back INTO retry. Off by default:
   * retrying a write is unsafe (a timed-out request may have already committed
   * upstream → duplicate side effects). Set only when the upstream is
   * idempotent for this call (e.g. it dedups on an idempotency key).
   */
  retryNonIdempotent?: boolean;
  /** Optional AbortSignal that overrides timeout-based aborts. */
  signal?: AbortSignal;
}

/**
 * The side-channel header naming the tenant a delegating service account is
 * acting FOR.
 *
 * A FROZEN WIRE CONSTANT, deliberately spelled here rather than imported: the
 * receiving side (worker_management `src/api/identity_context.py:43`) freezes
 * the same literal for the same reason, and the two must agree byte-for-byte or
 * the delegation silently does not happen — the receiver logs nothing on the
 * happy path, so a typo reads as "the gate is not configured".
 */
export const EFFECTIVE_TENANT_HEADER = 'X-Effective-Tenant-Id';

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
// Statuses `passThroughBusy` relays as UPSTREAM_BUSY (see HttpClientOptions).
const BUSY_STATUS = new Set([429, 503]);
// HTTP-idempotent methods: safe to retry on 5xx/timeout/network error. POST and
// PATCH are NOT here — retrying them can duplicate side effects (a write that
// timed out after the server committed gets re-sent). Callers that know their
// write is upstream-idempotent can opt in via `retryNonIdempotent`.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export class HttpClient {
  private readonly serviceName: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly retry: { attempts: number; backoffMs: number; connectionAttempts: number };
  private readonly sendAuthorization: boolean;
  private readonly serviceTokenEnvVar: string | undefined;
  private readonly credentialProvider: CredentialProvider | undefined;
  private readonly tenantCredentialProvider: TenantCredentialProvider | undefined;
  private readonly serviceTokenForPath: HttpClientOptions['serviceTokenForPath'];
  private readonly tenantBearerEnvVar: string | undefined;
  private readonly tenantBearerRequired: boolean;
  private readonly forwardEndUserToken: boolean;
  private readonly requireTenant: boolean;
  private readonly dynamicHeaders: HttpClientOptions['dynamicHeaders'];
  private readonly passThroughBusy: boolean;

  constructor(opts: HttpClientOptions) {
    this.serviceName = opts.serviceName;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    const retry = opts.retry ?? { attempts: 2, backoffMs: 200 };
    this.retry = {
      ...retry,
      // Default 3, above the timeout/5xx default of 2. Retrying a dead
      // connection is free; retrying a timeout is not. See `connectionAttempts`.
      connectionAttempts: retry.connectionAttempts ?? 3,
    };
    this.sendAuthorization = opts.sendAuthorization;
    this.serviceTokenEnvVar = opts.serviceTokenEnvVar;
    this.credentialProvider = opts.credentialProvider;
    this.tenantCredentialProvider = opts.tenantCredentialProvider;
    this.serviceTokenForPath = opts.serviceTokenForPath;
    this.tenantBearerEnvVar = opts.tenantBearerEnvVar;
    this.tenantBearerRequired = opts.tenantBearerRequired === true;
    if (this.tenantBearerRequired && !this.tenantBearerEnvVar) {
      throw new Error(`${opts.serviceName}: tenantBearerRequired needs tenantBearerEnvVar`);
    }
    this.forwardEndUserToken = opts.forwardEndUserToken === true;
    this.requireTenant = opts.requireTenant === true;
    this.dynamicHeaders = opts.dynamicHeaders;
    this.passThroughBusy = opts.passThroughBusy === true;
  }

  /**
   * See `HttpClientOptions.requireTenant`. Resolves the tenant exactly as
   * `buildHeaders` does (explicit/default `x-tenant-id`, else the ambient frame;
   * blank is absent) and throws BEFORE the request. Called at the entry of
   * `fetch()` and `proxy()` — before any credential is minted and outside the
   * retry loop, where the network-error handler would retry and rewrap a
   * refusal that no retry can fix.
   */
  private assertTenantResolvable(
    init: RequestInit['headers'],
    path: string,
    method: string,
  ): void {
    if (!this.requireTenant) return;
    const explicit = new Headers(init).get('x-tenant-id')?.trim();
    const fromDefaults = Object.entries(this.defaultHeaders)
      .find(([k]) => k.toLowerCase() === 'x-tenant-id')?.[1]
      ?.trim();
    const ambient = getTenantId()?.trim();
    if (explicit || fromDefaults || ambient) return;
    throw new IntegrationError({
      code: 'MISSING_TENANT',
      message:
        `${this.serviceName}: no tenant could be resolved for this call, so it was not sent ` +
        '(fail closed: fr never substitutes its own or the system tenant)',
      path,
      method,
    });
  }

  /** See `HttpClientOptions.tenantBearerRequired`. Called next to `assertTenantResolvable`. */
  private assertTenantBearer(path: string, method: string): void {
    if (!this.tenantBearerRequired || serviceCredential(this.tenantBearerEnvVar!)) return;
    throw new IntegrationError({
      code: 'SERVICE_NOT_CONFIGURED',
      message:
        `${this.serviceName}: ${this.tenantBearerEnvVar} is unset, so fr has no token to present and the call ` +
        'was not sent (fail closed: fr never calls this service tokenless)',
      service: this.serviceName,
      path,
      method,
    });
  }

  private buildHeaders(
    init?: Bun.HeadersInit,
    mintedCredential?: string,
    path?: string,
    method?: string,
    tenantCredential?: string,
  ): Headers {
    const h = new Headers(init);
    for (const [k, v] of Object.entries(this.defaultHeaders)) {
      if (!h.has(k)) h.set(k, v);
    }
    if (this.dynamicHeaders) {
      for (const [k, v] of Object.entries(this.dynamicHeaders())) {
        if (v !== undefined && v !== '' && !h.has(k)) h.set(k, v);
      }
    }
    // Resolved HERE, above the `authorization` writers, rather than at its own
    // point of use further down — two independent decisions read it now, and
    // the credential decision is the one that must not be made without it.
    // The value and the ordering of the `x-tenant-id` block below are
    // unchanged; this is a hoist, not a behaviour change.
    const tenantId = getTenantId();
    // ⛔ TRIMMED-NON-EMPTY, ON BOTH SIDES, AND THEY MUST NOT DIVERGE.
    // kag decides "was a tenant header supplied?" at `auth/tenant.py:292` with
    //     if not (raw_tenant_header or "").strip():
    // so a blank or whitespace-only `X-Tenant-Id` is ABSENT to kag, and kag
    // then takes the licence rescue and adopts the LICENCE'S OWN tenant. fr's
    // notion of "present" therefore has to be kag's notion of "present" — the
    // whole defect is the two sides disagreeing. `Headers` normalises values,
    // so an ambient tenant of `'   '` also reaches the wire as `""`.
    // Do NOT "simplify" either of these back to a truthiness check: the gate
    // below (attach a credential?) and the setter further down (write the
    // header?) read the SAME `effectiveTenantId`, and a blank one must produce
    // neither.
    const effectiveTenantId = tenantId?.trim() ? tenantId.trim() : undefined;
    // The header that will ACTUALLY go on the wire: an explicit per-call
    // `x-tenant-id` wins (the caller named the tenant), else the ambient
    // request-frame one, else NOTHING — and a destination's
    // `serviceTokenForPath.matches` must be able to see that no-tenant case.
    // See `ServiceTokenRequest.hasTenantHeader`.
    const hasTenantHeader =
      Boolean(h.get('x-tenant-id')?.trim()) || effectiveTenantId !== undefined;
    // DESTINATION-SCOPED SERVICE LICENCE. Deliberately the FIRST writer of
    // `authorization` (after an explicit per-call header, which the `!h.has`
    // guard preserves): on a licence-introspecting destination the end-user
    // JWT below is not a weaker credential, it is the wrong KIND of credential
    // and introspects `active=false`. Skipped entirely when the path does not
    // match or the env var is unset, which leaves the blocks below to run
    // exactly as they always have.
    if (
      this.serviceTokenForPath &&
      path !== undefined &&
      this.serviceTokenForPath.matches({
        path,
        method: (method ?? 'GET').toUpperCase(),
        hasTenantHeader,
      })
    ) {
      const scopedToken = serviceCredential(this.serviceTokenForPath.envVar);
      if (scopedToken && !h.has('authorization')) {
        h.set('authorization', `Bearer ${scopedToken}`);
      }
    }
    // The TENANT's own licence (tenant×app). Minted by `fetch()`/`proxy()` for
    // the very tenant resolved there; its presence turns the delegation pair
    // below off. See `tenantCredentialProvider`.
    if (tenantCredential && !h.has('authorization')) {
      h.set('authorization', `Bearer ${tenantCredential}`);
    }
    // Exactly one identity can occupy `Authorization`, so resolve precedence
    // here rather than letting write-order decide it.
    if (this.credentialProvider) {
      // A credential fr obtained on its own behalf outranks the ambient
      // end-user JWT: the caller named the identity fr must present. It
      // outranks it even when minting produced nothing, because falling back
      // would put a token on the wire that this upstream is known to reject —
      // absent is absent. Without this precedence, a caller who wires a
      // provider but leaves `sendAuthorization` at its default `true` silently
      // keeps forwarding the end user's token and gets the 401 the provider
      // existed to prevent. That was the kanban defect (2026-08-26).
      //
      // `mintedCredential` is passed in because minting is async and this
      // method is not.
      if (mintedCredential && !h.has('authorization')) {
        h.set('authorization', `Bearer ${mintedCredential}`);
      }
    } else if (this.sendAuthorization) {
      const token = getBearerToken();
      if (token && !h.has('authorization')) {
        h.set('authorization', `Bearer ${token}`);
      }
    }
    // fr's OWN service licence — never the end user's JWT. Set BEFORE the
    // X-Tenant-Id block below and deliberately without touching it: the
    // credential proves who is asking, the plain header names whose data is
    // being asked for, and collapsing the two would scope every coding call to
    // fr's own tenant instead of the customer's.
    if (this.serviceTokenEnvVar) {
      const serviceToken = serviceCredential(this.serviceTokenEnvVar);
      if (serviceToken && !h.has('authorization')) {
        h.set('authorization', `Bearer ${serviceToken}`);
      }
    }
    // DELEGATED TENANT — `X-Tenant-Id: Bearer <fr licence>` PLUS
    // `X-Effective-Tenant-Id: <customer tenant>`. See `tenantBearerEnvVar` for
    // why the credential goes in THIS header and not `Authorization`.
    //
    // Placed immediately above the plain-`X-Tenant-Id` block on purpose: it
    // occupies the same header, so the `!h.has('x-tenant-id')` guard below
    // turns into the no-op it should be once the pair is attached. When the
    // pair is NOT attached (unset secret, or no tenant to name) this block
    // writes nothing and the plain header goes out exactly as before.
    // The tenant the tenant licence was minted FOR — same resolution as
    // `credentialTenant()` (explicit plain header, else the frame). Read here,
    // before anything below can rewrite `x-tenant-id`.
    const explicitPlainTenant = h.get('x-tenant-id')?.trim();
    const licensedTo = tenantCredential
      ? (explicitPlainTenant && !explicitPlainTenant.toLowerCase().startsWith('bearer ')
          ? explicitPlainTenant
          : effectiveTenantId
        )?.toLowerCase()
      : undefined;
    if (this.tenantBearerEnvVar && !tenantCredential) {
      const explicitTenant = h.get('x-tenant-id')?.trim();
      // A caller that already spelled the Bearer shape itself named both the
      // credential and the slot; do not re-decide it for them.
      if (!explicitTenant?.toLowerCase().startsWith('bearer ')) {
        // The tenant fr is acting FOR: an explicit per-call header wins (the
        // caller named it), else the ambient request frame. Same resolution as
        // `hasTenantHeader` above, and blank is absent on both sides.
        const delegatedTenant = explicitTenant || effectiveTenantId;
        const tenantBearer = serviceCredential(this.tenantBearerEnvVar);
        if (tenantBearer && delegatedTenant) {
          h.set('x-tenant-id', `Bearer ${tenantBearer}`);
          if (!h.has(EFFECTIVE_TENANT_HEADER)) {
            h.set(EFFECTIVE_TENANT_HEADER, delegatedTenant);
          }
        }
      }
    }
    // END-USER PROOF for the delegated tenant (worker_management#316). Only
    // after the pair above went out, and only for the tenant the token itself
    // proves (`endUserToken` is set only when `tokenProvesTenant` holds for the
    // frame's tenant: its `tenant_id` or a `member_tenant_ids` entry). An explicit per-call x-tenant-id naming another tenant therefore
    // gets no token. The value is a credential: it is never logged.
    if (this.forwardEndUserToken && !h.has(END_USER_TOKEN_HEADER)) {
      const endUserToken = getEndUserToken();
      const delegatedTo =
        h.get(EFFECTIVE_TENANT_HEADER)?.trim().toLowerCase() || licensedTo;
      if (
        endUserToken &&
        delegatedTo &&
        effectiveTenantId !== undefined &&
        delegatedTo === effectiveTenantId.toLowerCase()
      ) {
        h.set(END_USER_TOKEN_HEADER, `Bearer ${endUserToken}`);
      }
    }
    // Plain X-Tenant-Id (NOT Bearer-prefixed) — upstream services
    // (secrets / requirements_management /
    // worker_management / artifact_service / kag) read this header in their
    // trusted-network branch when no license token is present. Without it,
    // they fall back to DEFAULT_TENANT_ID and serve the wrong tenant's data.
    // `effectiveTenantId` is resolved at the top of this method (hoisted so the
    // credential decision above can see it) and is TRIMMED-non-empty, matching
    // kag's `.strip()` at `auth/tenant.py:292`. A blank/whitespace-only ambient
    // tenant is written as NOTHING rather than as an empty header: writing it
    // would put fr on the exact rung ("Authorization present, X-Tenant-Id
    // absent") that adopts the licence's own tenant.
    if (effectiveTenantId && !h.has('x-tenant-id')) {
      h.set('x-tenant-id', effectiveTenantId);
    }
    // X-User-Id — companion to X-Tenant-Id for the next-push tenant+user
    // separation contract. Upstream services that have shipped support
    // (worker_management / requirements_management pattern) attribute the
    // request to this user inside the tenant. Services that haven't yet
    // adopted the contract simply ignore the header — extra headers are
    // benign by design, so this is forward-compatible.
    const userId = getUserId();
    if (userId && !h.has('x-user-id')) {
      h.set('x-user-id', userId);
    }
    // Plain X-Subject-Id (the Keycloak `sub` of the originating end user).
    // Co-equal to X-Tenant-Id per the per-user metering rollout (Phase 5a,
    // 2026-04-27): inference-router + metering-service attribute LLM cost
    // to the user via this header. Distinct from X-User-Id (different
    // upstream contract); both typically carry the same UUID when present.
    const subjectId = getSubjectId();
    if (subjectId && !h.has('x-subject-id')) {
      h.set('x-subject-id', subjectId);
    }
    const cid = getCorrelationId();
    if (cid && !h.has('x-correlation-id')) {
      h.set('x-correlation-id', cid);
    }
    // X-Project-Id — the fr project this request operates on, ONLY when
    // `lib/project-owner-guard.ts guardProjectId()` has already validated it
    // (`setProjectId` in context.ts accepts no other source). Absent by
    // default: most calls have no project in scope (cron, tenant-wide reads),
    // exactly like X-Coding-Job-Id.
    const projectId = getProjectId();
    if (projectId && !h.has('x-project-id')) {
      h.set('x-project-id', projectId);
    }
    return h;
  }

  /**
   * D4 — refuse a request path that could escape the route the caller built.
   *
   * Query strings arrive PRE-JOINED (`/x?limit=5`, built by the generated
   * clients / callers), so a `?` cannot be told apart from builder output and
   * is allowed; everything before the first `?` is the path proper. In it, any
   * segment that is `.` or `..` -- raw or percent-encoded (`%2e`, any case) --
   * is refused, as is a `#` anywhere (a fragment is never sent upstream; one in
   * a path is an interpolated id). Thrown before any fetch.
   */
  private assertSafePath(path: string, method: string): void {
    const withoutOrigin = path.replace(/^https?:\/\/[^/?#]*/i, '');
    const q = withoutOrigin.indexOf('?');
    const pathPart = q === -1 ? withoutOrigin : withoutOrigin.slice(0, q);
    const hasFragment = path.includes('#');
    const badSegment = pathPart.split('/').some((seg) => {
      const decoded = seg.replace(/%2e/gi, '.');
      return decoded === '.' || decoded === '..';
    });
    if (hasFragment || badSegment) {
      throw new IntegrationError({
        code: 'BAD_PATH',
        message: `Refusing upstream path with a dot-segment or fragment: ${JSON.stringify(path)}`,
        service: this.serviceName,
        path,
        method,
      });
    }
  }

  /**
   * Refuse a relative path when this client has NO base URL. An optional
   * upstream whose env var is unset (e.g. KAG_API_URL / METERING_BASE_URL after
   * the KAG family and improvement-loop-service were removed, gitops #4968)
   * would otherwise build a bare `/path` and fail inside `fetch` as an opaque,
   * RETRIED `UPSTREAM_UNREACHABLE`. This answers a clear, non-retried 503
   * `SERVICE_NOT_CONFIGURED` instead. Thrown before any fetch or credential mint.
   */
  private assertConfigured(path: string, method: string): void {
    if (this.baseUrl) return;
    if (path.startsWith('http://') || path.startsWith('https://')) return;
    throw new IntegrationError({
      code: 'SERVICE_NOT_CONFIGURED',
      message: 'This feature is not available on this deployment',
      service: this.serviceName,
      path,
      method,
    });
  }

  private buildUrl(path: string, method = 'GET'): string {
    this.assertSafePath(path, method);
    this.assertConfigured(path, method);
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${p}`;
  }

  /**
   * Low-level fetch that still returns a Response (no JSON parsing).
   *
   * Mints the `credentialProvider` token (if any) and re-mints it exactly once
   * when the upstream answers 401. A 401 is the one status where a replay is
   * safe on ANY method including POST/DELETE: the request was *refused*, so no
   * side effect landed upstream. This mirrors `services/planka/http.ts`, which
   * has always done the same for the resource client.
   */
  async fetch(path: string, init: RequestInit & RequestOptions = {}): Promise<Response> {
    // Before minting: a refused call does no work at all.
    this.assertSafePath(path, (init.method ?? 'GET').toUpperCase());
    this.assertConfigured(path, (init.method ?? 'GET').toUpperCase());
    this.assertTenantResolvable(init.headers, path, (init.method ?? 'GET').toUpperCase());
    this.assertTenantBearer(path, (init.method ?? 'GET').toUpperCase());

    const tenant = this.credentialTenant(init.headers);
    const tenantCredential = await this.mintTenantCredential(tenant);
    const res = await this.fetchWithProvider(path, init, tenantCredential);
    // Tenant licence refused AT THE AUTH LAYER: drop it and replay ONCE with whatever the provider
    // answers now (a re-mint, or `undefined` ⇒ the pre-existing path). Safe on
    // any method for the same reason as below — a 401 landed no side effect.
    if (
      !isAuthLayer401(res) ||
      tenant === undefined ||
      tenantCredential === undefined ||
      !isReplayableBody(init.body)
    ) {
      return res;
    }
    this.tenantCredentialProvider?.invalidate(tenant, tenantCredential);
    const fresh = await this.mintTenantCredential(tenant);
    if (fresh === tenantCredential) return res;
    await res.body?.cancel().catch(() => {});
    return await this.fetchWithProvider(path, init, fresh);
  }

  /**
   * The tenant a `tenantCredentialProvider` token is minted FOR: an explicit
   * per-call `x-tenant-id` (unless the caller spelled a Bearer itself), else
   * the ambient frame. Trimmed; blank is absent. `undefined` when no provider.
   */
  private credentialTenant(init: RequestInit['headers']): string | undefined {
    if (!this.tenantCredentialProvider) return undefined;
    const explicit = new Headers(init).get('x-tenant-id')?.trim();
    if (explicit) return explicit.toLowerCase().startsWith('bearer ') ? undefined : explicit;
    const ambient = getTenantId()?.trim();
    return ambient ? ambient : undefined;
  }

  /** Fail SOFT: any provider error is "no tenant credential" (the fallback path). */
  private async mintTenantCredential(tenant: string | undefined): Promise<string | undefined> {
    if (!this.tenantCredentialProvider || tenant === undefined) return undefined;
    try {
      return await this.tenantCredentialProvider.token(tenant);
    } catch {
      return undefined;
    }
  }

  private async fetchWithProvider(
    path: string,
    init: RequestInit & RequestOptions,
    tenantCredential: string | undefined,
  ): Promise<Response> {
    if (!this.credentialProvider) {
      return await this.fetchOnce(path, init, undefined, tenantCredential);
    }

    const credential = await this.mintCredential(path, init.method ?? 'GET');
    const res = await this.fetchOnce(path, init, credential, tenantCredential);
    if (res.status !== 401) return res;
    // Only replay a body we can hand to `fetch` twice. Every write in
    // `integrations/kanban.ts` passes a `JSON.stringify(...)` string, so they
    // all qualify; a stream would be already-consumed and re-sending it would
    // turn a clean 401 into a truncated request.
    if (!isReplayableBody(init.body)) return res;

    this.credentialProvider.invalidate();
    const fresh = await this.mintCredential(path, init.method ?? 'GET');
    // Nothing changed — the upstream is refusing the credential itself, not a
    // stale copy of it. Return the original 401 rather than spend a round trip
    // proving it twice.
    if (fresh === undefined || fresh === credential) return res;

    // Discard the rejected response body so its connection is released.
    await res.body?.cancel().catch(() => {});
    return await this.fetchOnce(path, init, fresh, tenantCredential);
  }

  private async mintCredential(path: string, method: string): Promise<string | undefined> {
    if (!this.credentialProvider) return undefined;
    try {
      return await this.credentialProvider.token();
    } catch (err) {
      // The provider throws in its own error vocabulary (PlankaAuthError,
      // PlankaNetworkError). Callers of this client — `routes/assets/_lib/handler`
      // and the bridge slice — branch on IntegrationError, so a raw provider
      // error would escape the contract and surface as an unhandled 500.
      throw new IntegrationError({
        code: 'UPSTREAM_UNAUTHORIZED',
        message: `${this.serviceName} service credential could not be minted: ${
          err instanceof Error ? err.message : String(err)
        }`,
        service: this.serviceName,
        path,
        method,
        cause: err,
      });
    }
  }

  private async fetchOnce(
    path: string,
    init: RequestInit & RequestOptions,
    credential: string | undefined,
    tenantCredential?: string,
  ): Promise<Response> {
    const url = this.buildUrl(path);
    const method = init.method ?? 'GET';
    const timeoutMs = init.timeoutMs ?? this.defaultTimeoutMs;
    // Only retry idempotent methods. A non-idempotent write (POST/PATCH) is
    // sent exactly once unless the caller explicitly opts in — otherwise a
    // 5xx/timeout retry could double-create cards/projects/runs/doc-ingests.
    const retryable =
      IDEMPOTENT_METHODS.has(method.toUpperCase()) || init.retryNonIdempotent === true;
    const single = init.noRetry || !retryable;
    // Two budgets, because the two failure modes cost differently. A timeout
    // burns `timeoutMs` before it is even known, so its attempt count sets the
    // user-visible ceiling. A connection that dies costs ~0 ms, so it gets its
    // own, larger budget — see `connectionAttempts` for the measurement.
    const attempts = single ? 1 : this.retry.attempts;
    const connAttempts = single ? 1 : this.retry.connectionAttempts;
    const maxAttempts = Math.max(attempts, connAttempts);

    let lastError: unknown;
    // Set after a CONNECTION-level failure (never after a timeout or a status):
    // the next attempt must not be handed another pooled socket. See below.
    let freshConnection = false;
    for (let i = 0; i < maxAttempts; i++) {
      const ac = new AbortController();
      const timeoutHandle = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
      const signal = init.signal ?? ac.signal;

      try {
        const res = await fetch(url, {
          ...init,
          method,
          headers: this.buildHeaders(init.headers, credential, path, method, tenantCredential),
          signal,
          // Bun: `keepalive: false` opts THIS request out of the connection
          // pool (bun-types docs/runtime/networking/fetch.mdx). Only on a retry
          // that follows a dead socket: n8n advertises `Keep-Alive: timeout=5`
          // and fr polls every 15 s, so EVERY idle pooled socket is past the
          // server's window. Retrying through the pool can draw a second dead
          // socket, and the residue where all `connectionAttempts` did so still
          // surfaced as a 502 on GET /api/tools/n8n/executions (~2/day). A
          // fresh connection cannot be stale. First attempts keep the pool.
          ...(freshConnection ? { keepalive: false } : {}),
        });
        clearTimeout(timeoutHandle);

        if (RETRYABLE_STATUS.has(res.status) && i < attempts - 1) {
          // A BUSY answer already says when to come back: hand it to the
          // caller now instead of re-asking a full lane 200 ms later.
          if (await this.isBusyAnswer(res)) return res;
          await this.sleep(this.retry.backoffMs * (i + 1));
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timeoutHandle);
        lastError = err;

        const isAbort =
          err instanceof Error && (err.name === 'AbortError' || err.message === 'timeout');
        if (isAbort && (init.signal?.aborted ?? false)) {
          // Caller-initiated abort — don't retry.
          throw new IntegrationError({
            code: 'UPSTREAM_TIMEOUT',
            message: `${this.serviceName} request aborted`,
            service: this.serviceName,
            path,
            method,
            cause: err,
          });
        }
        if (isAbort) {
          if (i < attempts - 1) {
            await this.sleep(this.retry.backoffMs * (i + 1));
            continue;
          }
          throw new IntegrationError({
            code: 'UPSTREAM_TIMEOUT',
            message: `${this.serviceName} request timed out after ${timeoutMs}ms`,
            service: this.serviceName,
            path,
            method,
            cause: err,
          });
        }
        // Connection-level failure (not an abort/timeout — those returned
        // above). Free to retry on an idempotent request, and the common cause
        // is a pooled socket the server already closed.
        if (i < connAttempts - 1) {
          freshConnection = true;
          await this.sleep(this.retry.backoffMs * (i + 1));
          continue;
        }
        throw new IntegrationError({
          code: 'UPSTREAM_UNREACHABLE',
          message: `${this.serviceName} unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
          service: this.serviceName,
          path,
          method,
          cause: err,
        });
      }
    }

    // Unreachable — the loop above either returns or throws.
    throw new IntegrationError({
      code: 'UPSTREAM_UNREACHABLE',
      message: `${this.serviceName} request failed`,
      service: this.serviceName,
      path,
      method,
      cause: lastError,
    });
  }

  /**
   * Call a JSON endpoint; throws IntegrationError on non-2xx or unparseable body.
   * Returns `undefined` for 204/205.
   *
   * ⚠️ THIS RETURNS THE BODY ONLY. The `Response` never escapes this method, so
   * **every integration in fr is blind to upstream response headers.** That is a
   * capability fr does not have, which is exactly the kind of thing a reader
   * cannot discover from the code — absence leaves no line to read — so it is
   * written down here rather than found the hard way.
   *
   * It is live and load-bearing today. graph-adapter's `GET /nodes/` emits
   * `X-Applied-Limit` / `X-Limit-Source` / `X-Result-Truncated` /
   * `X-Result-Offset` (verified live 2026-09-06 against a 403-node tenant:
   * `limit=402` → `truncated: true`, `limit=403` → `truncated: false`, the two
   * differing in that header alone). fr **cannot read any of them.**
   *
   * Note the asymmetry, because it is what makes this easy to get wrong: fr
   * EMITS the same class of header downstream to its own frontend
   * (`routes/assets/_lib/page-cap.ts` → `pageCapHeaders`), and the frontend DOES
   * read them (`lib/api/assets.ts` → `assetFetchPage`). Only the upstream
   * direction is blind. So "fr does page caps with headers" is true and still
   * does not mean this client can consume one.
   *
   * Until a header-exposing variant exists — the same split the frontend already
   * uses, `assetFetch` vs `assetFetchPage` — a route needing an upstream
   * truncation signal has to infer it from the row count, which is what
   * `frameProbe` does and why it can only ever say "the frame came back full",
   * never "more exist".
   */
  async json<T = unknown>(
    path: string,
    init: RequestInit & RequestOptions = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (init.body !== undefined && init.body !== null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const res = await this.fetch(path, { ...init, headers });

    if (res.status === 204 || res.status === 205) {
      return undefined as T;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      if (contentType.includes('application/json') || contentType.includes('+json')) {
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          if (res.ok) {
            throw new IntegrationError({
              code: 'UPSTREAM_BAD_BODY',
              message: `${this.serviceName} returned invalid JSON`,
              service: this.serviceName,
              path,
              method,
              upstreamStatus: res.status,
              upstreamBody: text,
              cause: err,
            });
          }
          parsed = text;
        }
      } else {
        parsed = text;
      }
    }

    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after') ?? undefined;
      // Busy = 429 always; 503 only WITH a valid retry hint (busyRetrySeconds).
      // A hintless 503 is kag's own connection failure / a mesh "no healthy
      // upstream" — an outage, so it falls through to the 502 mapping below.
      if (
        this.passThroughBusy &&
        BUSY_STATUS.has(res.status) &&
        (res.status === 429 || busyRetrySeconds(retryAfter, parsed) !== undefined)
      ) {
        throw new IntegrationError({
          code: 'UPSTREAM_BUSY',
          message: `${this.serviceName} ${method} ${path} returned ${res.status} (busy)`,
          service: this.serviceName,
          path,
          method,
          upstreamStatus: res.status,
          upstreamBody: parsed,
          ...(retryAfter !== undefined && retryAfter.trim() !== '' ? { retryAfter: retryAfter.trim() } : {}),
        });
      }
      throw new IntegrationError({
        code: codeForStatus(res.status),
        message: `${this.serviceName} ${method} ${path} returned ${res.status}`,
        service: this.serviceName,
        path,
        method,
        upstreamStatus: res.status,
        upstreamBody: parsed,
      });
    }

    return parsed as T;
  }

  /**
   * Proxy a Request through to the upstream, preserving method/body/streamed
   * response. Used for endpoints like chat completions that stream (and where
   * re-parsing as JSON would break semantics).
   */
  async proxy(req: Request, upstreamPath: string, opts: RequestOptions = {}): Promise<Response> {
    const method = req.method;
    const incoming = new URL(req.url);
    const url = `${this.buildUrl(upstreamPath)}${incoming.search}`;

    const contentType = req.headers.get('content-type');
    const accept = req.headers.get('accept');

    // Materialised up front, never streamed — and that is precisely what makes
    // the 401 replay below safe without any of `fetch()`'s `isReplayableBody`
    // reasoning. An ArrayBuffer can be handed to `fetch` any number of times; a
    // ReadableStream is one-shot, which is the only case that helper exists to
    // reject. `proxy()` therefore does NOT call it, and widening it is not a
    // prerequisite for anything here.
    // Refuse a tenantless call BEFORE touching the request body (WM#324): the
    // refusal must not depend on, or consume, anything the caller sent.
    this.assertTenantResolvable(undefined, upstreamPath, method);
    this.assertTenantBearer(upstreamPath, method);

    const body =
      method === 'GET' || method === 'DELETE' || method === 'HEAD'
        ? undefined
        : await req.arrayBuffer();

    // One attempt, with its OWN timeout budget. The timeout must be per-attempt:
    // a replay that inherited the first attempt's already-elapsed deadline could
    // abort before it had a chance to send anything.
    const sendOnce = async (
      credential: string | undefined,
      tenantCredential: string | undefined,
    ): Promise<Response> => {
      const headers = this.buildHeaders(
        undefined,
        credential,
        upstreamPath,
        method,
        tenantCredential,
      );
      if (contentType) headers.set('content-type', contentType);
      if (accept) headers.set('accept', accept);

      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      const ac = new AbortController();
      const timeoutHandle = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
      try {
        return await fetch(url, {
          method,
          headers,
          body,
          signal: opts.signal ?? ac.signal,
        });
      } catch (err) {
        const isAbort =
          err instanceof Error && (err.name === 'AbortError' || err.message === 'timeout');
        throw new IntegrationError({
          code: isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
          message: `${this.serviceName} ${isAbort ? 'timed out' : 'unreachable'}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          service: this.serviceName,
          path: upstreamPath,
          method,
          cause: err,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    const tenant = this.credentialTenant(undefined);
    let tenantCredential = await this.mintTenantCredential(tenant);
    const credential = await this.mintCredential(upstreamPath, method);
    let upstream = await sendOnce(credential, tenantCredential);

    // Tenant licence refused (see `fetch()`): drop it, replay ONCE.
    if (isAuthLayer401(upstream) && tenant !== undefined && tenantCredential !== undefined) {
      this.tenantCredentialProvider?.invalidate(tenant, tenantCredential);
      const freshTenant = await this.mintTenantCredential(tenant);
      if (freshTenant !== tenantCredential) {
        await upstream.body?.cancel().catch(() => {});
        tenantCredential = freshTenant;
        upstream = await sendOnce(credential, tenantCredential);
      }
    }

    // Same contract as `fetch()`: re-mint exactly once on 401. A 401 is the one
    // status where a replay is safe on ANY method including POST/DELETE — the
    // request was REFUSED, so no side effect landed upstream.
    //
    // Until 2026-08-27 this branch did not exist, so a proxy route wired to a
    // `credentialProvider` would surface a stale agent token as a hard 401 while
    // the identical call through `fetch()` recovered silently. No production
    // client hit it (`credentialProvider` is set only on the kanban client, which
    // makes no `proxy()` call), but the asymmetry was a trap for the next route.
    if (upstream.status === 401 && this.credentialProvider) {
      this.credentialProvider.invalidate();
      const fresh = await this.mintCredential(upstreamPath, method);
      // Nothing changed — the upstream is refusing the credential itself, not a
      // stale copy of it. Return the original 401 rather than spend a round trip
      // proving it twice.
      if (fresh !== undefined && fresh !== credential) {
        // Discard the rejected response body so its connection is released.
        await upstream.body?.cancel().catch(() => {});
        upstream = await sendOnce(fresh, tenantCredential);
      }
    }

    const responseHeaders = new Headers();
    const upstreamContentType = upstream.headers.get('content-type');
    if (upstreamContentType) responseHeaders.set('content-type', upstreamContentType);
    const cacheControl = upstream.headers.get('cache-control');
    if (cacheControl) responseHeaders.set('cache-control', cacheControl);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  /**
   * True when `passThroughBusy` would relay this response as UPSTREAM_BUSY
   * (429, or a 503 with a valid retry hint). Reads a CLONE, so the caller can
   * still consume the original body.
   */
  private async isBusyAnswer(res: Response): Promise<boolean> {
    if (!this.passThroughBusy || !BUSY_STATUS.has(res.status)) return false;
    if (res.status === 429) return true;
    const header = res.headers.get('retry-after');
    if (busyRetrySeconds(header, undefined) !== undefined) return true;
    let body: unknown;
    try {
      body = JSON.parse(await res.clone().text());
    } catch {
      return false;
    }
    return busyRetrySeconds(header, body) !== undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Can this body be handed to `fetch` a second time? Strings and no-body are
 * replayable; a stream or a one-shot source is not.
 */
function isReplayableBody(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string';
}

function codeForStatus(status: number): import('./errors').IntegrationErrorCode {
  if (status === 401) return 'UPSTREAM_UNAUTHORIZED';
  if (status === 402) return 'UPSTREAM_BYO_NOT_CONFIGURED';
  if (status === 403) return 'UPSTREAM_FORBIDDEN';
  if (status === 404) return 'UPSTREAM_NOT_FOUND';
  if (status === 409) return 'UPSTREAM_CONFLICT';
  return 'UPSTREAM_BAD_STATUS';
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  return new HttpClient(opts);
}

/**
 * A 401 that refused the LICENCE itself: `WWW-Authenticate` is EXACTLY
 * `Bearer` (scheme case-insensitive, no auth-params). worker_management
 * (fc661379) uses two challenges on purpose:
 *  - plain `Bearer` — the licence was refused (`_unauthorized_response`);
 *  - `Bearer error="invalid_token"` — the END-USER or CALLER token was refused
 *    (`_end_user_refused_response`, `_caller_token_invalid_response`), spelled
 *    that way precisely so a caller does NOT replay its licence.
 * A handler-level 401 with no challenge (WM `crud_endpoints.py` "Invalid API
 * credentials provided" for a provider key) is about neither. Only the first
 * form may invalidate, re-mint or replay.
 */
function isAuthLayer401(res: Response): boolean {
  if (res.status !== 401) return false;
  const challenge = res.headers.get('www-authenticate')?.trim().toLowerCase() ?? '';
  return challenge === 'bearer';
}
