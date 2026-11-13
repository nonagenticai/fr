import {
  mapPlankaError,
  PlankaAuthError,
  PlankaNetworkError,
  PlankaTokenNotCachedError,
  PlankaWriteOutcomeUnknownError,
} from './errors';
import type { PlankaAuth } from './auth';
import { assertPlankaCardBodyCarriesNoEvidence } from './description-guard';

// Exported so a derived timeout budget elsewhere (services/improvement-cards/create-lease.ts)
// binds to THIS constant instead of copying its value and silently drifting.
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Encode a single path segment for inclusion in a Planka resource URL.
 * Resource classes MUST wrap caller-supplied ids with this — a raw id
 * containing `/` or `?` would otherwise misroute.
 */
export function encodePath(segment: string | number): string {
  return encodeURIComponent(String(segment));
}

/** The wire body as Planka will parse it — what the evidence guard walks (fr#1359). */
const parseWire = (serialized: string | undefined): unknown =>
  serialized === undefined ? undefined : JSON.parse(serialized);

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * ONE attempt, nothing else: no GET network retry, no 401
   * invalidate-and-retry, and no auth-state change (a 401 does not invalidate
   * the cached token — that would make the caller's NEXT call log in, i.e. a
   * login under the caller's lock; the next normal-policy request refreshes on
   * its own 401). For callers that hold a
   * scarce resource across the call — routes/cards/priority.ts holds a pooled
   * Postgres connection and a per-card lock — where a retry or a re-login
   * would stretch the hold. Default false: global behaviour is unchanged.
   */
  singleAttempt?: boolean;
}

/**
 * A per-client request policy (PlankaClient.withRequestPolicy): applied to
 * EVERY request that client makes, on top of the call's own options.
 * `timeoutMs` can only TIGHTEN a call's timeout; `singleAttempt` can only turn
 * retries OFF.
 */
export interface RequestPolicy {
  timeoutMs?: number;
  singleAttempt?: boolean;
  /**
   * Use ONLY an already-cached token: never log in. No cached
   * token → PlankaTokenNotCachedError before anything is sent. For callers
   * holding a lock (routes/cards/priority.ts): a login there would run under
   * the lock with auth.ts's own timeout, outside this policy's bound. The
   * caller is expected to have warmed the SAME PlankaAuth (shared by
   * withRequestPolicy) with a normal-policy request before taking the lock.
   */
  cachedTokenOnly?: boolean;
}

export class PlankaHttp {
  constructor(
    private readonly auth: PlankaAuth,
    readonly baseUrl: string,
    /** Applied to every request (PlankaClient.withRequestPolicy builds a policied transport in index.ts). */
    readonly policy: RequestPolicy = {},
  ) {}

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    // fr#1338: the TRANSPORT is a chokepoint too. Every write body is checked
    // here whatever its path, so a caller that reaches `plankaClient.http`
    // directly (11 modules read through it) cannot put repro evidence on the
    // wire by building the card URL itself. Before the URL, the token, the fetch.
    // fr#1359: the guard walks EVERY string value and key of the body (comment
    // text, names, custom-field values), not only `description`.
    //
    // fr#1359 follow-up: the walk runs over WHAT GOES ON THE WIRE, not over the
    // caller's object. `JSON.stringify` honours `toJSON()`, getters, and drops
    // non-enumerable properties, so a walk of the raw object can see nothing
    // while the serialized body carries the key. Serialize ONCE, walk the
    // re-parsed wire body, and send exactly that same string — what is checked
    // is byte-identical to what is sent.
    const serialized = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (method !== 'GET') assertPlankaCardBodyCarriesNoEvidence(parseWire(serialized));
    const url = this.buildUrl(path, opts.query);
    const timeoutMs = tighter(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, this.policy.timeoutMs)!;
    const singleAttempt = opts.singleAttempt === true || this.policy.singleAttempt === true;
    const cachedTokenOnly = this.policy.cachedTokenOnly === true;
    // Every request is fr's one configured Planka account (auth.ts): its session JWT.
    const doFetch = async (token: string): Promise<Response> => {
      try {
        return await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(opts.headers ?? {}),
          },
          body: serialized,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new PlankaNetworkError(`Network failure on ${method} ${path}: ${String(err)}`, { path, cause: err });
      }
    };

    // Retry idempotent GETs ONCE on a transient network failure (connection
    // reset, brief upstream blip, or a timeout abort) — a single Planka hiccup
    // shouldn't surface to the user as a 502. Mutations are never retried (a
    // half-applied POST/PATCH/DELETE must not be replayed).
    const fetchResilient = async (token: string): Promise<Response> => {
      try {
        return await doFetch(token);
      } catch (err) {
        if (!singleAttempt && method === 'GET' && err instanceof PlankaNetworkError) {
          await new Promise((r) => setTimeout(r, 250));
          return await doFetch(token);
        }
        throw err;
      }
    };

    let token: string;
    if (cachedTokenOnly) {
      const cached = this.auth.cachedAgentToken();
      if (cached === null) {
        throw new PlankaTokenNotCachedError(
          `No cached Planka agent token for ${method} ${path} (cachedTokenOnly: refusing to log in)`,
          { path },
        );
      }
      token = cached;
    } else {
      token = await this.auth.agentToken();
    }

    let response = await fetchResilient(token);

    if (response.status === 401) {
      // singleAttempt: fail now — no invalidate, no re-login, no retry.
      // Every request is signed with fr's own agent token, so a 401 is always
      // an ops-side credential fault; stamp it so `statusForPlankaError` maps it
      // to 502 rather than telling an authenticated caller to re-authenticate.
      if (singleAttempt) {
        throw new PlankaAuthError('Planka rejected the token (single attempt: no refresh-retry)', {
          status: 401,
          path,
          credentialSource: 'agent',
        });
      }
      this.auth.invalidateAgent();
      response = await fetchResilient(await this.auth.agentToken());
      if (response.status === 401)
        throw new PlankaAuthError('Planka rejected refreshed token', {
          status: 401,
          path,
          credentialSource: 'agent',
        });
    }

    // ── ⭐ A 403 DOES NOT RE-AUTHENTICATE. DECIDED, NOT OVERLOOKED. ──────────
    // The asymmetry with the 401 branch above is deliberate and this comment is
    // the record of why, so the next reader does not "fix" it.
    //
    //  1. A 403 means the token was ACCEPTED. Planka's `isAuthenticated` policy
    //     answers 401 `E_UNAUTHORIZED` for a missing/invalid/expired token;
    //     authorization refusals answer 403 `E_NOT_ENOUGH_PERMISSIONS`. So a
    //     403 is "authenticated, not permitted", and re-minting the SAME service
    //     account yields a token with the SAME permissions. The retry is
    //     guaranteed to fail identically — it can only ever cost a round-trip.
    //
    //  2. ⛔ NOT EVERY 403 HERE IS EVEN PLANKA'S. `mapPlankaError` explicitly
    //     handles a 403 whose body is plain text from an upstream hop — "RBAC:
    //     access denied" from Istio ztunnel, or cloudflared/nginx. A mesh deny
    //     refuses EVERY request to that destination, the login POST included, so
    //     re-auth-on-403 would turn one user request into two upstream requests
    //     for the whole duration of the outage. That is amplification aimed at a
    //     dependency that is already refusing — the exact shape that takes a
    //     wobbling Planka down, and Planka going down costs the estate ~3 minutes
    //     with zero cards. A retry policy must never raise load on the failure it
    //     is reacting to.
    //
    //  3. It would MASK a real permission problem. The agent token is
    //     process-wide; if fr's board membership is revoked, a silent re-auth +
    //     retry hides that behind a slower, identical 403 while
    //     `statusForPlankaError` still emits 403 to the caller. The operator
    //     loses the signal and gains latency.
    //
    //  4. The one 403 that genuinely IS a credential state — Planka's
    //     `{ step: 'accept-terms' }` — is raised only by `POST /api/access-tokens`
    //     during LOGIN, never on a resource path, and `auth.ts loginAgent`
    //     already handles it there.
    //
    // ── AND THE "AGENT TOKEN HAS NO TTL / NO REFRESH TIMER" IS NOT A HOLE ───
    // `PlankaAuth.agentTokenCache` is held with no expiry. That is fine, and a
    // refresh timer would be worse than what is here: a token that has gone
    // stale (expired, revoked, agent locked) is rejected with **401**, and the
    // branch immediately above already invalidates and re-mints ONCE, on demand,
    // driven by the actual failure. Refresh-on-demand strictly dominates a
    // timer — a timer re-logs-in on a schedule whether or not anything is wrong
    // (extra upstream calls with no failure to justify them) and STILL cannot
    // cover a token revoked between two ticks. So: no TTL is added, and 403
    // falls through to `mapPlankaError` unchanged.
    if (!response.ok) throw await mapPlankaError(response, path);

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (err) {
      // A WRITE whose 2xx status line already arrived: Planka answered
      // success, so the write is presumed APPLIED whatever broke afterwards
      // (body read, JSON parse, the abort deadline mid-body). Under the
      // single-attempt policy (callers that compensate under a lock) this is
      // typed so it can never be mistaken for "not applied". Other callers
      // keep the raw error they always got.
      if (singleAttempt && method !== 'GET') {
        throw new PlankaWriteOutcomeUnknownError(
          `Planka answered ${response.status} to ${method} ${path} but the response body failed: ${String(err)}`,
          { status: response.status, path, cause: err },
        );
      }
      throw err;
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const base = `${this.baseUrl}${path}`;
    if (!query) return base;
    const qs = Object.entries(query)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return qs ? `${base}?${qs}` : base;
  }
}

/** Combine two policies: the tighter timeout; single-attempt / cached-token-only if either asks. */
export function mergeRequestPolicy(a: RequestPolicy, b: RequestPolicy): RequestPolicy {
  return {
    timeoutMs: tighter(a.timeoutMs, b.timeoutMs),
    singleAttempt: a.singleAttempt === true || b.singleAttempt === true,
    cachedTokenOnly: a.cachedTokenOnly === true || b.cachedTokenOnly === true,
  };
}

/** The smaller of two optional timeouts (undefined = no bound from that side). */
function tighter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}
