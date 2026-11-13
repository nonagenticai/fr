// src/lib/licence-introspect.ts
//
// In-app verification of LICENCE TOKENS on `Authorization: Bearer`.
//
// Why this exists (George, 2026-10-10): the n8n conveyor runs in a customer's
// OWN n8n (and locally in docker) and reaches fr ONLY through the
// n8n-nodes-fr credential — `baseUrl` + licence token, sent as
// `Authorization: Bearer <licenseToken>`. fr's auth path understood only
// Keycloak JWTs (`keycloak.validateToken`) and otherwise trusted the
// `X-Subject-Id` that the istio license-authz gateway injects. fr is NOT behind
// that gateway's licence filter, and locally there is no gateway at all — so a
// licence token reaching fr had no path. fr now asks the licences service
// itself, exactly as the licences service's own reference middleware does
// (licenses `auth/middleware.py`).
//
// THE SHAPE RULE (copied from the reference, not invented here): a token is
// JWT-shaped iff it is exactly three NON-EMPTY dot-separated parts. A
// JWT-shaped token that fails verification is a hard 401 and is NEVER retried
// as a licence token — otherwise a forged/expired JWT would get a second,
// differently-shaped chance. Licence tokens are `secrets.token_urlsafe(32)`
// (base64url, no dots), so the two shapes cannot collide.
//
// FAIL CLOSED. A licences outage, 5xx, timeout or unparsable body throws —
// nothing is ever admitted on a guess. The error is an `IntegrationError`
// (502 UPSTREAM_UNREACHABLE / UPSTREAM_BAD_STATUS / UPSTREAM_BAD_BODY, 504
// UPSTREAM_TIMEOUT), the SAME choice `services/keycloak.ts jwksUnavailable`
// makes for a Keycloak JWKS outage: fr's own dependency failing is not the
// caller's fault and must not read as "your token is bad" (a 401 drives
// clients to discard a perfectly valid credential). An ANSWER that the token is
// not usable — `active:false`, a non-UUID `tenant_id` — is a 401.
//
// CACHE. Only POSITIVE results are cached, keyed on sha256(token) (the raw
// token is never a map key or a log value), for at most 60s and never past the
// token's own `token_expires_at` / the licence's `expires_at`. An `active:false`
// answer is never cached and evicts any entry for that token, so a revocation
// is seen on the next miss. The 60s ceiling is the revocation latency for a
// token that is still cached.
//
// Empty `config.services.licenses.baseUrl` ⇒ the licence path is DISABLED: a
// non-JWT-shaped bearer is a 401 exactly as before this module existed.

import { createHash } from 'node:crypto';

import { config } from '../config';
import { IntegrationError } from '../integrations/_lib/errors';
import { UnauthorizedError } from '../utils/errors';
import type { User } from '../types/api';

const INTROSPECT_PATH = '/license/introspect';
const INTROSPECT_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;
/** licenses `app.key` an fr credential must carry (= require-fr-license.ts FR_APP_KEY). */
const FR_LICENCE_APP_KEY = 'fr';
// Bounded so a flood of distinct valid tokens cannot grow the map without
// limit; on overflow the oldest insertion is dropped (Map keeps insert order).
const CACHE_MAX_ENTRIES = 1_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The identity a VERIFIED licence token resolves to. */
export interface LicenceIdentity {
  /** Introspected `tenant_id` — PINNED; no header may displace it. */
  tenantId: string;
  /** Introspected `license_id`. */
  licenseId: string | null;
  /**
   * The licences service's own `Subject.id` (`subject_id`). NOT a Keycloak
   * sub — this is the value the `X-Subject-Id` contract (inference-router
   * `billing_cost_events.subject_id`, licences endpoints) expects (fr#1052).
   */
  licenceSubjectId: string | null;
  /** `subject_keycloak_sub ?? subject_actor_sub ?? subject_id` — fr's own user id. */
  userId: string;
  appKey: string | null;
  planCode: string | null;
}

interface CacheEntry {
  identity: LicenceIdentity;
  expiresAtMs: number;
}

const _cache = new Map<string, CacheEntry>();
// One introspection per Request object: `buildRequestContext` and the route's
// `validateAuth` both resolve the same bearer. Without this a REFUSED token
// (never cached) would cost two upstream calls per request. Weak: no retention.
const _perRequest = new WeakMap<Request, Promise<LicenceIdentity>>();

function now(): number {
  return Date.now();
}

function baseUrl(): string {
  return (config.services.licenses.baseUrl ?? '').replace(/\/+$/, '');
}

/** Is the licence-token path configured at all? */
export function licencePathEnabled(): boolean {
  return baseUrl().length > 0;
}

/**
 * The reference shape rule: exactly three NON-EMPTY dot-separated parts.
 * `a..c`, `.b.c`, `a.b.` and two- or four-part strings are NOT JWT-shaped.
 */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function cacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function epochMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function upstreamFailure(
  code: 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNREACHABLE' | 'UPSTREAM_BAD_STATUS' | 'UPSTREAM_BAD_BODY',
  message: string,
  extra: { upstreamStatus?: number; loggedStatus?: number; cause?: unknown } = {},
): IntegrationError {
  // The detail goes to the LOG, never into `message`: this is raised before
  // the caller has authenticated (same policy as keycloak `jwksUnavailable`).
  const detail =
    extra.cause instanceof Error ? extra.cause.message : `status ${extra.loggedStatus ?? '?'}`;
  console.warn(`[licence-introspect] ${code} on ${INTROSPECT_PATH}: ${detail}`);
  return new IntegrationError({
    code,
    message,
    service: 'licenses',
    method: 'POST',
    path: INTROSPECT_PATH,
    ...(extra.upstreamStatus !== undefined ? { upstreamStatus: extra.upstreamStatus } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
  });
}

/**
 * Introspect a NON-JWT-shaped bearer against the licences service.
 *
 * Resolves the verified identity, or throws:
 *  - `UnauthorizedError` (401) — licence path disabled, `active !== true`, or a
 *    `tenant_id` that is not a UUID (an answer: the token is not usable here);
 *  - `IntegrationError` (502/504) — licences unreachable, timed out, 5xx/other
 *    non-200, or an unparsable body (no answer: fail closed).
 */
export async function introspectLicenceToken(token: string): Promise<LicenceIdentity> {
  const base = baseUrl();
  if (!base) throw new UnauthorizedError('Invalid or expired token');

  const key = cacheKey(token);
  const hit = _cache.get(key);
  if (hit) {
    if (hit.expiresAtMs > now()) return hit.identity;
    _cache.delete(key);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${INTROSPECT_PATH}`, {
      method: 'POST',
      // The token rides BOTH in the body (the licences contract) and as the
      // bearer: the HOSTED route (api.nonagentic.ai/licenses, behind the
      // istio license-authz gateway) refuses a call with no Authorization
      // (401 "Bearer token required") before it reaches the licences service.
      // In-cluster (licenses.example.com) the header is ignored — harmless.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw upstreamFailure('UPSTREAM_TIMEOUT', 'licence introspection timed out', { cause: err });
    }
    throw upstreamFailure('UPSTREAM_UNREACHABLE', 'licence introspection is unavailable', {
      cause: err,
    });
  }

  if (response.status === 401 || response.status === 403) {
    // The hosted gateway (license-authz in front of api.nonagentic.ai/licenses)
    // authenticates the bearer (= this very token) before the licences service
    // sees it, and ANSWERS for it: measured 2026-10-10, no bearer ⇒ 401 "Bearer
    // token required"; an unknown token ⇒ 403 {"error":"license_invalid",
    // "reason":"token_not_found"}. Both are verdicts on the token, exactly like
    // `{active:false}` — same handling: 401 to the caller, never cached, any
    // stale entry evicted. (In-cluster the licences service answers an unknown
    // token 200 {active:false} and never sends these.) 402 (quota) is NOT a
    // verdict on the token and stays a fail-closed gateway fault below.
    _cache.delete(key);
    throw new UnauthorizedError('Invalid or expired token');
  }

  if (response.status !== 200) {
    // Every other non-200 is "no answer". The licences service answers an unknown
    // token with 200 `{active:false}`, so a 4xx here is a contract break, not
    // a verdict on the token — fail closed as a gateway fault, never admit.
    // `upstreamStatus` is attached only for a 5xx: `httpStatusFor` passes an
    // upstream 4xx through to the caller, and a licences 404 (wrong base URL)
    // is fr's fault, not the caller's — omitted, it maps to 502.
    throw upstreamFailure('UPSTREAM_BAD_STATUS', 'licence introspection is unavailable', {
      loggedStatus: response.status,
      ...(response.status >= 500 ? { upstreamStatus: response.status } : {}),
    });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch (err) {
    throw upstreamFailure('UPSTREAM_BAD_BODY', 'licence introspection returned an unreadable answer', {
      cause: err,
    });
  }

  const tenantId = str(body.tenant_id);
  if (body.active !== true || !tenantId || !UUID_RE.test(tenantId)) {
    // Never cached; evict anything stale for this token (a revocation must be
    // seen on the very next call, not after the TTL).
    _cache.delete(key);
    throw new UnauthorizedError('Invalid or expired token');
  }

  const licenceSubjectId = str(body.subject_id);
  // ⛔ A LICENCE IS A TENANT CREDENTIAL, NOT A PERSON (George 2026-10-10: a
  // tenant holds the licence; its members are member or tenant-admin). The
  // caller's id is the licences Subject.id — never `subject_keycloak_sub` —
  // so no human's user_roles / tenant-admin grant can attach to a licence:
  // licence callers are member-level, always.
  const userId = licenceSubjectId && UUID_RE.test(licenceSubjectId) ? licenceSubjectId : null;
  if (!userId) {
    // A licence that names no subject at all cannot be attributed to anyone.
    _cache.delete(key);
    throw new UnauthorizedError('Invalid or expired token');
  }
  const app = body.app as Record<string, unknown> | null | undefined;
  const plan = body.plan as Record<string, unknown> | null | undefined;
  const appKey = app && typeof app === 'object' ? str(app.key) : null;
  // ⛔ AUDIENCE. An active licence for ANOTHER app (w2v, kag, …) is not an fr
  // credential. license-authz binds app.key to the route (`_check_app_route`);
  // fr has no gateway in front of it, so it binds here. Same key as
  // require-fr-license.ts FR_APP_KEY (licenses `app.key`, 22 active 2026-10-10).
  if (appKey !== FR_LICENCE_APP_KEY) {
    _cache.delete(key);
    throw new UnauthorizedError('Invalid or expired token');
  }
  const identity: LicenceIdentity = {
    tenantId,
    licenseId: str(body.license_id),
    licenceSubjectId,
    userId,
    appKey,
    planCode: plan && typeof plan === 'object' ? str(plan.code) : null,
  };

  // TTL: 60s, clipped to whichever of the token / licence expiry comes first.
  // An expiry already in the past means "do not cache" (the answer was still
  // `active:true`, so it is served once, but never reused).
  const t = now();
  let expiresAtMs = t + CACHE_TTL_MS;
  for (const e of [epochMs(body.token_expires_at), epochMs(body.expires_at)]) {
    if (e !== null && e < expiresAtMs) expiresAtMs = e;
  }
  if (expiresAtMs > t) {
    if (_cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = _cache.keys().next().value;
      if (oldest !== undefined) _cache.delete(oldest);
    }
    _cache.set(key, { identity, expiresAtMs });
  }
  return identity;
}

/**
 * `introspectLicenceToken`, memoised per Request object (see `_perRequest`).
 * A rejected promise is memoised too: the same request gets the same answer.
 */
export function introspectLicenceForRequest(
  req: Request,
  token: string,
): Promise<LicenceIdentity> {
  const prior = _perRequest.get(req);
  if (prior) return prior;
  const p = introspectLicenceToken(token);
  _perRequest.set(req, p);
  return p;
}

/**
 * Should this bearer take the licence path? Non-JWT-shaped AND the path is
 * configured. A JWT-shaped token never does (the reference rule).
 */
export function isLicenceBearer(token: string | undefined): token is string {
  return typeof token === 'string' && token.length > 0 && !looksLikeJwt(token) && licencePathEnabled();
}

/**
 * The `User` a licence caller authenticates as.
 *
 * ROLES ARE EMPTY ON PURPOSE — member level only. A licence token is a
 * machine credential held by a customer's n8n; it must never carry a
 * privileged realm role (`aa-orchestrator`, `super_admin`, `tenant_admin`,
 * `card_approver`, `execution_signoff`, …). Privilege comes from fr's own
 * `user_roles` table, as for any member, never from this object.
 *
 * `tenantClaim` is set to the introspected tenant: it is server-verified (the
 * licences service answered for it), and the tenant-pinned checks that read
 * it (`lib/service-card-tenant.ts`) must see the licence's tenant. The realm
 * `tenant_admin` arm also reads it, but only together with a role this user
 * cannot have.
 */
export function licenceUser(identity: LicenceIdentity, delegatedTenantId?: string): User {
  // A delegated call acts as the CARD's tenant everywhere downstream:
  // `project-access.ts` derives `licenceTenantId` from `tenantId`, and
  // `service-card-tenant.ts` compares against `tenantClaim`. Both must see the
  // effective tenant, or the delegation would be half-applied — frame
  // delegated, scoping still at home.
  const tenantId = delegatedTenantId ?? identity.tenantId;
  return {
    id: identity.userId,
    email: '',
    name: '',
    roles: [],
    tenantId,
    tenantClaim: tenantId,
    isServiceAccount: false,
    authKind: 'licence',
    licenceSubjectId: identity.licenceSubjectId ?? undefined,
    licenseId: identity.licenseId ?? undefined,
  };
}

/**
 * The licence delegation lane.
 *
 * A licence resolves to ONE tenant — the tenant it was issued to — and that is
 * the point of the credential: `licenceUser()` pins the tenant and
 * `project-access.ts` refuses to point a licence at another workspace. The
 * conveyor is the case that cannot live with that: ONE n8n instance drives the
 * cards of MANY tenants and holds one licence per app, not one per tenant, so
 * every tenant-scoped read lands in the conveyor's own tenant.
 *
 * This lane lets a NAMED licence subject act for the card's tenant. It is
 * deliberately NARROWER than the `aa-orchestrator` `X-Tenant-Id` override that
 * fr#1437 removed (that keyed on a realm role, so any role holder could name
 * any well-formed tenant with no membership test — and a licence can never hold
 * a realm role, so it could not have used it anyway):
 *   - the caller must be a LICENCE (never a user JWT),
 *   - whose `licenceSubjectId` is in `AUTH_DELEGATING_SUBJECTS` (unset ⇒ nobody),
 *   - naming a well-formed tenant uuid that differs from its own.
 *
 * Anything else is IGNORED and the caller keeps its own tenant, exactly as
 * before: a header that does not qualify is never an error, because a licence
 * that does not delegate has to keep working unchanged.
 */
export const DELEGATION_TENANT_HEADERS = ['X-Effective-Tenant-Id', 'X-Tenant-Id'] as const;

const DELEGATION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `AUTH_DELEGATING_SUBJECTS` — comma-separated licences `Subject.id`s. */
export function delegatingLicenceSubjects(): ReadonlySet<string> {
  return new Set(
    (process.env.AUTH_DELEGATING_SUBJECTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * The tenant this request may act for, when — and only when — the caller is an
 * allowlisted licence naming a different, well-formed tenant. `undefined` means
 * "no delegation": use the licence's own tenant.
 */
export function resolveDelegatedTenant(
  req: Request,
  licence: LicenceIdentity | null,
): string | undefined {
  if (!licence) return undefined;
  const subject = licence.licenceSubjectId?.trim().toLowerCase();
  if (!subject || !delegatingLicenceSubjects().has(subject)) return undefined;
  const raw = DELEGATION_TENANT_HEADERS.map(
    (h) => req.headers.get(h) ?? req.headers.get(h.toLowerCase()),
  ).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const value = raw?.trim();
  if (!value || !DELEGATION_UUID_RE.test(value)) return undefined;
  if (value.toLowerCase() === licence.tenantId.trim().toLowerCase()) return undefined;
  return value.toLowerCase();
}
