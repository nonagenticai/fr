// src/services/keycloak.ts
import {
  jwtVerify,
  decodeJwt,
  createRemoteJWKSet,
  errors as joseErrors,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import {
  config,
  frConveyorIssuers,
  isServiceOnlyIssuer,
  keycloakTrustedIssuers,
  realmOfIssuer,
} from '../config';
import { isConveyorActor } from '../lib/conveyor-identity';
import { superAdminSessionTrustFromClaims } from '../lib/super-admin-session-trust';
import type { User } from '../types/api';
import { UnauthorizedError } from '../utils/errors';
import { ServiceAuthenticator } from '../lib/service-auth';
import { getSecureAppsAuthenticator } from '../lib/service-authenticators';
import {
  deriveTenantId,
  deriveTenantName,
  isServiceAccountClaims,
  isValidUuid,
} from '../utils/tenant';
import {
  IntegrationError,
  isIntegrationError,
  reportSwallowedFailure,
} from '../integrations/_lib/errors';
import { recordKeycloakUserLookup } from '../lib/keycloak-lookup-metrics';
import { holdsRealmTenantAdminRole, REALM_TENANT_ADMIN_ROLE } from '../lib/realm-tenant-admin-roles';

/**
 * A jose JWKS resolver — either remote (`createRemoteJWKSet`) or local
 * (`createLocalJWKSet`). Both satisfy `JWTVerifyGetKey`.
 */
type JWKSResolver = JWTVerifyGetKey;

let realmRemoteJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Module-level realm JWKS resolver. Exported for reuse by middleware that
 * needs to verify tokens outside the per-request `KeycloakService` (e.g.
 * `middleware/request-context.ts` derives ALS-frame claims from the bearer
 * before any route runs `validateAuth`).
 *
 * ⚠️ LAZY on purpose (fr#1597). The remote set is built on the FIRST key
 * lookup, not at module load: `new URL('/realms/…')` throws ERR_INVALID_URL
 * when KEYCLOAK_URL is empty (dev/test/CI guard steps), and this module sits
 * under `middleware/request-context.ts`, which half the backend imports for
 * `ctxTenantId`. An eager construction made every such import — e.g. a CI
 * guard step, which declares no Keycloak env — crash at load. Runtime behaviour is identical: one `createRemoteJWKSet`
 * per process, same URL, same jose cache, built before the first verify.
 * Pinned by tests/unit/services/keycloak-jwks-lazy.test.ts.
 */
export const defaultJWKS: JWKSResolver = (protectedHeader, token) => {
  realmRemoteJWKS ??= createRemoteJWKSet(
    new URL(`${config.keycloak.url}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`)
  );
  return realmRemoteJWKS(protectedHeader, token);
};

// ── Realm-per-app F1: a LIST of trusted issuers (mirrors commonpractice #480) ──────────────────

/**
 * The JWKS URL for a trusted issuer. Keys are fetched through KEYCLOAK_URL (the in-cluster service),
 * never the public issuer host — only the REALM is taken from the issuer. For the default issuer
 * (KEYCLOAK_ISSUER) this is byte-identical to the URL `defaultJWKS` has always used.
 */
function jwksUrlForIssuer(issuer: string): string {
  if (issuer === config.keycloak.issuer) {
    return `${config.keycloak.url}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`;
  }
  const realm = realmOfIssuer(issuer);
  return realm
    ? `${config.keycloak.url}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`
    : `${issuer}/protocol/openid-connect/certs`;
}

// One lazily-built remote JWKS per NON-default trusted issuer (the default one is `defaultJWKS`).
// Only issuers that passed the allowlist ever get an entry, so a caller cannot grow this map by
// minting tokens with arbitrary `iss` values.
const issuerRemoteJWKS = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The JWKS resolver for a TRUSTED issuer. Callers must have checked the allowlist first. */
export function jwksForIssuer(issuer: string): JWKSResolver {
  if (issuer === config.keycloak.issuer) return defaultJWKS;
  let r = issuerRemoteJWKS.get(issuer);
  if (!r) {
    r = createRemoteJWKSet(new URL(jwksUrlForIssuer(issuer)));
    issuerRemoteJWKS.set(issuer, r);
  }
  return r;
}

/** A refused token (untrusted issuer, service realm on a user route, impostor conveyor): always a 401. */
function refuse(event: string, iss: string): never {
  // warn, not error: `iss` is attacker-controlled, so this must not page anyone — but a drifted
  // allowlist (realm rename, host change) shows up here with the offending issuer named.
  console.warn(`[keycloak] ${event} iss=${iss.slice(0, 200)}`);
  throw new UnauthorizedError('Invalid or expired token');
}

function conveyorShaped(claims: Record<string, unknown>): boolean {
  const ra = claims.realm_access;
  const roles =
    ra && typeof ra === 'object' && Array.isArray((ra as { roles?: unknown }).roles)
      ? ((ra as { roles: unknown[] }).roles.filter((r): r is string => typeof r === 'string'))
      : [];
  return isConveyorActor({
    ...(typeof claims.azp === 'string' ? { azp: claims.azp } : {}),
    ...(typeof claims.preferred_username === 'string' ? { username: claims.preferred_username } : {}),
    roles,
  });
}

interface VerifyKeycloakJwtOptions {
  /**
   * Accept a KEYCLOAK_SERVICE_ONLY_REALMS (default `secure-apps`) token. ONLY the service doors pass
   * this (bridge, signup intake/decider), and each then pins its own issuer. Without it such a token
   * is refused — except the conveyor-priority identity from exactly FR_CONVEYOR_ISSUER.
   */
  allowServiceRealms?: boolean;
  /** Extra jwtVerify options (audience, algorithms, requiredClaims). `issuer` is always set here. */
  verify?: Omit<NonNullable<Parameters<typeof jwtVerify>[2]>, 'issuer'>;
}

/**
 * Verify a Keycloak JWT against the trusted-issuer list. The UNVERIFIED `iss` only SELECTS which
 * allowlisted realm's keys to use; `jwtVerify` then pins `issuer` to that exact value, so a token
 * cannot borrow one realm's key for another realm's claims. A non-allowlisted `iss` is refused with
 * no JWKS fetch. With no issuer configured at all (dev/test without KEYCLOAK_URL) this is exactly the
 * legacy single-issuer call.
 *
 * Throws `UnauthorizedError` for refusals; jose errors propagate (callers classify them).
 */
export async function verifyKeycloakJwt(
  token: string,
  opts: VerifyKeycloakJwtOptions = {},
): Promise<{ payload: JWTPayload & Record<string, unknown>; issuer: string }> {
  const trusted = keycloakTrustedIssuers();
  if (trusted.length === 0) {
    const { payload } = await jwtVerify(token, defaultJWKS, {
      ...opts.verify,
      issuer: config.keycloak.issuer,
    });
    return { payload: payload as JWTPayload & Record<string, unknown>, issuer: String(payload.iss ?? '') };
  }
  let iss: string;
  try {
    const claimed = decodeJwt(token).iss;
    if (typeof claimed !== 'string' || claimed.length === 0) throw new Error('no iss');
    iss = claimed;
  } catch {
    // Not a JWT / no `iss`: the client's fault, a quiet 401.
    throw new UnauthorizedError('Invalid or expired token');
  }
  if (!trusted.includes(iss)) refuse('token_issuer_not_trusted', iss);
  const serviceOnly = isServiceOnlyIssuer(iss);
  const conveyorIssuers = frConveyorIssuers();
  if (serviceOnly && !opts.allowServiceRealms && !conveyorIssuers.includes(iss)) {
    refuse('token_service_realm_on_user_route', iss);
  }
  const resolver = jwksForIssuer(iss);
  const { payload } = await jwtVerify(token, resolver, {
    ...opts.verify,
    issuer: iss,
  });
  const claims = payload as JWTPayload & Record<string, unknown>;
  const conveyor = conveyorShaped(claims);
  // FR_CONVEYOR_ISSUER pin: a same-named conveyor client in any other trusted realm (an app realm's
  // admin could create one) must never stand in for the conveyor.
  if (conveyor && !conveyorIssuers.includes(iss)) refuse('conveyor_identity_wrong_issuer', iss);
  // A service-only-realm token on a user route is honoured ONLY as the conveyor identity.
  if (serviceOnly && !opts.allowServiceRealms && !conveyor) refuse('token_service_realm_on_user_route', iss);
  return { payload: claims, issuer: iss };
}

// Service authenticator for Keycloak admin API calls (client credentials flow)
let adminAuth: ServiceAuthenticator | null = null;

/**
 * Lazily-constructed singleton `ServiceAuthenticator` for admin-API calls.
 * Exported so sibling modules (e.g. `keycloak-admin.ts`) can reuse the same
 * client-credentials cache instead of minting a second authenticator (which
 * would double the token-fetch traffic and fragment retry/expiry logic).
 */
/** The admin-API collection every reverse identity lookup below hits. */
const USERS_PATH = '/admin/realms/{realm}/users';
/** Direct realm-role mappings of one user. */
const USER_REALM_ROLE_MAPPINGS_PATH = '/admin/realms/{realm}/users/{id}/role-mappings/realm';
/**
 * EFFECTIVE realm roles of one user — direct mappings expanded through
 * composites AND group mappings. Same `view-users` permission as the direct one.
 */
const USER_REALM_ROLE_MAPPINGS_COMPOSITE_PATH =
  '/admin/realms/{realm}/users/{id}/role-mappings/realm/composite';
/** One user's representation (attributes, enabled). */
const USER_PATH = '/admin/realms/{realm}/users/{id}';
/** One realm role's representation — read before a role-mapping write. */
const REALM_ROLE_PATH = '/admin/realms/{realm}/roles/{role}';
/** Ends every session of one user (`manage-users`). */
const USER_LOGOUT_PATH = '/admin/realms/{realm}/users/{id}/logout';

/**
 * Per-tenant cache of SUCCESSFUL `listRealmTenantAdminIds` results. Errors are
 * never cached — "could not ask" must be re-asked on the next call. 60s bounds
 * how long a role grant/revoke in Keycloak takes to reach recipient lists.
 */
const REALM_TENANT_ADMIN_CACHE_TTL_MS = 60_000;
const realmTenantAdminCache = new Map<string, { at: number; ids: string[] }>();

/** Drop the cached admin list for one tenant, or for every tenant when omitted. */
export function invalidateRealmTenantAdminCache(tenantId?: string): void {
  if (tenantId === undefined) realmTenantAdminCache.clear();
  else realmTenantAdminCache.delete(tenantId);
}

/**
 * Per-tenant cache of SUCCESSFUL `listTenantUserIds` results (P1-TEAM-b) — its OWN
 * cache, not the admin one: the two lists answer different questions and are
 * invalidated by different events (a role grant vs a re-homing). Errors are never
 * cached. 60s bounds how long a Keycloak re-homing takes to reach a recipient list;
 * safety decisions pass `{ fresh: true }` and never read it.
 */
const TENANT_USER_CACHE_TTL_MS = 60_000;
const tenantUserCache = new Map<string, { at: number; ids: string[] }>();

/** Drop the cached tenant user list for one tenant, or for every tenant when omitted. */
export function invalidateTenantUserCache(tenantId?: string): void {
  if (tenantId === undefined) tenantUserCache.clear();
  else tenantUserCache.delete(tenantId);
}

/**
 * Every reverse identity lookup in this file answers one of THREE things, and
 * the caller has to be able to tell them apart:
 *
 *   - a user id                 → this address belongs to that account
 *   - `null`                    → the directory answered, and nobody matched
 *   - a thrown IntegrationError → the directory could not answer at all
 *
 * ⚠️ The third case used to be folded into the second, and it reached a user.
 * `dispatchInbound` (`src/channels/index.ts`) replies to an unresolved sender
 * with *"I couldn't identify your account. Please link your channel address to
 * your account first."* — so a Keycloak outage told every inbound Telegram /
 * Teams / email sender to go and perform a linking step they had already done
 * and which would not have helped. An outage and an unregistered address must
 * not render as the same sentence.
 *
 * A COLLISION still returns `null` deliberately, and that is not the same
 * defect: there the directory DID answer, and naming the wrong user is worse
 * than naming none.
 */
function identityLookupUnavailable(args: {
  op: string;
  status?: number;
  cause?: unknown;
  /** Admin-API path template the failed request hit; defaults to the users collection. */
  path?: string;
  /** HTTP method of the failed request; defaults to GET. The tenant_admin
   *  write-through (fr#1289) reports its POST/DELETE here so a failed write is
   *  never logged as a read. */
  method?: 'GET' | 'POST' | 'DELETE';
}): IntegrationError {
  const { op, status, cause, path = USERS_PATH, method = 'GET' } = args;
  if (status !== undefined) {
    return new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: `keycloak ${op} failed with ${status}`,
      service: 'keycloak',
      method,
      path,
      upstreamStatus: status,
    });
  }
  return new IntegrationError({
    code: 'UPSTREAM_UNREACHABLE',
    message: `keycloak ${op} could not reach the server: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    service: 'keycloak',
    method,
    path,
    cause,
  });
}

/**
 * `getAdminAuth()` for the lookup family. Unconfigured admin credentials is a
 * SERVER problem, not "nobody matched" — same call `searchUsers` makes.
 */
function adminAuthOrUnavailable(op: string): ServiceAuthenticator {
  try {
    return getAdminAuth();
  } catch (err) {
    throw new IntegrationError({
      code: 'SERVICE_AUTH_FAILED',
      message: `keycloak admin credentials are not configured — ${op} is unavailable`,
      service: 'keycloak',
      method: 'GET',
      path: USERS_PATH,
      cause: err,
    });
  }
}

/**
 * The second realm most `subject_id`s minted by the licenses registry actually
 * live in.
 *
 * ⚠️ ROOT CAUSE of the "raw UUID in every Person cell" defect (measured
 * 2026-09-24): `getUserById` queried ONLY `config.keycloak.realm` ("portal").
 * The licenses registry's own `subject.keycloak_realm` breakdown
 * (`nonagenticai/licenses` `models.py` ~L938, ~L3536-3546) is `secure-apps`
 * 166 / `service` 58 / `portal` 28 of 254 — the MAJORITY of subject_ids are
 * `secure-apps`-realm principals, and that repo's own docstring names several
 * as "genuine humans". Live `fr_keycloak_user_lookup_total` confirms the
 * portal-realm client itself works (`found` is nonzero) while `not_found`
 * dominates (375 vs 27, zero `admin_auth_failed`) — real 404s from the WRONG
 * realm, not a broken credential. This is the untested hypothesis
 * `lib/keycloak-lookup-metrics.ts` already names; this is that fix.
 *
 * Returns null when no DISTINCT secure-apps realm is configured (dev/test,
 * where `KEYCLOAK_SECURE_APPS_REALM` is unset and defaults to the same realm
 * as `config.keycloak.realm` — retrying that realm would just repeat the same
 * 404 and double-count the metric for no gain).
 */
function secondaryRealm(): { realm: string; auth: ServiceAuthenticator } | null {
  const realm = process.env.KEYCLOAK_SECURE_APPS_REALM || config.keycloak.userRealm;
  if (!realm || realm === config.keycloak.userRealm) return null;
  return { realm, auth: getSecureAppsAuthenticator() };
}

/**
 * A short-lived memo of ids CONFIRMED absent from every realm `getUserById`
 * knows to try (portal, then — on a clean 404 — secure-apps).
 *
 * ⚠️ WHY THIS EXISTS. The cross-realm fallback above doubles the cost of
 * every MISS to two admin round-trips, and fr's own metrics say a miss is
 * the COMMON case, not the rare one (`fr_keycloak_user_lookup_total`:
 * `not_found` 375 vs `found` 27 against `portal`). `getUserById` has 12
 * production call sites (dashboard, approvals, tenant/workspace members,
 * admin/users, admin/department-members, `resolveUsers`'s 7 callers,
 * comments, agui actions), so every one of them now pays that doubled cost
 * on its majority path. The worst case is `routes/comments.ts:134`: it
 * already dedupes author ids WITHIN one request, but a thread's authors are
 * looked up again, at full doubled cost, on every subsequent page load.
 *
 * ⚠️ WHY A NEGATIVE CACHE, NOT A POSITIVE ONE. Caching a resolved profile
 * (name/email) risks handing back a STALE name after Keycloak data changes —
 * a correctness defect, not a performance win. Caching only the ABSENCE fact
 * has no such failure mode: the worst a stale entry can do is keep showing a
 * raw UUID / "Unknown User" for a subject that was JUST created in Keycloak,
 * until the entry expires — late, never wrong, and it heals itself with no
 * intervention.
 *
 * ⚠️ WHY THIS TTL IS SAFE (the estate has been bitten by a cache TTL shorter
 * than the refresh it guards — see project memory). That failure shape needs
 * the underlying fact to change FASTER than the cache expires, so a reader
 * sees a "fresh" answer that is actually behind reality. Here the guarded
 * fact — "does this subject id exist in either realm" — changes only once,
 * at provisioning, and essentially never reverses; it does not have a
 * refresh cadence for a short TTL to undercut. The risk here runs the
 * OPPOSITE direction (too long, not too short), and `NOT_FOUND_CACHE_TTL_MS`
 * is kept to single-digit minutes precisely to bound that window.
 *
 * Only a CLEAN 404 from every realm actually tried marks an id — never an
 * auth failure or a transport error — so a Keycloak outage can never be
 * mistaken for "confirmed absent" and hidden behind this cache.
 */
const NOT_FOUND_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bounds memory under an id-enumeration storm; Map iteration order is insertion order, so this is a cheap FIFO, not a real LRU — good enough for a cache that only ever saves a redundant 404. */
const NOT_FOUND_CACHE_MAX_ENTRIES = 5000;
const notFoundUntil = new Map<string, number>();

function isConfirmedAbsent(userId: string): boolean {
  const expiry = notFoundUntil.get(userId);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    notFoundUntil.delete(userId);
    return false;
  }
  return true;
}

function markConfirmedAbsent(userId: string): void {
  if (notFoundUntil.size >= NOT_FOUND_CACHE_MAX_ENTRIES && !notFoundUntil.has(userId)) {
    const oldest = notFoundUntil.keys().next().value;
    if (oldest !== undefined) notFoundUntil.delete(oldest);
  }
  notFoundUntil.set(userId, Date.now() + NOT_FOUND_CACHE_TTL_MS);
}

/**
 * The admin API's credential. Realm-per-app F1: WHICH realm is administered is
 * `config.keycloak.userRealm` (KEYCLOAK_USER_REALM, default KEYCLOAK_REALM) at every
 * `/admin/realms/…` call site; the CREDENTIAL stays fr-backend in KEYCLOAK_REALM
 * unless the user realm has its own admin client
 * (KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID/_SECRET, both-or-neither).
 */
function adminAuthTarget(): { realm: string; clientId: string; clientSecret: string } {
  const kc = config.keycloak;
  if (kc.userRealmAdminClientId && kc.userRealmAdminClientSecret) {
    return { realm: kc.userRealm, clientId: kc.userRealmAdminClientId, clientSecret: kc.userRealmAdminClientSecret };
  }
  return { realm: kc.realm, clientId: kc.clientId, clientSecret: kc.clientSecret };
}

export function getAdminAuth(): ServiceAuthenticator {
  if (!adminAuth) {
    adminAuth = new ServiceAuthenticator({
      keycloakUrl: config.keycloak.url,
      ...adminAuthTarget(),
    });
  }
  return adminAuth;
}

/** The JWKS endpoint every bearer token in this service is verified against. */
const JWKS_PATH = '/realms/{realm}/protocol/openid-connect/certs';

/**
 * The jose error classes that mean THE PRESENTED TOKEN is at fault.
 *
 * ⚠️ CLASSIFY POSITIVELY ON THIS LIST — never `instanceof joseErrors.JOSEError`.
 * MEASURED against the jose build this process actually loads (v5.10.0; Bun
 * resolves the `bun`/`browser` export condition, `dist/browser/index.js`):
 * `runtime/fetch_jwks.js` throws a BARE `JOSEError` for a non-200 JWKS response
 * ("Expected 200 OK from the JSON Web Key Set HTTP response") and another for an
 * unparseable body. Those are Keycloak being down or fronted by an error page —
 * the exact outage this classification exists to separate — yet both are
 * `JOSEError`s. A base-class test would have re-labelled the outage as a bad
 * token, i.e. reproduced the defect while looking like the fix.
 */
const TOKEN_FAULT_ERRORS = [
  joseErrors.JWTExpired,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JWSInvalid,
  joseErrors.JWTInvalid,
  // ⚠️ `JOSENotSupported` IS THE CALLER'S FAULT AND ITS ABSENCE HERE WAS A
  // REGRESSION. A token whose header says `alg: "none"` or `alg: HS256` — both
  // entirely caller-authored — makes jose throw this, and without it on this
  // list the request fell through to the unavailable arm and answered 502 where
  // the old code answered 401. That hands an UNAUTHENTICATED caller a lever on
  // fr's 5xx rate: post `eyJhbGciOiJub25lIn0…` in a loop and every one is a
  // server-error data point, which is both a false alarm and a false story
  // about who failed. MEASURED against the resolved build (dist/browser):
  // alg:none -> JOSENotSupported ERR_JOSE_NOT_SUPPORTED; alg:HS256 -> the same;
  // a correctly signed RS256 token throws nothing (positive control).
  joseErrors.JOSENotSupported,
  // ⚠️ UNREACHABLE TODAY, KEPT DELIBERATELY — and the pair above/below is the
  // cautionary tale. `jwtVerify` is called with no `algorithms` option, so jose
  // never raises `JOSEAlgNotAllowed`; the original list named THIS class, which
  // can never fire, and omitted `JOSENotSupported`, which is the one that
  // actually does. An allowlist covering the same ground would be a real
  // behaviour change to token verification and is deliberately NOT bundled into
  // an outage-classification fix. Retained so that adding `algorithms` later
  // does not silently reclassify a caller fault as an outage.
  joseErrors.JOSEAlgNotAllowed,
] as const;

/**
 * Is this failure the CALLER's token, rather than fr's ability to check it?
 *
 * ⚠️ `JWKSNoMatchingKey` is DELIBERATELY ABSENT — it is the ambiguous one, and
 * it belongs on the unavailable side. Both readings exist: a forged token with a
 * random `kid`, and a realm signing-key rotation where jose's cached JWKS is
 * stale and its refetch is still inside `cooldownDuration`. The two differ in
 * BLAST RADIUS, and that is what decides it: the forged-token reading is one
 * attacker, who is refused either way and is owed nothing helpful; the rotation
 * reading is EVERY logged-in user at once, all holding valid tokens, all told to
 * re-authenticate against the Keycloak that is mid-rotation. A correlated,
 * self-amplifying logout is strictly worse than one confusing status, so the
 * ambiguity resolves to "unavailable".
 *
 * The same asymmetry justifies the default direction of the whole rule. Anything
 * unrecognised — a `TypeError` from a refused connection, an `AbortError`, a
 * plain `Error` — is treated as unavailable. Being wrong that way costs one user
 * a 502 instead of a "log in again" prompt; being wrong the other way costs a
 * fleet-wide forced re-login during an outage. Note this also catches an fr-side
 * programming fault inside `validateToken` (a `TypeError` in claim handling, for
 * instance), which now answers 502 rather than 401 — still honest: 502 says
 * "something server-side failed", 401 says "your credential is bad", and only
 * one of those was true. And the enumerated list above covers essentially all
 * real-world token failure traffic: expiry, signature, issuer/audience,
 * malformed input.
 *
 * ⚠️ FAIL-CLOSED: every branch of the catch below THROWS. This changes which
 * error a rejected caller is shown; it never admits a caller who was rejected
 * before.
 */
function isTokenFault(err: unknown): boolean {
  return TOKEN_FAULT_ERRORS.some((ErrorClass) => err instanceof ErrorClass);
}

/**
 * fr could not fetch or read the realm JWKS, so it could not decide anything
 * about the token. Reuses this file's existing idiom (`adminAuthOrUnavailable`,
 * `identityLookupUnavailable`): an `IntegrationError`, whose status comes from
 * the ONE mapping in `integrations/_lib/errors.ts` rather than a second copy —
 * `UPSTREAM_TIMEOUT` -> 504, `UPSTREAM_UNREACHABLE` -> 502.
 */
function jwksUnavailable(cause: unknown): IntegrationError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  // ⚠️ THE DETAIL GOES TO THE LOG, NEVER INTO `message`. `message` is serialised
  // into the response body by `integrationErrorResponse`, and this error is
  // raised BEFORE the caller has authenticated — so interpolating the upstream
  // text here hands an anonymous caller fr's internal failure prose (upstream
  // hostnames, jose internals, error-page fragments). The sibling Planka
  // boundary states the same policy: the client gets a generic sentence, the
  // operator gets the specifics. `cause` is retained on the error for anything
  // in-process that wants it; it is not part of the serialised body.
  console.warn(`[keycloak] JWKS unavailable (${JWKS_PATH}): ${detail}`);
  if (cause instanceof joseErrors.JWKSTimeout) {
    return new IntegrationError({
      code: 'UPSTREAM_TIMEOUT',
      message: 'keycloak realm JWKS fetch timed out',
      service: 'keycloak',
      method: 'GET',
      path: JWKS_PATH,
      cause,
    });
  }
  return new IntegrationError({
    code: 'UPSTREAM_UNREACHABLE',
    message: 'keycloak realm JWKS could not be fetched',
    service: 'keycloak',
    method: 'GET',
    path: JWKS_PATH,
    cause,
  });
}

export interface ValidateTokenOptions {
  /**
   * Accept a token from a KEYCLOAK_SERVICE_ONLY_REALMS realm (default `secure-apps`). ONLY service
   * doors pass this, and each then pins its own issuer. Default false: a user route never honours a
   * secure-apps token (that realm holds human accounts too) — the conveyor identity excepted.
   */
  allowServiceRealms?: boolean;
}

export class KeycloakService {
  /**
   * Accepted JWT audiences. When undefined/empty, aud validation is
   * skipped (matches w2v_common bb9380d behaviour).
   */
  private readonly audiences: string[] | undefined = config.keycloak.audiences;

  async validateToken(token: string, opts: ValidateTokenOptions = {}): Promise<User> {
    try {
      // Realm-per-app F1: the issuer is one of KEYCLOAK_TRUSTED_ISSUERS (default [KEYCLOAK_ISSUER]),
      // compared as the explicit claim string (decoupled from the fetch URL so KEYCLOAK_URL can point
      // at an in-cluster service), each verified against its own realm's keys.
      const verify: VerifyKeycloakJwtOptions['verify'] = {};
      if (this.audiences && this.audiences.length > 0) {
        verify.audience = this.audiences;
      }

      const { payload: claims, issuer } = await verifyKeycloakJwt(token, {
        allowServiceRealms: opts.allowServiceRealms === true,
        verify,
      });

      const realmAccess = claims.realm_access;
      const roles =
        typeof realmAccess === 'object' &&
        realmAccess !== null &&
        Array.isArray((realmAccess as Record<string, unknown>).roles)
          ? ((realmAccess as { roles: unknown[] }).roles.filter(
              (r): r is string => typeof r === 'string',
            ) as string[])
          : [];

      const id = typeof claims.sub === 'string' ? claims.sub : '';
      const email = typeof claims.email === 'string' ? claims.email : '';
      const name = typeof claims.name === 'string' ? claims.name : '';
      const avatar_url = typeof claims.picture === 'string' ? claims.picture : undefined;
      const deptId = typeof claims.dept_id === 'string' ? claims.dept_id : undefined;
      // RAW `tenant_id` claim — no `sub` fallback. Read by the realm
      // `tenant_admin` arm (services/user-roles.ts :: isRealmTenantAdminOf).
      const tenantClaim =
        typeof claims.tenant_id === 'string' && claims.tenant_id.length > 0
          ? claims.tenant_id
          : undefined;

      // `deriveTenantId` returns null when the token names neither a tenant
      // nor a subject — it no longer invents "anonymous". There is nothing
      // honest to put in `User.tenantId` here: the field is structurally
      // `string` (257 read sites, ~30 of which hand it to a Postgres `uuid`
      // column), and any placeholder would ride out as `X-Tenant-Id` on every
      // downstream call — which worker_management has answered with `400
      // INVALID_TENANT` since 2026-08-25. A Keycloak access token ALWAYS
      // carries `sub`, so a token that verifies against the realm JWKS with
      // neither claim is not an identity this service can name; give it the
      // same 401 the unverifiable-token path below already gives. The catch
      // rewrites this to the generic message (so nothing leaks to the client)
      // but logs this one.
      const tenantId = deriveTenantId(claims);
      if (tenantId === null) {
        throw new UnauthorizedError(
          'Verified token carries neither tenant_id nor sub',
        );
      }

      return {
        id,
        email,
        name,
        roles,
        tenantId,
        deptId,
        avatar_url,
        tenantName: deriveTenantName(claims),
        ...(tenantClaim !== undefined ? { tenantClaim } : {}),
        // Client-credentials service account or not, from the SIGNED claims,
        // and the verified `preferred_username` — both recorded by the
        // priority audit (lib/priority-change.ts).
        isServiceAccount: isServiceAccountClaims(claims),
        ...(typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0
          ? { username: claims.preferred_username }
          : {}),
        // The verified authorized party (the issuing client). With `username`
        // and the realm `roles` above it identifies the dedicated conveyor
        // priority identity (lib/priority-change.ts isConveyorActor).
        ...(typeof claims.azp === 'string' && claims.azp.length > 0 ? { azp: claims.azp } : {}),
        // The VERIFIED issuer and its realm (realm-per-app F1). The service doors pin the issuer per
        // client (FR_BRIDGE_ISSUER / FR_CONVEYOR_ISSUER).
        ...(issuer ? { issuer } : {}),
        ...(issuer && realmOfIssuer(issuer) ? { realm: realmOfIssuer(issuer) } : {}),
        // George 2026-10-27: the ONE super-admin session classifier, on the SIGNED claims — the WS
        // upgrade reads this instead of re-deriving trust from the narrower User fields.
        superAdminSessionTrust: superAdminSessionTrustFromClaims(claims as Record<string, unknown>),
      };
    } catch (error) {
      console.error('Token validation failed:', error);

      // ⚠️ This used to be an unconditional `throw new UnauthorizedError(...)`,
      // and the `try` above wraps the JWKS NETWORK FETCH (`defaultJWKS` is a
      // `createRemoteJWKSet` against `KEYCLOAK_URL`). So whenever Keycloak — or
      // the Cloudflare -> cloudflared -> istio path to it — was down, slow, or
      // this pod rolled with a cold JWKS cache, every logged-in user holding a
      // perfectly valid, unexpired token was told `401 Invalid or expired
      // token`. Every client-side "401 => force re-login" flow then drove the
      // whole userbase at the Keycloak that was already failing.
      //
      // Same class fr fixed on its Planka boundary (#1028) and on the
      // `UPSTREAM_UNAUTHORIZED -> 502` boundary before that: fr's OWN dependency
      // failing must not be reported to the user as "you are unauthenticated".
      //
      // `UnauthorizedError` is re-thrown as the GENERIC message on purpose —
      // the only one raised inside the `try` is the tenant guard above, whose
      // detail is for the log line, not the client.
      if (error instanceof UnauthorizedError || isTokenFault(error)) {
        throw new UnauthorizedError('Invalid or expired token');
      }
      throw jwksUnavailable(error);
    }
  }

  extractToken(authHeader: string | null): string {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }
    return authHeader.substring(7);
  }

  /**
   * Reverse email lookup. Uses the admin-API `?email=` filter with
   * `exact=true`. Mirrors the phone lookup contract: returns the user
   * id on a single exact match, null on zero matches or collisions
   * (logs the collision). THROWS when the directory could not answer — see
   * `identityLookupUnavailable`.
   */
  async findUserByEmail(email: string): Promise<string | null> {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return null;
    const auth = adminAuthOrUnavailable('findUserByEmail');
    const params = new URLSearchParams({
      email: trimmed,
      exact: 'true',
      max: '2',
    });
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${params.toString()}`;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({
          op: 'findUserByEmail',
          status: response.status,
        });
      }
      const users = (await response.json()) as Array<{ id: string }>;
      if (users.length === 0) return null;
      if (users.length > 1) {
        console.warn(`[keycloak] findUserByEmail collision: ${users.length} users for ${trimmed}`);
        return null;
      }
      return users[0]?.id ?? null;
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op: 'findUserByEmail', cause: error });
    }
  }

  /**
   * Reverse phone-number lookup. Searches the `phone` user attribute via the
   * admin API (Keycloak 17+ `?q=key:value`). Returns the user id on a single
   * exact match, null on zero matches or collisions (logs the collision).
   * THROWS when the directory could not answer — see
   * `identityLookupUnavailable`.
   */
  async findUserByPhone(phone: string): Promise<string | null> {
    const normalized = normalizePhoneAttr(phone);
    if (!normalized) return null;

    const auth = adminAuthOrUnavailable('findUserByPhone');
    const params = new URLSearchParams({
      q: `phone:${normalized}`,
      exact: 'true',
      max: '2',
    });
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${params.toString()}`;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({
          op: 'findUserByPhone',
          status: response.status,
        });
      }
      const users = (await response.json()) as Array<{ id: string }>;
      if (users.length === 0) return null;
      if (users.length > 1) {
        console.warn(`[keycloak] findUserByPhone collision: ${users.length} users for ${normalized}`);
        return null;
      }
      return users[0]?.id ?? null;
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op: 'findUserByPhone', cause: error });
    }
  }

  /**
   * Reverse AAD object id lookup. Tries the custom-attribute path
   * (`?q=aad_object_id:<id>`) first, then falls back to the standard federated
   * identity search (`?idpAlias=azure&idpUserId=<id>`). Same one-result-or-null
   * rule as `findUserByPhone`. A collision on the attribute path returns null
   * WITHOUT falling through to the idpAlias path — over-reporting a wrong user
   * is worse than missing a hit.
   *
   * ⚠️ The attribute path is allowed to FAIL and fall through to the idpAlias
   * path — that fallback is the design. What it may not do is let a failed
   * attribute read be reported as "no such user": if the attribute path could
   * not answer and the idpAlias path then finds nobody, the honest answer is
   * "unknown", not `null`. `attrUnavailable` carries exactly that.
   */
  async findUserByAadObjectId(aadId: string): Promise<string | null> {
    if (!aadId) return null;
    const auth = adminAuthOrUnavailable('findUserByAadObjectId');
    let attrUnavailable: IntegrationError | null = null;

    const attrParams = new URLSearchParams({
      q: `aad_object_id:${aadId}`,
      exact: 'true',
      max: '2',
    });
    const attrUrl = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${attrParams.toString()}`;
    try {
      const response = await auth.authenticatedFetch(attrUrl, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const users = (await response.json()) as Array<{ id: string }>;
        if (users.length === 1) return users[0]?.id ?? null;
        if (users.length > 1) {
          console.warn(`[keycloak] findUserByAadObjectId attr collision: ${users.length} for ${aadId}`);
          return null;
        }
      } else {
        attrUnavailable = identityLookupUnavailable({
          op: 'findUserByAadObjectId (attribute path)',
          status: response.status,
        });
      }
    } catch (error) {
      attrUnavailable = isIntegrationError(error)
        ? error
        : identityLookupUnavailable({
            op: 'findUserByAadObjectId (attribute path)',
            cause: error,
          });
    }

    const idpParams = new URLSearchParams({
      idpAlias: 'azure',
      idpUserId: aadId,
      max: '2',
    });
    const idpUrl = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${idpParams.toString()}`;
    try {
      const response = await auth.authenticatedFetch(idpUrl, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({
          op: 'findUserByAadObjectId',
          status: response.status,
        });
      }
      const users = (await response.json()) as Array<{ id: string }>;
      if (users.length === 0) {
        // Nobody on the idpAlias path. That is only a real "not found" if the
        // attribute path actually ran; otherwise half the search never happened.
        if (attrUnavailable) throw attrUnavailable;
        return null;
      }
      if (users.length > 1) {
        console.warn(`[keycloak] findUserByAadObjectId idp collision: ${users.length} for ${aadId}`);
        return null;
      }
      return users[0]?.id ?? null;
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op: 'findUserByAadObjectId', cause: error });
    }
  }

  /**
   * Realm-level role mappings for a user. Drives the IdentityResolver's
   * tenantRoles so per-action RBAC's `tenant-role` rules can evaluate against
   * real role membership instead of the empty-default fail-closed set.
   * Returns [] on any lookup failure (logged) — keep the dispatcher fail-closed.
   */
  async getUserRealmRoles(userId: string): Promise<string[]> {
    const auth = getAdminAuth();
    try {
      return await this.fetchUserRealmRoleNames(auth, userId, 'getUserRealmRoles');
    } catch (error) {
      // Deliberately KEPT as []: rbac.ts:239 reads an empty role set as
      // "denied", so this fails CLOSED, which is the right direction. What
      // was missing is the record — an outage and a user who genuinely holds
      // no realm roles produced identical logs and identical denials.
      reportSwallowedFailure(error, {
        service: 'keycloak',
        method: 'GET',
        path: USER_REALM_ROLE_MAPPINGS_PATH,
        degradedTo: 'no realm roles -> every tenant-role RBAC rule denies',
      });
      return [];
    }
  }

  /**
   * `getUserRealmRoles` for a user id that came from fr's OWN tables (a
   * `user_channel_prefs` link), not from Keycloak — so it may name an account
   * Keycloak no longer has. Returns `null` when the user realm answers 404 for
   * that id ("no such user here"), otherwise exactly what `getUserRealmRoles`
   * returns (roles, or `[]` fail-closed on any other failure, reported).
   *
   * ⛔ Why this exists (2026-10-23, Telegram dispatch): one Telegram id is linked
   * to 12 accounts and the identity resolver took the first row. That row's sub
   * had been deleted from Keycloak on 2026-08-27, so every role read 404'd,
   * swallowed to `[]`, and the sender was treated as a role-less, tenant-less
   * user. A 404 is a definite directory answer, not an outage — the caller must
   * be able to SKIP that candidate rather than act as it.
   */
  async getUserRealmRolesIfUserExists(userId: string): Promise<string[] | null> {
    const auth = getAdminAuth();
    try {
      return await this.fetchUserRealmRoleNames(auth, userId, 'getUserRealmRolesIfUserExists');
    } catch (error) {
      if (isIntegrationError(error) && error.upstreamStatus === 404) return null;
      reportSwallowedFailure(error, {
        service: 'keycloak',
        method: 'GET',
        path: USER_REALM_ROLE_MAPPINGS_PATH,
        degradedTo: 'no realm roles -> every tenant-role RBAC rule denies',
      });
      return [];
    }
  }

  /**
   * EFFECTIVE realm-role names of one user (composites + group mappings
   * expanded — what a fresh Keycloak token's `realm_access.roles` would carry).
   * THROWS on any failure (non-2xx incl. 404, transport, malformed body): the
   * caller makes a SAFETY decision and must fail closed, so an outage may never
   * read as "holds no roles" the way `getUserRealmRoles` reads it.
   * Used by the super-admin workspace-switch re-check (services/user-home-tenant.ts).
   */
  async getUserEffectiveRealmRoles(userId: string): Promise<string[]> {
    const op = 'getUserEffectiveRealmRoles';
    return this.fetchUserRealmRoleNames(adminAuthOrUnavailable(op), userId, op, 'effective');
  }

  /**
   * Realm-role names of one user, covered by `view-users`:
   *   - `mappings: 'direct'` (default) → `GET /users/{id}/role-mappings/realm`
   *     (what `getUserRealmRoles` has always read — unchanged);
   *   - `mappings: 'effective'` → `GET /users/{id}/role-mappings/realm/composite`
   *     (composites + group mappings expanded; used by `listRealmTenantAdminIds`).
   * THROWS an IntegrationError carrying the matching path constant on non-2xx /
   * transport / malformed body — `getUserRealmRoles` swallows that for RBAC;
   * `listRealmTenantAdminIds` must not.
   */
  private async fetchUserRealmRoleNames(
    auth: ServiceAuthenticator,
    userId: string,
    op: string,
    mappings: 'direct' | 'effective' = 'direct',
  ): Promise<string[]> {
    const effective = mappings === 'effective';
    const path = effective ? USER_REALM_ROLE_MAPPINGS_COMPOSITE_PATH : USER_REALM_ROLE_MAPPINGS_PATH;
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}/role-mappings/realm${effective ? '/composite' : ''}`;
    let roles: unknown;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({ op, status: response.status, path });
      }
      roles = await response.json();
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op, cause: error, path });
    }
    if (!Array.isArray(roles)) {
      throw identityLookupUnavailable({
        op,
        cause: new Error('role-mappings body is not an array'),
        path,
      });
    }
    return (roles as Array<{ name?: unknown }>)
      .map((r) => r?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }

  /**
   * Keycloak user ids holding the realm role `tenant_admin` (or its legacy
   * alias `admin`) whose `tenant_id` attribute is `tenantId` — the directory
   * half of "who are this workspace's admins" (the other half is `user_roles`;
   * see `services/user-roles.ts :: isRealmTenantAdminOf`).
   *
   * Uses ONLY endpoints fr's service account (`realm-management: view-users`)
   * can read — NOT `GET /roles/tenant_admin/users`, which needs `view-realm`:
   *   1. `GET /users?q=tenant_id:<T>&exact=true&briefRepresentation=false`,
   *      paged — the tenant's users (attribute re-checked client-side);
   *   2. per ENABLED user, `GET /users/{id}/role-mappings/realm/composite` —
   *      kept iff the EFFECTIVE realm roles include `tenant_admin` or `admin`.
   * Sorted, deduped. A non-uuid `tenantId` returns [] without querying.
   *
   * EFFECTIVE roles, deliberately: in the portal realm `super_admin` is a
   * composite containing `tenant_admin`, and groups can map it too. Those
   * holders pass fr's admin check for their own claimed tenant (the signed
   * `realm_access.roles` claim is already composite-expanded), so reading only
   * DIRECT mappings left them out of budget alerts and approval routing for a
   * tenant they administer. The recipient list now matches the auth check.
   *
   * Successful results are cached per tenant for 60s
   * (`invalidateRealmTenantAdminCache`); a thrown lookup is never cached.
   * `{ fresh: true }` skips the cached read (and refreshes the cache): use it
   * for any SAFETY decision — the last-admin revoke guard must not count an
   * admin Keycloak removed in the last 60s (fr#1291 audit).
   *
   * THROWS on any read failure (unconfigured admin creds, non-2xx, transport,
   * malformed body, a failed role lookup for ANY candidate, or the page cap
   * being hit): "no tenant admins" and "we could not ask" are different facts.
   * Callers that build a notification/approver list catch it and fall back to
   * `user_roles`.
   */
  async listRealmTenantAdminIds(
    tenantId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<string[]> {
    if (!tenantId || !isValidUuid(tenantId)) return [];
    const cached = opts.fresh ? undefined : realmTenantAdminCache.get(tenantId);
    if (cached && Date.now() - cached.at < REALM_TENANT_ADMIN_CACHE_TTL_MS) {
      return [...cached.ids];
    }
    const ids = await this.readRealmTenantAdminIds(tenantId);
    realmTenantAdminCache.set(tenantId, { at: Date.now(), ids: [...ids] });
    return ids;
  }

  /**
   * ENABLED Keycloak user ids whose `tenant_id` attribute is `tenantId` — the
   * directory half of "who are this tenant's MEMBERS" (P1-TEAM-b; the other half
   * is `user_roles`, see `services/tenant-member-recipients.ts`). Factored out of
   * the candidate loop of `readRealmTenantAdminIds`, which now reads it uncached.
   *
   * ⚠️ THE SAME ENDPOINT AND REPRESENTATION `readRealmTenantAdminIds` HAS ALWAYS
   * USED — `GET /users?q=tenant_id:<T>&exact=true&briefRepresentation=false`. Some
   * admin reads return `attributes: {}` (the brief representation hides them), and
   * the attribute is RE-CHECKED client-side below, so a read that hid attributes
   * would silently return NOBODY. The P1-TEAM-a audit proved this one returns
   * `tenant_id`.
   *
   * Sorted, deduped. A non-uuid `tenantId` returns [] without querying.
   * Successful results are cached per tenant for 60s; `{ fresh: true }` skips the
   * cached read (and refreshes the cache) — use it for any SAFETY decision.
   * THROWS on any read failure (unconfigured creds, non-2xx, transport, malformed
   * body, page cap): "nobody" and "could not ask" are different facts.
   */
  async listTenantUserIds(
    tenantId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<string[]> {
    if (!tenantId || !isValidUuid(tenantId)) return [];
    const cached = opts.fresh ? undefined : tenantUserCache.get(tenantId);
    if (cached && Date.now() - cached.at < TENANT_USER_CACHE_TTL_MS) {
      return [...cached.ids];
    }
    const ids = await this.readTenantUserIds(tenantId, 'listTenantUserIds');
    tenantUserCache.set(tenantId, { at: Date.now(), ids: [...ids] });
    return ids;
  }

  /** Uncached paged read behind `listTenantUserIds` and `readRealmTenantAdminIds`. */
  private async readTenantUserIds(tenantId: string, op: string): Promise<string[]> {
    const auth = adminAuthOrUnavailable(op);
    const PAGE = 100;
    const MAX_PAGES = 50; // 5,000 users in ONE tenant — a runaway guard, not a cap anyone meets

    const candidates = new Set<string>();
    let exhausted = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        q: `tenant_id:${tenantId}`,
        exact: 'true',
        briefRepresentation: 'false',
        first: String(page * PAGE),
        max: String(PAGE),
      });
      const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${params.toString()}`;
      let users: unknown;
      try {
        const response = await auth.authenticatedFetch(url, {
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          throw identityLookupUnavailable({ op, status: response.status });
        }
        users = await response.json();
      } catch (error) {
        if (isIntegrationError(error)) throw error;
        throw identityLookupUnavailable({ op, cause: error });
      }
      if (!Array.isArray(users)) {
        throw identityLookupUnavailable({ op, cause: new Error('users body is not an array') });
      }
      for (const u of users as Array<{ id?: unknown; enabled?: unknown; attributes?: Record<string, unknown> }>) {
        if (typeof u?.id !== 'string' || u.id.length === 0) continue;
        if (u.enabled === false) continue;
        // Re-check the attribute: `q=` search semantics vary across Keycloak
        // versions (substring vs exact), and a looser match must not widen the list.
        const attr = u.attributes?.tenant_id;
        const claimed = Array.isArray(attr) ? attr[0] : undefined;
        if (claimed === tenantId) candidates.add(u.id);
      }
      if (users.length < PAGE) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted) {
      // Truncating here would report "these are all the admins" when we
      // stopped reading — "could not ask" must not look like "none/fewer".
      throw identityLookupUnavailable({
        op,
        cause: new Error(`tenant ${tenantId} has more than ${PAGE * MAX_PAGES} users; page cap hit`),
      });
    }
    return [...candidates].sort();
  }

  /** Uncached directory read behind `listRealmTenantAdminIds`. */
  private async readRealmTenantAdminIds(tenantId: string): Promise<string[]> {
    const op = 'listRealmTenantAdminIds';
    const auth = adminAuthOrUnavailable(op);
    const ROLE_LOOKUP_BATCH = 5;
    // UNCACHED on purpose: the admin list has its own 60s cache, and building it from a
    // cached user list would compound the two TTLs (and defeat `{ fresh: true }`).
    const ids = await this.readTenantUserIds(tenantId, op);

    // Bounded concurrency: tenants are small, but never fan out unboundedly
    // against the admin API.
    const out: string[] = [];
    for (let i = 0; i < ids.length; i += ROLE_LOOKUP_BATCH) {
      const batch = ids.slice(i, i + ROLE_LOOKUP_BATCH);
      const roleSets = await Promise.all(
        batch.map((id) => this.fetchUserRealmRoleNames(auth, id, op, 'effective')),
      );
      batch.forEach((id, k) => {
        // `admin` is a pinned legacy alias of `tenant_admin` (George ruling,
        // fr#1289); the pin here is the `tenant_id` attribute filter above.
        if (holdsRealmTenantAdminRole(roleSets[k] ?? [])) out.push(id);
      });
    }
    return out;
  }

  /**
   * Fetch the basic profile for a Keycloak user id (sub). Returns
   * `{ id, email, name, avatar_url }` on success, `null` on miss / network
   * error / missing admin creds. Non-throwing: callers (comment enrichment)
   * must keep working when Keycloak is unreachable, falling back to a
   * placeholder display name rather than 5xx-ing the whole request.
   *
   * `name` is composed in order: `firstName + lastName`, then `username`,
   * then the email local-part. Empty string if no signal is available.
   *
   * ⚠️ THE `null` CONTRACT IS LOAD-BEARING AND IS DELIBERATELY NOT CHANGED
   * (issue #1031). Two of this method's callers are unguarded — `resolveUsers`
   * below and `routes/comments.ts` both `await` it inside a `Promise.all` with
   * no `try` — so making the misconfiguration arm THROW, as the sibling
   * lookups do via `adminAuthOrUnavailable`, would turn a blank display name
   * into a 5xx on the comment list. That is strictly worse than the silence it
   * would replace, and the comment-enrichment doc-comment explicitly commits to
   * remaining readable while Keycloak is degraded. So every arm below still
   * returns `null`; what changes is that each one now leaves a DISTINCT record.
   *
   * The three ways `null` happens are no longer interchangeable:
   *
   *   - admin creds unconfigured -> `SERVICE_AUTH_FAILED` telemetry line +
   *     `admin_auth_failed` counter. NO request is issued, so this arm is
   *     invisible to any proxy/ingress log — the counter is the only place it
   *     can ever be seen.
   *   - 404 -> `not_found` counter ONLY, no log line (see below).
   *   - non-404 / transport failure -> existing warn, now naming the realm.
   */
  async getUserById(userId: string): Promise<{
    id: string;
    email: string | null;
    name: string;
    avatar_url: string | null;
  } | null> {
    // Not counted: an empty id is an fr-side caller bug, not a directory
    // outcome. Counting it would inflate the miss rate with lookups that never
    // asked Keycloak anything.
    if (!userId) return null;
    // Confirmed absent from every realm within the last NOT_FOUND_CACHE_TTL_MS
    // — skip BOTH admin round-trips entirely rather than repeat a 404 this
    // process already paid for. See `isConfirmedAbsent`'s doc for why this is
    // safe to do without a metric: it issues no request, same as branch (A).
    if (isConfirmedAbsent(userId)) return null;
    let auth: ServiceAuthenticator;
    try {
      auth = adminAuthOrUnavailable('getUserById');
    } catch (err) {
      const realm = config.keycloak.userRealm;
      // ⚠️ Branch (A). This is fr being MISCONFIGURED, not a missing user, and
      // the two want opposite fixes. `adminAuthOrUnavailable` builds the same
      // `SERVICE_AUTH_FAILED` IntegrationError the sibling lookups throw;
      // `reportSwallowedFailure` emits fr's standard `integration_error`
      // telemetry line for it (`http_status: null`, `swallowed: true`) while
      // this method keeps its `null` contract for the unguarded callers above.
      //
      // ⛔ NOT rate-limited, unlike the 404 arm, and that asymmetry is the
      // point. `ServiceAuthenticator`'s constructor throws only on missing
      // static config (url/realm/clientId/clientSecret), so this arm is
      // permanent for the life of the process and TOTAL — no lookup can
      // succeed, so there is no healthy traffic for it to drown out. A
      // once-per-process line would be worse than useless: it would age out of
      // any retention window, and an operator grepping the last hour of a
      // six-day-old pod would see silence — the exact defect #1031 is about,
      // wearing a new costume.
      recordKeycloakUserLookup('admin_auth_failed', realm);
      reportSwallowedFailure(err, {
        service: 'keycloak',
        method: 'GET',
        path: USERS_PATH,
        degradedTo: `null for EVERY user lookup (realm="${realm}") — no request issued; display names fall back to the raw sub`,
      });
      return null;
    }
    return this.getUserByIdInRealm(userId, config.keycloak.userRealm, auth, true);
  }

  /**
   * `getUserById`'s HTTP body, parametrized on realm + authenticator so it can
   * be retried against a SECOND realm on a clean 404 — see `secondaryRealm()`.
   *
   * `tryFallback` must be `false` on the RETRY call itself. Without it, a
   * subject absent from BOTH realms recurses forever: the secondary realm's
   * own 404 would ask `secondaryRealm()` again, which has no notion of "we are
   * already on the fallback" and would keep returning the same non-null
   * secondary — an unbounded loop that OOMs the process rather than returning
   * `null`. Exactly one retry, ever.
   */
  private async getUserByIdInRealm(
    userId: string,
    realm: string,
    auth: ServiceAuthenticator,
    tryFallback: boolean,
  ): Promise<{
    id: string;
    email: string | null;
    name: string;
    avatar_url: string | null;
  } | null> {
    const url = `${config.keycloak.url}/admin/realms/${realm}/users/${userId}`;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        if (response.status === 404) {
          // ⚠️ Branch (B). STILL NOT LOGGED, on purpose. A single 404 is the
          // benign "that user is gone" case and logging it is the noise that
          // got this line deleted before — measured at 1,658 lines in 7 days.
          // The counter carries it instead: silent per event, and
          // `rate(fr_keycloak_user_lookup_total{outcome="not_found"}[1h])`
          // against the `found` series answers the SUSTAINED question a single
          // 404 must not. The `realm` label is what makes the answer
          // actionable — 92% of subjects missing from `portal` reads as a
          // routing question, and without the label it reads as nothing.
          recordKeycloakUserLookup('not_found', realm);
          // ⭐ THE FIX: retry the OTHER realm before giving up. The licenses
          // registry's own `subject.keycloak_realm` breakdown (measured in
          // `nonagenticai/licenses`, models.py) shows the MAJORITY of
          // `subject_id`s are `secure-apps`-realm principals, not `portal` —
          // so a portal-only 404 is not evidence the person doesn't exist, it
          // is evidence we asked the wrong directory. Only tried on a CLEAN
          // 404 (not on auth failure or a transport error) so we never mask a
          // real outage as "not in this realm either", and ONLY ONCE
          // (`tryFallback` is false on the retry itself) so a subject absent
          // from both realms 404s twice and stops, rather than looping.
          const secondary = tryFallback ? secondaryRealm() : null;
          if (secondary) {
            return this.getUserByIdInRealm(userId, secondary.realm, secondary.auth, false);
          }
          // Terminal 404 — every realm this call was going to try has now
          // said no (either there was no secondary to retry, or this IS that
          // retry and it also missed). Confirmed absent; see
          // `markConfirmedAbsent`'s doc for why it is safe to remember this
          // and NOT the upstream_error branch below.
          markConfirmedAbsent(userId);
        } else {
          recordKeycloakUserLookup('upstream_error', realm);
          console.warn(
            `[keycloak] getUserById non-2xx ${response.status} for ${userId} in realm ${realm}`,
          );
        }
        return null;
      }
      const u = (await response.json()) as {
        id?: string;
        email?: string;
        username?: string;
        firstName?: string;
        lastName?: string;
        attributes?: Record<string, string[]>;
      };
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      const fallback =
        u.username ||
        (u.email ? u.email.split('@')[0] : '') ||
        '';
      // The positive control, and the denominator. Without this series a reader
      // sees misses rise and cannot tell "these subjects are in the other
      // realm" from "this admin client resolves nobody" — the two readings
      // #1031 spent three rounds separating.
      // ⚠️ BUILD FIRST, THEN COUNT. Recording before the object exists means any
      // throw while building it would ALSO be caught below and recorded as
      // `transport_error`, double-counting one lookup into two series and
      // inflating the very error rate this metric is read for. Unreachable today
      // — it is a plain object with optional chaining — but the ordering is the
      // fragile part, not the current expression.
      const profile = {
        id: u.id ?? userId,
        email: u.email ?? null,
        name: fullName || fallback,
        avatar_url: u.attributes?.avatar_url?.[0] ?? null,
      };
      recordKeycloakUserLookup('found', realm);
      return profile;
    } catch (error) {
      recordKeycloakUserLookup('transport_error', realm);
      console.warn(
        `[keycloak] getUserById error for ${userId} in realm ${realm}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Free-text user search for the super-admin console's person-picker.
   *
   * Backs "grant a license to a person" without ever making an operator paste a
   * Keycloak `sub` UUID: they type an email or name, this resolves the matching
   * users, and the caller carries the `id` (= the sub the license binds to)
   * invisibly.
   *
   * Uses the admin API's `?search=` free-text filter, which matches across
   * username, email, first and last name (Keycloak's own OR-search). Also
   * returns each user's `tenant_id` attribute — the provisioning flow stamps it,
   * and the console defaults the grant's tenant to it so a super-admin never
   * mis-targets the tenant (the licenses service silently no-ops a
   * wrong-tenant revoke, so picking the person's real tenant by default is a
   * correctness feature, not just convenience).
   *
   * Non-throwing by contract (returns [] on any error) — a picker that
   * occasionally shows no results is far better than one that 500s the page.
   */
  async searchUsers(
    query: string,
    max = 20,
  ): Promise<
    Array<{
      id: string;
      email: string | null;
      name: string;
      username: string | null;
      tenant_id: string | null;
    }>
  > {
    const q = query.trim();
    if (!q) return [];
    let auth: ServiceAuthenticator;
    try {
      auth = getAdminAuth();
    } catch (err) {
      // Unconfigured admin credentials is a SERVER problem, not "nobody matched".
      throw new IntegrationError({
        code: 'SERVICE_AUTH_FAILED',
        message: 'keycloak admin credentials are not configured — user search is unavailable',
        service: 'keycloak',
        method: 'GET',
        path: '/admin/realms/{realm}/users',
        cause: err,
      });
    }
    const params = new URLSearchParams({
      search: q,
      max: String(Math.min(Math.max(max, 1), 50)),
      // Keep it to real, usable accounts.
      enabled: 'true',
    });
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${params.toString()}`;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        // ⚠️ NOT `return []`. The one consumer, routes/admin/licenses-admin.ts,
        // hands this straight to a typeahead as `{ users: [] }` — so a Keycloak
        // outage rendered as "no such person" and an admin concluded the account
        // did not exist. A search that could not run is not a search that found
        // nothing.
        throw new IntegrationError({
          code: 'UPSTREAM_BAD_STATUS',
          message: `keycloak user search failed with ${response.status}`,
          service: 'keycloak',
          method: 'GET',
          path: '/admin/realms/{realm}/users',
          upstreamStatus: response.status,
        });
      }
      const users = (await response.json()) as Array<{
        id?: string;
        email?: string;
        username?: string;
        firstName?: string;
        lastName?: string;
        attributes?: Record<string, string[]>;
      }>;
      return users
        .filter((u) => u.id)
        .map((u) => {
          const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
          return {
            id: u.id as string,
            email: u.email ?? null,
            name: fullName || u.username || (u.email ? u.email.split('@')[0] : '') || (u.id as string),
            username: u.username ?? null,
            tenant_id: u.attributes?.tenant_id?.[0] ?? null,
          };
        });
    } catch (error) {
      // Re-throw our own classified error untouched; only the transport fault
      // needs wrapping. Either way the caller learns the search did not run.
      if (isIntegrationError(error)) throw error;
      throw new IntegrationError({
        code: 'UPSTREAM_UNREACHABLE',
        message: `keycloak user search could not reach the server: ${
          error instanceof Error ? error.message : String(error)
        }`,
        service: 'keycloak',
        method: 'GET',
        path: '/admin/realms/{realm}/users',
        cause: error,
      });
    }
  }

  /**
   * Resolve a batch of `sub` UUIDs to displayable people, for turning a
   * licenses table's raw subject_id column into names/emails. One admin call
   * per id (Keycloak has no bulk-by-id endpoint), bounded and best-effort:
   * any id that fails to resolve is simply omitted, so the caller falls back
   * to showing the raw sub for those.
   */
  async resolveUsers(
    ids: string[],
    cap = 50,
  ): Promise<Record<string, { id: string; email: string | null; name: string }>> {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, cap);
    const out: Record<string, { id: string; email: string | null; name: string }> = {};
    await Promise.all(
      unique.map(async (id) => {
        const u = await this.getUserById(id);
        if (u) out[id] = { id: u.id, email: u.email, name: u.name };
      }),
    );
    return out;
  }

  /**
   * Generic federated-identity reverse lookup. Maps an external IdP user id
   * (e.g. a Teams/AAD object id) to a Keycloak user id via the standard
   * admin search:
   *
   *   GET /admin/realms/{realm}/users?idpAlias=<alias>&idpUserId=<id>
   *
   * Returns null on miss, on any HTTP/network error, on collision (>1
   * Keycloak user federated under the same external id is itself a
   * misconfiguration — over-reporting a wrong user is worse than missing
   * a hit), or when admin creds aren't configured. Non-throwing by
   * contract — webhook callers must tolerate Keycloak hiccups.
   *
   * NOTE: `findUserByAadObjectId` is the AAD-specific cousin that ALSO
   * tries an attribute-path (`?q=aad_object_id:<id>`) before falling
   * back to this idpAlias path. Use that for AAD; use this for any
   * other federated IdP (Teams bot federation, GitHub, etc.).
   */
  async findUserByFederatedIdentity(
    idpAlias: string,
    idpUserId: string,
  ): Promise<string | null> {
    if (!idpAlias || !idpUserId) return null;
    const auth = adminAuthOrUnavailable('findUserByFederatedIdentity');
    const params = new URLSearchParams({
      idpAlias,
      idpUserId,
      max: '2',
    });
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${params.toString()}`;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({
          op: 'findUserByFederatedIdentity',
          status: response.status,
        });
      }
      const users = (await response.json()) as Array<{ id: string }>;
      if (users.length === 0) return null;
      if (users.length > 1) {
        console.warn(
          `[keycloak] findUserByFederatedIdentity collision: ${users.length} for ${idpAlias}:${idpUserId}`,
        );
        return null;
      }
      return users[0]?.id ?? null;
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({
        op: 'findUserByFederatedIdentity',
        cause: error,
      });
    }
  }

  /**
   * Get a user's phone number from Keycloak user attributes.
   * Uses the `phone` attribute configured in the portal realm user profile.
   * Returns null if the user doesn't have a phone attribute set.
   */
  async getUserPhone(userId: string): Promise<string | null> {
    const auth = adminAuthOrUnavailable('getUserPhone');
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${userId}`;

    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        // 404 is a real answer: there is no such user, so there is no phone.
        // Anything else means we do not know — a null the caller cannot tell
        // apart from "no match" would let an outage read as "this person has
        // no phone number".
        if (response.status === 404) return null;
        throw identityLookupUnavailable({
          op: 'getUserPhone',
          status: response.status,
        });
      }

      const user = await response.json() as { attributes?: Record<string, string[]> };
      const phone = user.attributes?.phone?.[0];
      return phone || null;
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op: 'getUserPhone', cause: error });
    }
  }

  /**
   * Read a user's `tenant_id` Keycloak attribute (the value the super-admin
   * provisioning flow stamps at create time and `deriveTenantId` reads from the
   * JWT). Returns `null` when the user has no such attribute (a legacy user
   * whose JWT-tenant therefore falls back to `sub`) or when Keycloak 404s the
   * user. THROWS on any other read failure — "no attribute" and "we could not
   * read the attribute" are different facts and the caller renders them
   * differently. Single-attribute reader, mirrors
   * `getUserPhone`; kept off `getUserById` (which is on the `resolveUsers` hot
   * path and drops all attributes but avatar from its return shape).
   */
  async getUserTenantId(userId: string): Promise<string | null> {
    const auth = adminAuthOrUnavailable('getUserTenantId');
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${userId}`;

    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        // As with `getUserPhone`: 404 answers, everything else does not. The
        // caller (`routes/admin/super-admin.ts`) turns a null into the claim
        // "this account's JWT resolves to <sub>", which on a failed read is a
        // fabricated tenant-divergence warning about a convergence nobody read.
        if (response.status === 404) return null;
        throw identityLookupUnavailable({
          op: 'getUserTenantId',
          status: response.status,
        });
      }

      const user = await response.json() as { attributes?: Record<string, string[]> };
      return user.attributes?.tenant_id?.[0] || null;
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op: 'getUserTenantId', cause: error });
    }
  }

  /**
   * Does this user still exist, and is the account enabled? Reads
   * `GET /users/{id}` in the primary realm — the realm fr logs users into, and
   * the one `getUserRealmRoles` already reads on the agent-refresh leg.
   *
   * `'not_found'` only on a clean 404; `'disabled'` only on a 2xx body whose
   * `enabled` is not `true`. THROWS an IntegrationError on every other outcome
   * (non-2xx, transport, malformed body) — "the account is gone" and "we could
   * not ask" must never be the same answer, because the refresh path revokes on
   * the first and only retries on the second.
   */
  async getUserAccountStatus(userId: string): Promise<'active' | 'disabled' | 'not_found'> {
    return (await this.readUserAccountState(userId, 'getUserAccountStatus')).status;
  }

  /**
   * `getUserAccountStatus` PLUS the user's HOME tenant, from the SAME single
   * `GET /users/{id}` (fr-agui P1-TEAM-a). `homeTenantId` is what
   * `deriveTenantId` (utils/tenant.ts) makes of that user's token: the
   * `tenant_id` attribute (first value), else the user's own id (the `sub`
   * fallback of a legacy user with no attribute). `null` only when the account
   * is `not_found`. THROWS exactly where `getUserAccountStatus` throws.
   *
   * Since P1-TEAM the tenant IS the access decision (every member of a tenant
   * acts on every project of it), so a session or a channel principal that
   * carries a tenant must be re-checked against THIS, not against a value
   * frozen when the session was issued.
   */
  async getUserAccountState(
    userId: string,
  ): Promise<{ status: 'active' | 'disabled' | 'not_found'; homeTenantId: string | null }> {
    return this.readUserAccountState(userId, 'getUserAccountState');
  }

  private async readUserAccountState(
    userId: string,
    op: string,
  ): Promise<{ status: 'active' | 'disabled' | 'not_found'; homeTenantId: string | null }> {
    const auth = adminAuthOrUnavailable(op);
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}`;
    let user: unknown;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) return { status: 'not_found', homeTenantId: null };
      if (!response.ok) {
        throw identityLookupUnavailable({ op, status: response.status, path: USER_PATH });
      }
      user = await response.json();
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op, cause: error, path: USER_PATH });
    }
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      throw identityLookupUnavailable({
        op,
        cause: new Error('user body is not an object'),
        path: USER_PATH,
      });
    }
    const u = user as { enabled?: unknown; attributes?: Record<string, unknown> };
    const attr = u.attributes?.tenant_id;
    const first = Array.isArray(attr) ? attr[0] : undefined;
    const homeTenantId = typeof first === 'string' && first.length > 0 ? first : userId;
    return { status: u.enabled === true ? 'active' : 'disabled', homeTenantId };
  }

  // ── fr#1289 part B: write-through of the portal-realm `tenant_admin` role ──
  //
  // Only ever the role named exactly REALM_TENANT_ADMIN_ROLE. Never PUTs user
  // attributes. Every method THROWS on any failure — the caller decides how a
  // failed write-through degrades; a swallowed failure here would report a
  // grant/revoke that never happened.

  /**
   * `tenant_id` attribute (first value or null) + DIRECT and EFFECTIVE realm
   * role names + `enabled`. Reads `GET /users/{id}`, then
   * `/role-mappings/realm` and `/role-mappings/realm/composite`. THROWS on any
   * failure, including a 404 user.
   */
  async getUserTenantAndRoles(userId: string): Promise<{
    tenantId: string | null;
    directRoles: string[];
    effectiveRoles: string[];
    enabled: boolean;
  }> {
    const op = 'getUserTenantAndRoles';
    const auth = adminAuthOrUnavailable(op);
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}`;
    let user: unknown;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({ op, status: response.status, path: USER_PATH });
      }
      user = await response.json();
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op, cause: error, path: USER_PATH });
    }
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      throw identityLookupUnavailable({
        op,
        cause: new Error('user body is not an object'),
        path: USER_PATH,
      });
    }
    const u = user as { enabled?: unknown; attributes?: Record<string, unknown> };
    const attr = u.attributes?.tenant_id;
    const first = Array.isArray(attr) ? attr[0] : undefined;
    const tenantId = typeof first === 'string' && first.length > 0 ? first : null;

    const [directRoles, effectiveRoles] = await Promise.all([
      this.fetchUserRealmRoleNames(auth, userId, op, 'direct'),
      this.fetchUserRealmRoleNames(auth, userId, op, 'effective'),
    ]);
    return { tenantId, directRoles, effectiveRoles, enabled: u.enabled === true };
  }

  /**
   * Idempotently give `userId` a DIRECT realm mapping of `tenant_admin`.
   * `'already'` iff a DIRECT mapping exists (a composite-only holder, e.g. a
   * super_admin, gets an explicit mapping so fr's grant is not contingent on
   * an unrelated role). Otherwise `GET /roles/tenant_admin` then
   * `POST /users/{id}/role-mappings/realm` with `[{id,name}]` → `'added'`.
   * THROWS on any failure.
   */
  async assignRealmTenantAdmin(userId: string): Promise<'added' | 'already'> {
    return this.assignDirectRealmRole('assignRealmTenantAdmin', userId, REALM_TENANT_ADMIN_ROLE);
  }

  /**
   * Idempotently give `userId` a DIRECT realm mapping of the role named
   * `roleName` (e.g. `member` when a super_admin adds a person to an existing
   * tenant). Same contract as `assignRealmTenantAdmin`, which is this method
   * for `tenant_admin`: `'already'` iff a DIRECT mapping exists, otherwise
   * `GET /roles/{roleName}` then `POST .../role-mappings/realm` → `'added'`.
   * Never touches user attributes, so it cannot re-tenant anyone. THROWS on
   * any failure, including a realm that has no such role.
   */
  async assignRealmRole(userId: string, roleName: string): Promise<'added' | 'already'> {
    return this.assignDirectRealmRole('assignRealmRole', userId, roleName);
  }

  private async assignDirectRealmRole(
    op: string,
    userId: string,
    roleName: string,
  ): Promise<'added' | 'already'> {
    const auth = adminAuthOrUnavailable(op);
    const direct = await this.fetchUserRealmRoleNames(auth, userId, op, 'direct');
    if (direct.includes(roleName)) return 'already';
    const role = await this.fetchRealmRoleRep(auth, op, roleName);
    await this.writeRealmRoleMapping(auth, userId, op, 'POST', role);
    if (roleName === REALM_TENANT_ADMIN_ROLE) invalidateRealmTenantAdminCache();
    return 'added';
  }

  /**
   * Idempotently remove the DIRECT realm mapping of `tenant_admin`.
   * `'absent'` when no DIRECT mapping exists — including when the user holds
   * it only via a composite/group, which this method must not (and cannot)
   * touch. Otherwise `DELETE /users/{id}/role-mappings/realm` with
   * `[{id,name}]` → `'removed'`. THROWS on any failure.
   */
  async removeRealmTenantAdmin(userId: string): Promise<'removed' | 'absent'> {
    const op = 'removeRealmTenantAdmin';
    const auth = adminAuthOrUnavailable(op);
    const direct = await this.fetchUserRealmRoleNames(auth, userId, op, 'direct');
    if (!direct.includes(REALM_TENANT_ADMIN_ROLE)) return 'absent';
    const role = await this.fetchRealmRoleRep(auth, op, REALM_TENANT_ADMIN_ROLE);
    await this.writeRealmRoleMapping(auth, userId, op, 'DELETE', role);
    invalidateRealmTenantAdminCache();
    return 'removed';
  }

  /**
   * `POST /users/{id}/logout` — ends the user's sessions so a revoked role
   * cannot linger in a live token/refresh chain. THROWS on any failure.
   */
  async logoutUser(userId: string): Promise<void> {
    const op = 'logoutUser';
    const auth = adminAuthOrUnavailable(op);
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}/logout`;
    let response: Response;
    try {
      response = await auth.authenticatedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw identityLookupUnavailable({ op, method: 'POST', path: USER_LOGOUT_PATH, cause: error });
    }
    if (!response.ok) {
      throw identityLookupUnavailable({ op, method: 'POST', path: USER_LOGOUT_PATH, status: response.status });
    }
  }

  /** `GET /roles/{roleName}` → `{ id, name }`; THROWS unless the body names exactly that role. */
  private async fetchRealmRoleRep(
    auth: ServiceAuthenticator,
    op: string,
    roleName: string,
  ): Promise<{ id: string; name: string }> {
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/roles/${encodeURIComponent(roleName)}`;
    let rep: unknown;
    try {
      const response = await auth.authenticatedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw identityLookupUnavailable({ op, status: response.status, path: REALM_ROLE_PATH });
      }
      rep = await response.json();
    } catch (error) {
      if (isIntegrationError(error)) throw error;
      throw identityLookupUnavailable({ op, cause: error, path: REALM_ROLE_PATH });
    }
    const r = rep as { id?: unknown; name?: unknown } | null;
    if (!r || typeof r.id !== 'string' || r.id.length === 0 || r.name !== roleName) {
      throw identityLookupUnavailable({
        op,
        cause: new Error(`role body is not the ${roleName} representation`),
        path: REALM_ROLE_PATH,
      });
    }
    return { id: r.id, name: r.name };
  }

  /** POST/DELETE `/users/{id}/role-mappings/realm` with exactly `[role]`. THROWS on failure. */
  private async writeRealmRoleMapping(
    auth: ServiceAuthenticator,
    userId: string,
    op: string,
    method: 'POST' | 'DELETE',
    role: { id: string; name: string },
  ): Promise<void> {
    const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}/role-mappings/realm`;
    let response: Response;
    try {
      response = await auth.authenticatedFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ id: role.id, name: role.name }]),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw identityLookupUnavailable({ op, method, path: USER_REALM_ROLE_MAPPINGS_PATH, cause: error });
    }
    if (!response.ok) {
      throw identityLookupUnavailable({ op, method, path: USER_REALM_ROLE_MAPPINGS_PATH, status: response.status });
    }
  }
}

/** Strip the separators a human may type so the same number compares equal. */
export function normalizePhoneAttr(phone: string): string {
  return phone.replace(/[\s\-()]/g, '');
}

export const keycloak = new KeycloakService();

/**
 * Lite Keycloak user shape used by the mentions resolver.
 * Kept separate from the auth `User` type so callers don't have to pull
 * in role/tenant plumbing they don't need.
 */
export interface KeycloakUserLookupResult {
  sub: string;
  email?: string;
  phone?: string;
  /**
   * The user's `tenant_id` attribute (trimmed; null when absent/blank). The
   * lookup is realm-wide, so a caller that notifies the match MUST compare
   * this to the tenant it is acting in — a same-handle user in another tenant
   * is a different person.
   */
  tenantId?: string | null;
}

/**
 * Look up a single Keycloak user in the configured realm by `username` or
 * `email`. Uses the admin API via the client-credentials service account
 * (same `ServiceAuthenticator` used by `getUserPhone`).
 *
 * Returns `null` on miss, on any HTTP/network error, or if the admin
 * credentials aren't configured. Non-throwing by contract — callers are
 * mention dispatch paths that must not break comment creation.
 */
export async function keycloakLookupByUsernameOrEmail(
  query: { username?: string; email?: string },
): Promise<KeycloakUserLookupResult | null> {
  if (!query.username && !query.email) return null;

  let auth: ServiceAuthenticator;
  try {
    auth = getAdminAuth();
  } catch (err) {
    // Missing admin creds → no-op, don't break callers. Non-throwing is right
    // here (a comment must still save); returning null with NO record was not.
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      path: USERS_PATH,
      degradedTo: 'mention lookup -> null (the @mention resolves to nobody)',
    });
    return null;
  }

  const params = new URLSearchParams({ exact: 'true', max: '1' });
  if (query.username) params.set('username', query.username);
  if (query.email) params.set('email', query.email);

  const url = `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}/users?${params.toString()}`;
  try {
    const response = await auth.authenticatedFetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      // Was a bare `return null` with no log at all: a 503 from Keycloak and
      // "@alice is not a user here" were the same value AND the same silence.
      reportSwallowedFailure(
        new Error(`keycloak mention lookup non-2xx ${response.status}`),
        {
          service: 'keycloak',
          method: 'GET',
          path: USERS_PATH,
          degradedTo: 'mention lookup -> null (the @mention resolves to nobody)',
        },
      );
      return null;
    }

    const users = (await response.json()) as Array<{
      id: string;
      email?: string;
      attributes?: Record<string, string[]>;
    }>;
    const u = users[0];
    if (!u) return null;

    const phone = u.attributes?.phone?.[0];
    const tenantId = u.attributes?.tenant_id?.[0]?.trim() || null;
    return {
      sub: u.id,
      email: u.email,
      phone: phone || undefined,
      tenantId,
    };
  } catch (error) {
    reportSwallowedFailure(error, {
      service: 'keycloak',
      method: 'GET',
      path: USERS_PATH,
      degradedTo: 'mention lookup -> null (the @mention resolves to nobody)',
    });
    return null;
  }
}
