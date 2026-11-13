import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import {
  getRequestContext,
  tryGetRequestContext,
  withRequestContext,
  extractBearerToken,
  getProjectId,
  setProjectId,
  type Initiator,
  type RequestContext,
} from '../integrations/_lib/context';
import {
  deriveTenantId,
  isServiceAccountClaims,
  isServiceAccountSubjectTenant,
} from '../utils/tenant';
import { verifyKeycloakJwt } from '../services/keycloak';
import { verifyAgentTokenClaims } from '../lib/agent-token';
import { isConveyorActor } from '../lib/conveyor-identity';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { tokenProvesTenant } from './tenant-membership';
import {
  classifyActiveTenantHeader,
  recordActiveTenantHeaderOutcome,
} from '../lib/active-tenant-header-metrics';
import { AppError, ForbiddenError } from '../utils/errors';
import {
  superAdminSessionTrustFromClaims,
  superAdminSwitchTarget,
  type SuperAdminSessionTrust,
  type SwitchRefusalReason,
  type SwitchTargetDecision,
} from '../lib/super-admin-switch-target';
import { recordSuperAdminSwitchRequest, switchedSuperAdminFrame } from '../lib/super-admin-tenant-audit';
import { observeTenantFromSub } from '../lib/sa-tenant-from-sub';
import {
  introspectLicenceForRequest,
  isLicenceBearer,
  resolveDelegatedTenant,
  type LicenceIdentity,
} from '../lib/licence-introspect';

// Header used by the super-admin top-bar workspace switcher to assert which
// workspace should scope this request. Honoured only when the requester carries
// the `super_admin` Keycloak REALM ROLE (see lib/super-admin-gate.ts — the old
// `SUPER_ADMIN_USER_IDS` env allowlist is gone; do not reason about this gate in
// terms of env vars) and the target passes `superAdminSwitchTarget`
// (lib/super-admin-switch-target.ts): a PLATFORM tenant, the user's own JWT
// tenant, or — George 2026-10-27, super_admin is tenant-admin everywhere — any
// EXISTING, NON-ARCHIVED workspace, the last (and the tenant-admin rights that
// come with a switch) for an FR super-admin session only: a human token from the
// fr realm issuer for fr's browser client.
// A super-admin whose explicit switch is refused gets a 403
// `active_tenant_not_permitted` with a `reason` (`archived` / `unknown` /
// `service_account` / `untrusted_session`) — never a silent fallback to home. A non-super-admin's
// header is still ignored (and counted). The read-only support switch
// (fr row 14j, FR_SUPPORT_SWITCH_*) is retired: it is subsumed by this rule.
const ACTIVE_TENANT_HEADER = 'X-Active-Tenant';

/** The machine-readable code of the refused-switch 403 (fr row 14d). */
export const ACTIVE_TENANT_NOT_PERMITTED_CODE = 'active_tenant_not_permitted';

/**
 * fr row 14d: a SIGNED super-admin sent a well-formed X-Active-Tenant naming a
 * tenant they may not switch into. `reason` says why (George 2026-10-27):
 *   - `archived`          — the workspace exists but is archived;
 *   - `unknown`           — fr has no workspace for that tenant;
 *   - `service_account`   — a service-account token named a customer workspace;
 *   - `untrusted_session` — a super_admin token that is not an fr super-admin
 *     session (another realm or client) named a customer workspace.
 * The request is refused with 403 rather than silently served from the home
 * tenant, so the UI cannot show workspace X while rendering home data.
 * Thrown by `buildRequestContext`; server.ts turns it into the response.
 */
class ActiveTenantNotPermittedError extends AppError {
  readonly status = 403;
  override code: string = ACTIVE_TENANT_NOT_PERMITTED_CODE;
  constructor(
    readonly requestedTenantId: string,
    /** Why: `archived` / `unknown` workspace, or a `service_account` / `untrusted_session` token naming a customer workspace. */
    readonly reason: SwitchRefusalReason = 'unknown',
  ) {
    super(403, ACTIVE_TENANT_REFUSAL_MESSAGES[reason]);
    this.name = 'ActiveTenantNotPermittedError';
  }
}

const ACTIVE_TENANT_REFUSAL_MESSAGES: Record<SwitchRefusalReason, string> = {
  archived: 'X-Active-Tenant names an archived workspace',
  unknown: 'X-Active-Tenant names a workspace that does not exist',
  service_account: 'X-Active-Tenant may name a customer workspace only for a signed-in person, not a service account',
  untrusted_session: 'X-Active-Tenant may name a customer workspace only for a super-admin signed in through the Non-Agentic AI app',
};

/** The machine-readable code of the 503 when the switch target could not be checked. */
export const ACTIVE_TENANT_UNVERIFIABLE_CODE = 'active_tenant_unverifiable';

/**
 * A super-admin named a customer workspace and fr could not read its
 * `workspaces` row (database error). Fail closed: 503, never a silent switch
 * and never a silent fallback to home. Thrown by `buildRequestContext`.
 */
class ActiveTenantUnverifiableError extends AppError {
  readonly status = 503;
  override code: string = ACTIVE_TENANT_UNVERIFIABLE_CODE;
  constructor(readonly requestedTenantId: string) {
    super(503, 'The workspace named by X-Active-Tenant could not be checked right now');
    this.name = 'ActiveTenantUnverifiableError';
  }
}

/** The machine-readable code of the removed orchestrator override (fr#1437). */
const ORCHESTRATOR_TENANT_OVERRIDE_REMOVED_CODE = 'orchestrator_tenant_override_removed';

/**
 * fr#1437: a caller holding the `aa-orchestrator` realm role sent an
 * X-Tenant-Id naming a tenant other than its own JWT tenant. The cross-tenant
 * override that used to honour it is gone; the request is refused 403 rather
 * than served from the home tenant. Thrown by `buildRequestContext`.
 */
export class OrchestratorTenantOverrideRemovedError extends ForbiddenError {
  override code: string = ORCHESTRATOR_TENANT_OVERRIDE_REMOVED_CODE;
  constructor() {
    super('X-Tenant-Id may not name a tenant other than the caller\'s own: the aa-orchestrator cross-tenant override was removed');
    this.name = 'OrchestratorTenantOverrideRemovedError';
  }
}

/**
 * The HTTP answer for a refused switch: 403 `{ error, code }`. server.ts calls
 * this (adding its CORS headers) so the body shape the frontend keys on is
 * built — and tested — in one place.
 */
function activeTenantNotPermittedResponse(
  err: ActiveTenantNotPermittedError,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: err.message, code: err.code, reason: err.reason }), {
    status: err.statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * server.ts's ONE mapping from a `buildRequestContext` refusal to its HTTP
 * answer: the refused switch (403), the unverifiable switch target (503) and the
 * removed orchestrator override (403). `null` for any other error (server.ts
 * rethrows). Exported so tests drive the same path.
 */
export function requestContextRefusalResponse(
  err: unknown,
  extraHeaders: Record<string, string> = {},
): Response | null {
  if (err instanceof ActiveTenantNotPermittedError) {
    return activeTenantNotPermittedResponse(err, extraHeaders);
  }
  if (err instanceof ActiveTenantUnverifiableError || err instanceof OrchestratorTenantOverrideRemovedError) {
    return new Response(JSON.stringify({ error: err.message, code: err.code }), {
      status: err.statusCode,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
  }
  return null;
}

// The switch-target predicate lives in lib/super-admin-switch-target.ts (it
// needs a `workspaces` lookup); re-exported for the callers that import it here.
export { isSuperAdminSwitchTarget } from '../lib/super-admin-switch-target';

// Tight UUID v4/v7 shape check. Doesn't validate version digits — any
// well-formed 36-char hyphenated UUID passes. Strict-ish to keep malformed
// header values out of downstream X-Tenant-Id forwarding.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// fr 14d-0: `buildRequestContext` is called more than once for some requests
// (server.ts builds the frame, then e.g. routes/tools/bridge.ts rebuilds it from
// the same Request). The X-Active-Tenant counter must move ONCE per request, so
// remember which Request objects were already counted. Weak: no retention.
const _activeTenantHeaderCounted = new WeakSet<Request>();
// One `auth.effective_tenant_delegated` line per request, however many times the
// frame is rebuilt for it.
const _licenceDelegationLogged = new WeakSet<Request>();
// Same once-per-request rule for the `[super-admin-switch]` audit line.
const _superAdminSwitchLogged = new WeakSet<Request>();

export { getRequestContext, tryGetRequestContext, withRequestContext, getProjectId, setProjectId };
export type { RequestContext, Initiator };

/**
 * Resolve the effective tenant id for the current request — i.e. what
 * handlers should scope tenant-aware queries by. Honours the super-admin
 * X-Active-Tenant override (when accepted by `buildRequestContext`) and
 * falls back silently to the JWT `tenant_id` claim for everyone else.
 *
 * Replaces `user.tenantId` at handler call sites: `validateAuth` still
 * returns the JWT-claimed tenant for backwards compatibility, but every
 * tenant-scoped SELECT / INSERT / UPDATE / DELETE should derive its filter
 * from this helper so the workspace switcher actually re-scopes the
 * response.
 *
 * The optional `fallback` argument lets handlers pass the JWT tenant claim
 * (typically `user.tenantId`) as the value to use when there is no active
 * request frame (e.g. unit tests that call the handler directly without
 * `withRequestContextFromReq`, or cron / startup callers). In production
 * every request lands inside a frame so the fallback is never taken; the
 * argument exists only to keep direct-handler-call test ergonomics intact.
 *
 * Throws ONLY when there's no active frame AND no fallback was supplied —
 * surfacing a real bug rather than silently returning an empty string.
 */
export function ctxTenantId(fallback?: string | null): string {
  const ctx = tryGetRequestContext();
  if (ctx?.tenantId) return ctx.tenantId;
  if (fallback) return fallback;
  throw new Error(
    'request-context: tenantId not resolvable (no frame, no fallback)',
  );
}

/**
 * Soft variant of `ctxTenantId()` — returns undefined when there is no
 * active request frame OR no tenantId on it. Use from telemetry / span
 * attributes that must tolerate cron / startup paths.
 */
export function tryCtxTenantId(): string | undefined {
  return tryGetRequestContext()?.tenantId;
}

export class InvalidInitiatorError extends Error {
  readonly status = 400;
  constructor(value: string) {
    super(`Invalid X-Initiator value: ${value}`);
    this.name = 'InvalidInitiatorError';
  }
}

const VALID_INITIATORS: ReadonlySet<Initiator> = new Set([
  'human',
  'agent',
  'cron',
]);

function parseInitiator(raw: string | null): Initiator {
  if (raw === null || raw === '') return 'human';
  const lower = raw.toLowerCase();
  if (!VALID_INITIATORS.has(lower as Initiator)) {
    throw new InvalidInitiatorError(raw);
  }
  return lower as Initiator;
}

/**
 * Verify a bearer JWT against the realm JWKS and return its claims, or
 * undefined when the token is missing/invalid/expired. Used to populate
 * the ALS request frame (tenantId, userId, subjectId) BEFORE any route's
 * `validateAuth` gate runs, so we cannot rely on validateAuth to gate the
 * trustworthiness of these fields downstream.
 *
 * Verification uses the same JWKS resolver as `services/keycloak.ts` so
 * an attacker-supplied unsigned JWT cannot poison `X-Subject-Id` /
 * `X-Tenant-Id` forwarding to upstream services (inference-router metering,
 * audit logs, RBAC hints). Returns undefined on any verification failure —
 * the route's own auth gate still rejects the request, so callers see the
 * normal 401 path.
 */
async function verifyBearerClaims(
  token: string | undefined,
): Promise<JWTPayload | undefined> {
  if (!token) return undefined;
  try {
    // Realm-per-app F1: the SAME trusted-issuer verifier `keycloak.validateToken` uses — so a token
    // from any KEYCLOAK_TRUSTED_ISSUERS realm frames identically, a KEYCLOAK_SERVICE_ONLY_REALMS
    // token never frames as a user (conveyor identity excepted), and an impostor conveyor from a
    // non-FR_CONVEYOR_ISSUER realm yields no claims at all.
    const { payload } = await verifyKeycloakJwt(token);
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * The end-user proof worker_management#316 accepts for a DELEGATED call:
 * return `token` iff it is a verified HUMAN portal token that PROVES
 * `effectiveTenantId` — its raw `tenant_id` claim equals it, or its signed
 * `member_tenant_ids` claim contains it (fr#1385 Option 1); otherwise
 * `undefined` (send nothing).
 *
 * The predicate is `tokenProvesTenant` (`./tenant-membership`), graded against
 * vectors shared byte-identically with worker_management: the RAW `tenant_id`
 * claim (NO `sub` fallback), EXACT matching. Checking it here as well is not
 * redundancy: a token WM
 * would refuse anyway must not leave fr at all, because the header carries a
 * live user credential and the smallest set of places it travels is the point.
 *
 * Refused shapes (all return undefined):
 *  - no verified claims (HS256 agent token, garbage, expired, wrong issuer);
 *  - a client-credentials SERVICE ACCOUNT (the conveyor / n8n operator) — it
 *    is not a signed-in user, whatever tenant claim it carries;
 *  - an effective tenant the token neither claims as `tenant_id` nor lists in
 *    `member_tenant_ids` (a super-admin `X-Active-Tenant` switch to a workspace
 *    the user is not a member of) — WM would
 *    answer `tenant_mismatch`, so the token buys nothing there.
 */
export function endUserTokenFromClaims(
  token: string | undefined,
  claims: JWTPayload | undefined,
  effectiveTenantId: string | undefined,
): string | undefined {
  if (!token || !claims) return undefined;
  const raw = claims as Record<string, unknown>;
  if (isServiceAccountClaims(raw)) return undefined;
  // fr#1385: home tenant OR a signed `member_tenant_ids` entry, EXACT match.
  if (!tokenProvesTenant(raw, effectiveTenantId)) return undefined;
  return token;
}

/**
 * The owner's OWN portal token, for the super-admin admin routes that act on a
 * NAMED target tenant (`routes/admin/tenant-llm-provider.ts`).
 *
 * `endUserTokenFromClaims` drops the token whenever its `tenant_id` differs
 * from the frame tenant — which is ALWAYS the case on those routes (the target
 * is a customer) and also whenever the owner has an `X-Active-Tenant` switch
 * active. worker_management decides an owner override on a different proof:
 * an RS256 token from the portal issuer whose `realm_access.roles` contains
 * `super_admin`, with a `sub`. So this re-verifies `token` against the same
 * JWKS + issuer as the frame and returns it ONLY when it is that shape:
 *  - verified by the realm JWKS (an HS256 fr-agent token, a forgery, an expired
 *    or foreign-issuer token all fail here);
 *  - NOT a client-credentials service account (the conveyor, the n8n operator,
 *    fr-backend's licence SA) — even one that has been granted `super_admin`;
 *  - carries a non-empty `sub` and the SIGNED `super_admin` realm role.
 * Never throws, never logs the value.
 */
export async function verifiedSuperAdminPortalToken(
  token: string | undefined,
): Promise<string | undefined> {
  if (!token) return undefined;
  const claims = await verifyBearerClaims(token);
  if (!claims) return undefined;
  if (isServiceAccountClaims(claims as Record<string, unknown>)) return undefined;
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) return undefined;
  if (!isSuperAdmin({ roles: rolesFromClaims(claims) })) return undefined;
  return token;
}

/**
 * Verify a portal token the BROWSER forwarded alongside an fr-agent session
 * token (`X-End-User-Token: Bearer <keycloak access token>` on
 * `POST /api/agent/chat`), for frames whose own `Authorization` is the HS256
 * agent token and therefore can never yield an end-user proof.
 *
 * Beyond `endUserTokenFromClaims`, the token's `sub` must equal the agent
 * session's user: an agent session may only carry ITS OWN user's portal token,
 * never one lifted from another user. Returns the bare token or undefined.
 * Never throws, never logs the value.
 */
export async function verifyForwardedEndUserToken(
  rawHeader: string | null | undefined,
  expected: { tenantId: string | undefined; userId: string | undefined },
): Promise<string | undefined> {
  let token = (rawHeader ?? '').trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token || !expected.userId) return undefined;
  const claims = await verifyBearerClaims(token);
  if (!claims || claims.sub !== expected.userId) return undefined;
  return endUserTokenFromClaims(token, claims, expected.tenantId);
}

/**
 * The SWITCH-session twin of `verifyForwardedEndUserToken`, for an agent
 * session minted from a super-admin workspace switch (agent token claim
 * `super_admin_switch`, lib/agent-token.ts). Such a session's tenant is the
 * ACTIVE workspace, while the user's portal token names their HOME tenant, so
 * `verifyForwardedEndUserToken` can never accept it (and must not: that token
 * is the worker_management proof). This returns the bare token iff ALL hold:
 *  - the session IS a switch session (`superAdminSwitch === true`);
 *  - it verifies against the realm JWKS + issuer (HS256 agent token, forgery,
 *    expired, foreign issuer ⇒ nothing);
 *  - it is a HUMAN token (not a client-credentials service account);
 *  - its `sub` is the agent session's user;
 *  - it carries the SIGNED `super_admin` realm role;
 *  - the session tenant is a switch target for it (`acceptsActiveTenantSwitch`
 *    — the browser's own X-Active-Tenant predicate; never the support switch);
 *  - Keycloak still says so, live (`userMaySuperAdminSwitchInto`: active, still
 *    `super_admin` by EFFECTIVE roles, still a switch target; 15 s cache).
 *    A Keycloak outage ⇒ nothing (fail closed).
 * Consumed ONLY as `RequestContext.superAdminSwitchToken`. Never throws, never
 * logs the value.
 */
export async function verifyForwardedSwitchEndUserToken(
  rawHeader: string | null | undefined,
  expected: { tenantId: string | undefined; userId: string | undefined; superAdminSwitch: boolean },
): Promise<string | undefined> {
  if (expected.superAdminSwitch !== true) return undefined;
  let token = (rawHeader ?? '').trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token || !expected.userId || !expected.tenantId) return undefined;
  const claims = await verifyBearerClaims(token);
  if (!claims || claims.sub !== expected.userId) return undefined;
  if (isServiceAccountClaims(claims as Record<string, unknown>)) return undefined;
  if (
    // AWAIT: `acceptsActiveTenantSwitch` is async and returns a Promise, which is
    // always truthy — without this the whole switch-target check is skipped and
    // ANY human's token is accepted as a super-admin switch token.
    !(await acceptsActiveTenantSwitch(expected.tenantId, {
      roles: rolesFromClaims(claims),
      homeTenantId: tenantFromClaims(claims),
      session: superAdminSessionTrustFromClaims(claims as Record<string, unknown>),
    }))
  ) {
    return undefined;
  }
  try {
    // Dynamic: services/user-home-tenant imports this module.
    const { userMaySuperAdminSwitchInto } = await import('../services/user-home-tenant');
    if (!(await userMaySuperAdminSwitchInto(expected.userId, expected.tenantId))) return undefined;
  } catch {
    return undefined;
  }
  return token;
}

/**
 * fr-agui SPEC §5.7 / P1b — the Keycloak REALM roles of the forwarded portal
 * token, under exactly the proof `verifyForwardedEndUserToken` demands (realm
 * JWKS signature + issuer, not a service account, `sub` == the agent session's
 * user, tenant proven). `[]` for anything less — never throws, never logs.
 *
 * WHY. The fr-agent token (HS256, fr-minted) deliberately carries NO realm
 * roles (lib/agent-token.ts: an fr-minted token must never satisfy
 * `isSuperAdmin`). But the project READ gate (`loadProjectForRead`) has a
 * super-admin home-view lane, so a read decided for the agent token's bare
 * `{id, tenantId}` was STRICTER than `GET /api/projects/:id` for the same
 * person. The roles here come from a SIGNED Keycloak claim, the same source
 * `validateAuth` uses, so the agent lanes get the GET's answer — no more, no less.
 */
export async function verifiedEndUserRealmRoles(
  rawHeader: string | null | undefined,
  expected: { tenantId: string | undefined; userId: string | undefined },
): Promise<string[]> {
  let token = (rawHeader ?? '').trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token || !expected.userId) return [];
  const claims = await verifyBearerClaims(token);
  if (!claims || claims.sub !== expected.userId) return [];
  if (endUserTokenFromClaims(token, claims, expected.tenantId) === undefined) return [];
  return rolesFromClaims(claims);
}

function tenantFromClaims(claims: JWTPayload | undefined): string | undefined {
  if (!claims) return undefined;
  // `deriveTenantId` returns null for a VERIFIED token that carries neither
  // `tenant_id` nor `sub`. Collapse it onto the same `undefined` the
  // no-claims branch above returns, so both unauthenticated shapes OMIT
  // X-Tenant-Id downstream (http-client only sets the header when truthy)
  // instead of one of them forwarding a fabricated tenant.
  return deriveTenantId(claims as Record<string, unknown>) ?? undefined;
}

function userIdFromClaims(claims: JWTPayload | undefined): string | undefined {
  if (!claims) return undefined;
  const sub = claims.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
}

// Extract Keycloak realm roles from verified claims. Mirrors the extraction in
// `keycloak.validateToken` (which builds `User.roles`) — request-context only
// has the raw `JWTPayload`, not a `User`, so it must read `realm_access.roles`
// itself to let the `super_admin` realm role gate the X-Active-Tenant switch.
function rolesFromClaims(claims: JWTPayload | undefined): string[] {
  if (!claims) return [];
  const realmAccess = (claims as Record<string, unknown>).realm_access;
  if (
    typeof realmAccess === 'object' &&
    realmAccess !== null &&
    Array.isArray((realmAccess as Record<string, unknown>).roles)
  ) {
    return (realmAccess as { roles: unknown[] }).roles.filter(
      (r): r is string => typeof r === 'string',
    );
  }
  return [];
}

/**
 * Resolve the end-user identity for the current request, for the
 * `X-Subject-Id` forwarding contract used by inference-router + metering
 * (per-user metering Phase 5a).
 *
 * 1. JWT `sub` from VERIFIED claims (signature checked against the realm
 *    JWKS via `verifyBearerClaims`). This is authoritative and is preferred
 *    over the header — a request carrying a verified user JWT must not be
 *    able to impersonate another subject by also sending X-Subject-Id.
 * 2. Inbound `X-Subject-Id` header (set by license-authz on the istio ingress
 *    for browser-facing requests), used ONLY when there is no verified `sub`
 *    (the edge path where the bearer is a license token, not a user JWT).
 *
 * Returns undefined when neither is available so a missing identity never
 * poisons context construction.
 *
 * SECURITY: the header is untrusted (client-settable on any path the edge
 * does not strip), so a verified claim always wins. Previously the header
 * was preferred, letting a caller read another user's per-user data.
 *
 * And when the request PRESENTED a bearer at all, the header is never read:
 * a bearer we could not verify as Keycloak (an fr agent token — resolved by
 * the caller from `agentIdentity` — or a forgery) must not let the client
 * name its own subject. fr is not behind the license-authz licence filter, so
 * no gateway-set X-Subject-Id rides alongside a bearer here.
 */
function subjectFromHeaderOrClaims(
  req: Request,
  claims: JWTPayload | undefined,
  bearerPresented: boolean,
): string | undefined {
  const verified = userIdFromClaims(claims);
  if (verified) return verified;
  if (bearerPresented) return undefined;
  return (
    req.headers.get('X-Subject-Id') ??
    req.headers.get('x-subject-id') ??
    undefined
  );
}

/**
 * THE X-Active-Tenant switch decision — the single place it is spelled.
 *
 * `null` when the header does not apply at all: absent, not a well-formed
 * UUID, or the caller does not carry the SIGNED `super_admin` realm role (their
 * header is ignored, never refused). Otherwise the `superAdminSwitchTarget`
 * decision (lib/super-admin-switch-target.ts): a PLATFORM tenant, the caller's
 * own tenant, or — George 2026-10-27 — any existing, non-archived workspace for
 * an FR super-admin session; refused with a reason otherwise. Throws when the workspace row
 * cannot be read (callers fail closed).
 *
 * `buildRequestContext` applies it to the `X-Active-Tenant` header (403 on a
 * refusal); the kanban WebSocket upgrade (`routes/kanbanWsAuth.ts`, fr row
 * 14d-0b) applies it to its `activeTenant` query parameter, because a browser
 * WebSocket cannot send headers. Sharing it keeps the two surfaces from ever
 * resolving the same caller to different tenants. The WS upgrade keeps its own
 * refusal handling (falls back to home, or refuses when there is none).
 */
export async function decideActiveTenantSwitch(
  requested: string | null | undefined,
  caller: { roles: readonly string[]; homeTenantId: string | null | undefined; session: SuperAdminSessionTrust },
): Promise<SwitchTargetDecision | null> {
  if (typeof requested !== 'string' || !UUID_RE.test(requested)) return null;
  if (!isSuperAdmin({ roles: caller.roles })) return null;
  return superAdminSwitchTarget(requested, caller.homeTenantId ?? undefined, { session: caller.session });
}

/** Boolean form of `decideActiveTenantSwitch`: true iff the switch is accepted. */
export async function acceptsActiveTenantSwitch(
  requested: string | null | undefined,
  caller: { roles: readonly string[]; homeTenantId: string | null | undefined; session: SuperAdminSessionTrust },
): Promise<boolean> {
  return (await decideActiveTenantSwitch(requested, caller))?.ok === true;
}

export async function buildRequestContext(req: Request): Promise<RequestContext> {
  const correlationId =
    req.headers.get('X-Correlation-Id') ??
    req.headers.get('x-correlation-id') ??
    randomUUID();
  const initiator = parseInitiator(
    req.headers.get('X-Initiator') ?? req.headers.get('x-initiator'),
  );
  const channel =
    req.headers.get('X-Channel') ?? req.headers.get('x-channel') ?? 'web';
  const bearerToken = extractBearerToken(req);
  const claims = await verifyBearerClaims(bearerToken);

  // fr has TWO token shapes on `Authorization: Bearer`. `verifyBearerClaims` is
  // Keycloak-only (RS256 via JWKS) and returns undefined for the OTHER one - the
  // HS256 `aud=fr-agent` token fr mints for AG-UI callers. Its docblock justifies
  // that silence with "the route's own auth gate still rejects the request", and
  // for this token class that premise is FALSE: the route's gate verifies the
  // same token and succeeds. So the request was authenticated and the identity
  // frame was empty.
  //
  // MEASURED over 9 days, token shape predicting outcome with zero exceptions:
  // invoke/threads/session/refresh arrive with the agent token -> 760 events
  // (84.4/day) metered to the NIL tenant; session/issue and actions arrive with
  // a Keycloak JWT -> 67 events, all attributed. The route resolved the tenant
  // one function later and it was discarded before metering, because
  // `withRequestContext` is `als.run()` - a true nest, so a frame the ROUTE
  // opens provably cannot be seen by `withUsageSpans`, which reads after the
  // handler returns.
  //
  // NOT merged into `claims`, deliberately. Everything below that reads `claims`
  // gates a header-driven tenant OVERRIDE on a SIGNED Keycloak role
  // (`isSuperAdmin`). An fr-minted token satisfying that would let an agent
  // nominate a tenant via a header. This only supplies the
  // identity the token already asserts about itself.
  const agentIdentity = claims ? null : await verifyAgentTokenClaims(bearerToken);

  // The THIRD bearer shape (George 2026-10-10): a NON-JWT-shaped licence token
  // from a customer's n8n (n8n-nodes-fr credential), verified in-app by the
  // licences service because fr is not behind the license-authz licence filter
  // and a local docker stack has no gateway at all.
  //
  // Its identity is PINNED. The tenant, user and subject come from the
  // introspection answer ONLY: it carries no signed realm roles, so the
  // super-admin X-Active-Tenant switch below can never fire for it (it keys on
  // `rolesFromClaims(claims)` and `claims` is undefined here), and the `X-Subject-Id` header is NOT read.
  //
  // Refused or unanswerable (`active:false`, licences down): the frame carries
  // NO identity — and still does not fall back to the `X-Subject-Id` header, a
  // client-settable value on a path no gateway stripped. The route's own
  // `validateAuth` then answers 401 / 502 / 504 (lib/licence-introspect.ts).
  const licenceBearer = !claims && !agentIdentity && isLicenceBearer(bearerToken);
  let licence: LicenceIdentity | null = null;
  if (licenceBearer && bearerToken) {
    try {
      licence = await introspectLicenceForRequest(req, bearerToken);
    } catch {
      licence = null;
    }
  }

  // The conveyor's delegation lane (lib/licence-introspect.ts). A NAMED licence
  // subject may act for the tenant that owns the card it is driving. `undefined`
  // for every other caller — including a licence naming its OWN tenant — so the
  // frame below is byte-identical to what it was before this lane existed.
  const delegatedTenantId = resolveDelegatedTenant(req, licence);
  const jwtTenantId =
    tenantFromClaims(claims) ?? agentIdentity?.tenantId ?? licence?.tenantId ?? undefined;
  const userId = userIdFromClaims(claims) ?? agentIdentity?.userId ?? licence?.userId;
  // fr#1052: for a licence caller `X-Subject-Id` carries the licences
  // `Subject.id` (`subject_id`) — the value its consumers (inference-router
  // billing, licences) join on — never the Keycloak sub `userId` holds.
  const subjectId = licenceBearer
    ? licence?.licenceSubjectId ?? undefined
    : agentIdentity
      ? agentIdentity.userId
      : subjectFromHeaderOrClaims(req, claims, Boolean(bearerToken));

  // X-Active-Tenant super-admin override (`decideActiveTenantSwitch` above).
  // Accepted iff the header is a well-formed UUID, the requester carries the
  // SIGNED `super_admin` realm role (`isSuperAdmin` reads `realm_access.roles`,
  // NOT an env allowlist), and the target is a platform tenant, their own JWT
  // tenant, or (George 2026-10-27) an existing, non-archived workspace — the
  // latter for an FR super-admin session only. A super-admin whose well-formed header is
  // refused gets a 403 with the reason — below, after the 14d-0 counter has
  // labelled it. Every other caller's header (non-super-admin, malformed) is
  // ignored and the JWT tenant is used, exactly as before.
  const activeTenantHeader =
    req.headers.get(ACTIVE_TENANT_HEADER) ??
    req.headers.get(ACTIVE_TENANT_HEADER.toLowerCase()) ??
    undefined;
  const callerIsSuperAdmin = isSuperAdmin({ roles: rolesFromClaims(claims) });
  const sessionTrust = superAdminSessionTrustFromClaims(claims as Record<string, unknown> | undefined);
  let tenantId = delegatedTenantId ?? jwtTenantId;
  // `activeTenantSource` stays 'jwt': no super-admin switch happened, and the
  // consumers that read 'header' (board/service-card access widening) must not
  // treat a delegation as one. The effective tenant simply IS the delegated one.
  if (delegatedTenantId && !_licenceDelegationLogged.has(req)) {
    _licenceDelegationLogged.add(req);
    console.info(
      JSON.stringify({
        event: 'auth.effective_tenant_delegated',
        logger: 'auth.delegation',
        licence_subject_id: licence?.licenceSubjectId ?? null,
        licence_id: licence?.licenseId ?? null,
        credential_tenant: jwtTenantId ?? null,
        effective_tenant: delegatedTenantId,
        method: req.method,
        path: req.url.split('?')[0],
      }),
    );
  }
  let activeTenantSource: 'jwt' | 'header' = 'jwt';
  // WHICH header won, alongside the fact THAT one did. `activeTenantSource`
  // reports `'header'` for BOTH overrides below and is consumed that way by
  // `lib/project-access.ts`, `lib/board-tenant-access.ts` and
  // `routes/kanban/reads.ts`, so it must not be narrowed; this parallel field
  // carries the distinction they do not need and `handleUpdateApproval` does.
  // See the `activeTenantVia` docblock in `integrations/_lib/context.ts` for why
  // the two branches are not equally trusted.
  let activeTenantVia: 'jwt' | 'active-tenant-header' = 'jwt';
  let switchDecision: SwitchTargetDecision | null;
  try {
    switchDecision = await decideActiveTenantSwitch(activeTenantHeader, {
      roles: rolesFromClaims(claims),
      homeTenantId: jwtTenantId,
      session: sessionTrust,
    });
  } catch (err) {
    console.error(
      '[active-tenant-header] workspace lookup failed; refusing the switch (503)',
      err instanceof Error ? err.message : String(err),
    );
    throw new ActiveTenantUnverifiableError(activeTenantHeader ?? '');
  }
  if (switchDecision?.ok === true && activeTenantHeader !== undefined) {
    tenantId = activeTenantHeader;
    activeTenantSource = 'header';
    activeTenantVia = 'active-tenant-header';
  }

  // fr 14d-0 — OBSERVATION ONLY. Labels the decision the `if` above already
  // made; reads nothing it wrote and writes nothing it reads, so the resolved
  // tenant is identical with or without this block. Header absent ⇒ no count.
  const activeTenantOutcome =
    activeTenantHeader === undefined
      ? null
      : classifyActiveTenantHeader({
          header: activeTenantHeader,
          wellFormed: UUID_RE.test(activeTenantHeader),
          homeTenantId: jwtTenantId,
          callerIsSuperAdmin,
          decision: switchDecision,
        });
  if (activeTenantHeader !== undefined && !_activeTenantHeaderCounted.has(req)) {
    _activeTenantHeaderCounted.add(req);
    const outcome = activeTenantOutcome;
    if (outcome) {
      const rawClaims = (claims ?? {}) as Record<string, unknown>;
      const clientId =
        typeof rawClaims.azp === 'string'
          ? rawClaims.azp
          : typeof rawClaims.client_id === 'string'
            ? rawClaims.client_id
            : undefined;
      recordActiveTenantHeaderOutcome({
        outcome,
        requestedTenantId: activeTenantHeader,
        homeTenantId: jwtTenantId,
        sub: userId,
        clientId,
        url: req.url,
      });
    }
  }

  // fr row 14d: a super-admin's explicit switch that the gate refused is a 403,
  // never a silent fallback to home. ONLY this case: a non-super-admin's
  // differing header stays ignored (`ignored_not_super_admin`), and a malformed
  // header stays ignored for everyone. Counted above before it throws.
  if (activeTenantHeader !== undefined && switchDecision !== null && switchDecision.ok === false) {
    throw new ActiveTenantNotPermittedError(activeTenantHeader, switchDecision.reason);
  }

  // fr#1437: the aa-orchestrator X-Tenant-Id override is REMOVED. It let a
  // caller holding the `aa-orchestrator` realm role act in ANY well-formed
  // tenant uuid with no membership test. A role holder that still names a
  // tenant other than its own JWT tenant is refused 403 — loud, never a silent
  // fallback to the home tenant. A header equal to the JWT tenant (or absent)
  // is an ordinary caller; a non-holder's X-Tenant-Id is ignored as before.
  const orchestratorRole = process.env.AA_ORCHESTRATOR_ROLE || 'aa-orchestrator';
  const xTenantHeader =
    req.headers.get('X-Tenant-Id') ??
    req.headers.get('x-tenant-id') ??
    undefined;
  if (
    xTenantHeader !== undefined &&
    rolesFromClaims(claims).includes(orchestratorRole) &&
    xTenantHeader.toLowerCase() !== (jwtTenantId ?? '').toLowerCase()
  ) {
    throw new OrchestratorTenantOverrideRemovedError();
  }

  // AUTH_BYPASS (dev stack, Playwright lanes): `validateAuth` hands every route
  // the synthetic `bypassUser()` carrying AUTH_BYPASS_TENANT_ID, but nothing
  // above verifies a token, so the FRAME had no tenant. `requireTenant` clients
  // (workers.ts, artifacts.ts) then refused every call with 409 MISSING_TENANT
  // under bypass. Put the same tenant on the frame — only when no verified
  // identity already named one, and only under the exact predicate
  // `validateAuth` uses (`process.env.AUTH_BYPASS === 'true'`, middleware/
  // auth.ts:90), which `validateProductionConfig` (config.ts:833) refuses to
  // boot with in production. Unset/blank ⇒ the frame stays tenantless (fail
  // closed): no default uuid is invented here, unlike `bypassUser()`'s
  // all-zeros fallback for the user object.
  if (tenantId === undefined && process.env.AUTH_BYPASS === 'true') {
    const bypassTenant = process.env.AUTH_BYPASS_TENANT_ID?.trim();
    if (bypassTenant) tenantId = bypassTenant;
  }

  // Bridge `coding` source needs the originating FR coding_analysis_runs id
  // to resolve a single ToolOutput on a cache miss (the opaque output_id
  // doesn't carry it). Plumbed via header so AG-UI / direct REST / agent
  // callers all share one channel; route handlers that receive job_id in
  // the body can also `withRequestContext` an updated frame.
  const codingJobId =
    req.headers.get('X-Coding-Job-Id') ??
    req.headers.get('x-coding-job-id') ??
    undefined;
  const ctx: RequestContext = {
    correlationId,
    initiator,
    channel,
    bearerToken,
    tenantId,
    userId,
    subjectId,
    activeTenantSource,
    // Which header carried the tenant, for consumers that cannot act on
    // `activeTenantSource`'s single `'header'` value. Always set on this path —
    // `buildRequestContext` is the ONE place that evaluates both headers, so it
    // is the only place that can answer the question truthfully.
    activeTenantVia,
    // What the token itself claimed, kept even when a header displaced it.
    // `activeTenantSource` says a header won; only this says what it won
    // against, and an upstream that ignores the forwarded tenant needs both to
    // notice it is being sent somewhere its caller is not looking.
    jwtTenantId,
    // SIGNED realm role only (claims is null for an agent token / no bearer).
    callerIsSuperAdmin,
    callerIsFrSuperAdminSession: callerIsSuperAdmin && sessionTrust === 'fr',
  };
  // An fr-minted Copilot token issued for a switched fr super-admin session
  // (agent-session.ts mints `super_admin_switch` only then).
  if (agentIdentity?.superAdminSwitch === true) ctx.agentSuperAdminSwitch = true;
  // George 2026-10-27 — every request a super_admin (or their switched Copilot
  // session) sends into a tenant other than their own is audited: one
  // `[super-admin-switch]` line per request (reads included, once per Request
  // like the counter). Writes also get a durable `super_admin_tenant_actions` row,
  // written by server.ts once the handler has answered or thrown
  // (lib/super-admin-tenant-audit.ts). ONE predicate for both:
  // `switchedSuperAdminFrame`.
  const switched = switchedSuperAdminFrame(ctx);
  if (switched && !_superAdminSwitchLogged.has(req)) {
    _superAdminSwitchLogged.add(req);
    recordSuperAdminSwitchRequest({
      actor: switched.actorUserId,
      tenantId: switched.tenantId,
      homeTenantId: switched.homeTenantId,
      via: switched.via,
      method: req.method,
      url: req.url,
    });
  }
  // The conveyor priority identity, from the SAME signed claims and predicate
  // validateAuth uses (keycloak.validateToken maps azp / preferred_username /
  // realm_access.roles onto the User exactly as read here).
  if (
    claims &&
    isConveyorActor({
      ...(typeof claims.azp === 'string' ? { azp: claims.azp } : {}),
      ...(typeof claims.preferred_username === 'string' ? { username: claims.preferred_username } : {}),
      roles: rolesFromClaims(claims),
    })
  ) {
    ctx.conveyorActor = true;
  }
  if (licence) {
    ctx.authKind = 'licence';
    if (licence.licenceSubjectId) ctx.licenceSubjectId = licence.licenceSubjectId;
    if (licence.licenseId) ctx.licenseId = licence.licenseId;
  }
  // The user's own portal token, kept ONLY when it can prove the effective
  // tenant to worker_management (#316). See `endUserTokenFromClaims`.
  const endUserToken = endUserTokenFromClaims(bearerToken, claims, tenantId);
  if (endUserToken) ctx.endUserToken = endUserToken;
  // An ACCEPTED super-admin X-Active-Tenant switch (never the read-only support
  // switch): keep the human bearer for the in-process run-the-UI-route lane
  // only (`RequestContext.superAdminSwitchToken`), so a confirmed agent write
  // from the switched view runs the route exactly as this request would.
  if (
    bearerToken &&
    claims &&
    tenantId &&
    activeTenantVia === 'active-tenant-header' &&
    tenantId !== jwtTenantId &&
    !isServiceAccountClaims(claims as Record<string, unknown>) &&
    typeof claims.sub === 'string' &&
    claims.sub.length > 0 &&
    isSuperAdmin({ roles: rolesFromClaims(claims) })
  ) {
    ctx.superAdminSwitchToken = { token: bearerToken, tenantId };
  }
  if (codingJobId) ctx.coding = { jobId: codingJobId };
  // A service account's `sub` is not a tenant (TENANCY_AND_IMPROVEMENT.md §2.4).
  // Only flagged while the tenant is still the JWT-derived one — a header
  // switch (X-Active-Tenant) displaces the sub and clears the concern.
  if (
    claims &&
    activeTenantSource === 'jwt' &&
    tenantId !== undefined &&
    isServiceAccountSubjectTenant(claims as Record<string, unknown>)
  ) {
    ctx.tenantIsServiceAccountSubject = true;
  }
  // fr#1448 — OBSERVATION ONLY. Counts the same sub-as-tenant shape for service
  // accounts AND the listed system-operator users (FR_SYSTEM_OPERATOR_SUBS),
  // which the flag above deliberately does not cover. Reads only the values
  // above, writes nothing to ctx, never throws.
  observeTenantFromSub(req, {
    claims: claims as Record<string, unknown> | undefined,
    tenantId,
    activeTenantSource,
  });
  return ctx;
}

export async function withRequestContextFromReq<T>(
  req: Request,
  fn: (ctx: RequestContext) => Promise<T>,
): Promise<T> {
  const ctx = await buildRequestContext(req);
  return withRequestContext(ctx, () => fn(ctx));
}
