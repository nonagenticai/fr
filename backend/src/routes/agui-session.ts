// src/routes/agui-session.ts
//
// E-13 — agent session refresh endpoints.
//
// - POST /api/agui/session/issue   (Keycloak-authed) — mint a new agent
//   session and return the raw refresh token exactly once.
// - POST /api/agui/session/refresh (UNAUTHENTICATED at the bearer layer —
//   the refresh token in the body IS the credential) — exchange refresh
//   token for a short-lived FR access token. Rotates.
// - POST /api/agui/session/:id/revoke (Keycloak-authed) — revoke a single
//   session id.
//
// See docs/superpowers/specs/completed/2026-04-25-e13-agent-session-token-refresh.md.

import { z } from 'zod';
import { validateAuth } from '../middleware/auth';
import {
  issueAgentSession,
  peekAgentSessionOwner,
  refreshAgentSession,
  revokeAgentSession,
  ReplayDetectedError,
  ExpiredError,
  InvalidRefreshTokenError,
  SessionTenantChangedError,
  SessionUserInactiveError,
  SessionUserUnverifiableError,
} from '../services/agent-session';
import { attributeRequestTo } from '../integrations/_lib/context';
import { isSuperAdminSwitchedInto, superAdminSwitchedTenant } from '../lib/super-admin-switch';
import type { User } from '../types/api';
import { createdResponse, jsonResponse, noContentResponse } from '../utils/response';

const RefreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

/**
 * The tenant an agent session issued on THIS request acts in — the ACTIVE
 * workspace for a super-admin workspace switch (George 2026-10-27: "I just need to
 * be able to work as a tenant-admin in every tenant I open").
 *
 * The request frame (`buildRequestContext`) is the authority, exactly as for
 * every REST route: it accepts `X-Active-Tenant` only for a SIGNED `super_admin`
 * naming a switch target, and has ALREADY refused a super-admin's
 * non-permitted target (403 `active_tenant_not_permitted`) before this handler
 * runs. A non-super-admin's header was ignored there, so they get the home
 * tenant here, as before. The switch is honoured only when the frame was built
 * from the SAME user `validateAuth` verified and also carries the signed role.
 */
function sessionTenantFor(user: User): string | null {
  const switched = superAdminSwitchedTenant();
  if (switched !== undefined && switched !== user.tenantId && isSuperAdminSwitchedInto(user, switched)) {
    return switched;
  }
  return user.tenantId ?? null;
}

/**
 * POST /api/agui/session/issue
 * Auth: existing Keycloak bearer token (the user's web-UI session).
 */
export async function handleIssueAgentSession(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  // Persist the Keycloak-resolved tenant on the session. This request is the
  // ONLY point in the agent-session lifecycle where a Keycloak USER token exists —
  // refresh authenticates with the refresh token alone, and `/api/agui/invoke`
  // sees only the agent access token. Without this, the invoke path's sole
  // tenant source was `user_roles`, which almost no user has a row in.
  // ⛔ P1-TEAM-a: the value stored here is NOT frozen for the chain. Every
  // refresh re-derives the tenant through the Keycloak admin API and revokes a
  // session whose user was re-homed (`session_tenant_changed`,
  // services/agent-session.ts); every agent-token request re-checks it too.
  // George 2026-10-27: a super-admin's ACCEPTED workspace switch is honoured —
  // the session acts in the workspace the UI shows (`sessionTenantFor`), and
  // refresh + every agent call re-prove super_admin instead of the home tenant.
  const { sessionId, refreshToken } = await issueAgentSession(user.id, sessionTenantFor(user));
  return createdResponse({ sessionId, refreshToken });
}

/**
 * The user id of a VALID bearer on this request, or null when there is none.
 *
 * Only consulted when an `Authorization: Bearer …` header is actually present —
 * a bearer-less (machine) refresh must never reach `validateAuth`, which under
 * AUTH_BYPASS would otherwise invent an identity for it. A bearer that fails
 * validation (expired Keycloak token, garbage) is treated as ABSENT, not as a
 * mismatch: the refresh token stays the credential, exactly as before.
 */
async function bearerUserId(req: Request): Promise<string | null> {
  const header = req.headers.get('Authorization');
  if (!header || !/^Bearer\s+\S/i.test(header)) return null;
  try {
    const user = await validateAuth(req);
    return typeof user?.id === 'string' && user.id.length > 0 ? user.id : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/agui/session/refresh
 * Auth: NONE at bearer layer — the refresh token in the body is the credential.
 *
 * Defence in depth (cross-user leak, 2026-09-30): the browser persists the
 * refresh token in localStorage, so the NEXT Keycloak user of the same browser
 * could present the PREVIOUS user's token and silently inherit that agent
 * identity (their threads, their tenant). When the caller DOES send a valid
 * Keycloak bearer, it must be the same user the session belongs to; otherwise
 * 401 `session_user_mismatch`.
 *
 * Ordering: the owner is read with the side-effect-free
 * `peekAgentSessionOwner` BEFORE `refreshAgentSession`, so a mismatch neither
 * rotates nor revokes — the rightful owner's chain is untouched. An unknown
 * token (owner null) falls through to the refresh, which reports it as invalid.
 */
export async function handleRefreshAgentSession(req: Request): Promise<Response> {
  let parsed: { refreshToken: string };
  try {
    const body = await req.json();
    parsed = RefreshBodySchema.parse(body);
  } catch {
    return jsonResponse({ error: 'refresh_token_invalid' }, 400);
  }

  const callerUserId = await bearerUserId(req);
  if (callerUserId !== null) {
    const ownerUserId = await peekAgentSessionOwner(parsed.refreshToken);
    if (ownerUserId !== null && ownerUserId !== callerUserId) {
      console.warn('[agent-session] session_user_mismatch: refresh refused', {
        correlationId: req.headers.get('x-correlation-id') ?? null,
      });
      return jsonResponse({ error: 'session_user_mismatch' }, 401);
    }
  }

  try {
    const result = await refreshAgentSession(parsed.refreshToken);
    // ⚠️ The identity arrives HERE, not from the bearer layer: this route is
    // unauthenticated at `Authorization`, so `buildRequestContext` had nothing
    // to verify and left the metering span un-attributed (measured 4/4 events
    // nil-tenant on prod). Only a refresh that SUCCEEDED gets attributed — a
    // replayed / expired / invalid / mismatched one attributes to nobody.
    attributeRequestTo({ userId: result.userId, tenantId: result.tenantId });
    return jsonResponse({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    if (err instanceof ReplayDetectedError) {
      // Spec: WARN log line so operators can investigate.
      console.warn(
        '[agent-session] refresh_token_replayed: chain revoked',
        { correlationId: req.headers.get('x-correlation-id') ?? null },
      );
      return jsonResponse({ error: 'refresh_token_replayed' }, 401);
    }
    if (err instanceof ExpiredError) {
      return jsonResponse({ error: 'refresh_token_expired' }, 401);
    }
    if (err instanceof InvalidRefreshTokenError) {
      return jsonResponse({ error: 'refresh_token_invalid' }, 401);
    }
    if (err instanceof SessionUserInactiveError) {
      // The Keycloak user was deleted or disabled; the row is now revoked.
      return jsonResponse({ error: 'session_user_inactive' }, 401);
    }
    if (err instanceof SessionTenantChangedError) {
      // P1-TEAM-a: the user was re-homed (Keycloak `tenant_id` changed); the row
      // is now revoked. Re-issue from the CURRENT Keycloak session.
      return jsonResponse({ error: 'session_tenant_changed' }, 401);
    }
    if (err instanceof SessionUserUnverifiableError) {
      // Keycloak could not be asked. Nothing rotated — retry with the same token.
      return jsonResponse({ error: 'identity_unavailable' }, 503);
    }
    throw err;
  }
}

/**
 * POST /api/agui/session/:id/revoke
 * Auth: Keycloak bearer token.
 */
export async function handleRevokeAgentSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // Scope to the caller — revoking by id alone is an IDOR (any authed user
  // could kill another user's agent session). 404 when no owned row matched.
  const revoked = await revokeAgentSession(sessionId, user.id);
  if (!revoked) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  return noContentResponse();
}
