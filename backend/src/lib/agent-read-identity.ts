// src/lib/agent-read-identity.ts
//
// fr-agui SPEC §5.7 / P1b — the identity the AGENT lanes (thread routes,
// `/api/agent/chat`) hand to the project READ gate (`loadProjectForRead` /
// `projectIdsReadableAsGetProject`).
//
// ⛔ THE DEFECT THIS CLOSES (P1a audit, carried into P1b). The thread routes
// passed the agent token's bare `{id, tenantId}` to the read predicate. That
// subject has no realm roles, so the super-admin home-view lane of
// `GET /api/projects/:id` could never be taken: for a super-admin the agent's
// answer was STRICTER than the GET's for the same person. It failed closed (no
// leak), but "the agent can read exactly what the UI can" was false.
//
// The roles come from the portal token the browser forwards as
// `X-End-User-Token` — a SIGNED Keycloak claim, verified the same way
// `verifyForwardedEndUserToken` verifies it (same user, tenant proven, human).
// Never from the fr-minted agent token, whose claims must never satisfy
// `isSuperAdmin` (lib/agent-token.ts).
//
// LICENCE CALLERS. A licence bearer cannot reach these lanes: the agent token
// is minted only by `POST /api/agui/session/issue`, which is not on the licence
// route allowlist (deny by default), so `authKind` is never 'licence' here and
// is left unset (the GET's non-licence branch — the same answer).

import { db } from '../db/client';
import { END_USER_TOKEN_HEADER } from '../integrations/_lib/http-client';
import { verifiedEndUserRealmRoles } from '../middleware/request-context';
import { NotFoundError } from '../utils/errors';
import { loadProjectForRead } from './project-access';
import { userHomedIn, userMaySuperAdminSwitchInto } from '../services/user-home-tenant';

export interface AgentReadIdentity {
  id: string;
  tenantId: string;
  /** Keycloak realm roles from the VERIFIED forwarded portal token; `[]` without one. */
  roles: string[];
}

/**
 * The read identity for an agent-token request, or null when the token names
 * no tenant (fails closed: every read predicate needs one).
 */
export async function agentReadIdentity(
  req: Request,
  verified: { userId: string; tenantId: string | null },
): Promise<AgentReadIdentity | null> {
  if (!verified.tenantId) return null;
  const roles = await verifiedEndUserRealmRoles(req.headers.get(END_USER_TOKEN_HEADER), {
    tenantId: verified.tenantId,
    userId: verified.userId,
  });
  return { id: verified.userId, tenantId: verified.tenantId, roles };
}

/**
 * `loadProjectForRead` as a boolean for an agent identity: its 404 (foreign,
 * untagged, missing, malformed — every unreadable shape) is `false`; any other
 * error propagates. No identity (no tenant) is `false`.
 */
export async function agentCanReadProject(
  identity: AgentReadIdentity | null,
  projectId: string,
  handle: typeof db = db,
): Promise<boolean> {
  if (identity === null) return false;
  try {
    await loadProjectForRead(handle, identity, projectId);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

/**
 * fr-agui SPEC §5.7 rule 2 / §10.2 (P1-TEAM-a): is the agent token's tenant
 * STILL the user's Keycloak home tenant? The token's tenant was frozen when the
 * session was issued (refresh re-checks it, but an access token lives 15
 * minutes), and since P1-TEAM that tenant grants every project of it — so a
 * user re-homed from A to B must lose the agent on A at the next turn, not at
 * the next refresh.
 *
 *   'current'     — Keycloak says the user is active and homed in `tenantId`;
 *   'changed'     — re-homed, removed, disabled or deleted (or no tenant at all);
 *   'unavailable' — Keycloak could not be read. FAIL CLOSED: the caller refuses
 *                   (retriable), it never proceeds on an unverified tenant.
 *
 * Cached per user for 15 s (services/user-home-tenant.ts), so it is cheap per turn.
 */
export type AgentTenantCheck = 'current' | 'changed' | 'unavailable';

export async function agentTenantStillCurrent(
  userId: string,
  tenantId: string | null | undefined,
  superAdminSwitch = false,
): Promise<AgentTenantCheck> {
  try {
    // George 2026-10-27: a token minted from a super-admin WORKSPACE SWITCH names
    // the active workspace, not the home, so it is re-checked against what the
    // REST switch gate would still admit (active + still `super_admin` + still a
    // switch target), never against the home tenant. Same 15 s cache, same
    // fail-closed throw. A token without the claim is unchanged.
    const ok = superAdminSwitch
      ? await userMaySuperAdminSwitchInto(userId, tenantId)
      : await userHomedIn(userId, tenantId);
    return ok ? 'current' : 'changed';
  } catch (err) {
    console.warn('[agent-read-identity] home-tenant lookup failed; turn refused', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unavailable';
  }
}

/**
 * The refusal an agent-token request gets when its tenant is no longer the
 * user's Keycloak home tenant — or `null` to proceed. ONE gate for EVERY route
 * that accepts the fr-agent token (`/api/agui/invoke`, `/api/agent/chat` bound
 * AND unbound, every `/api/agui/threads` verb): a token is worth exactly the
 * tenant it names, and since P1-TEAM that tenant grants every project of it, so
 * a re-homed user must lose ALL of them at once, not only a bound chat turn
 * (P1-TEAM-a delta audit: invoke `projects.get`/`projects.list` answered A's
 * project to a user homed in B, with 0 home lookups).
 *
 *   'changed'     → 403 `tenant_changed` (also a token with no tenant at all —
 *                   nothing to check it against, so it fails closed);
 *   'unavailable' → 503 `identity_unavailable`, `Retry-After: 5` (fail closed).
 *
 * Callers render it in their own envelope (NDJSON line or JSON body); the code,
 * status and header are the same everywhere.
 */
export interface AgentTenantRefusal {
  code: 'tenant_changed' | 'identity_unavailable';
  status: 403 | 503;
  message: string;
  headers: Record<string, string>;
}

export async function agentTenantRefusal(verified: {
  userId: string;
  tenantId: string | null | undefined;
  /** The token's `super_admin_switch` claim (lib/agent-token.ts); absent ⇒ false. */
  superAdminSwitch?: boolean;
}): Promise<AgentTenantRefusal | null> {
  const check = await agentTenantStillCurrent(
    verified.userId,
    verified.tenantId,
    verified.superAdminSwitch === true,
  );
  if (check === 'current') return null;
  if (check === 'changed') {
    return {
      code: 'tenant_changed',
      status: 403,
      message: 'Your workspace changed since this agent session started. Reload the page to start a new session.',
      headers: {},
    };
  }
  return {
    code: 'identity_unavailable',
    status: 503,
    message: 'Your workspace could not be confirmed right now — try again in a moment.',
    headers: { 'Retry-After': '5' },
  };
}
