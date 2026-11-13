// src/lib/agent-token.ts
//
// The FR-issued agent access token — audience, signing secret, and verification
// — in ONE place.
//
// WHY THIS MODULE EXISTS. fr has two token shapes on `Authorization: Bearer`:
// Keycloak's RS256 user/service tokens, and this HS256 `aud=fr-agent` token that
// fr mints itself for AG-UI callers. Only the routes knew about the second one.
// `middleware/request-context.ts` verifies with a Keycloak-only JWKS verifier and
// silently returns `undefined` on failure, so for an agent-token request the
// request-scoped identity frame came out EMPTY — even though the route one
// function later verified the same token successfully and read a tenant off it.
//
// MEASURED 2026-09-03 in `billing_metering_events` over 9 days, and the split is
// exact — the token shape predicts the outcome with zero exceptions:
//
//   /api/agui/invoke           477 rows   477 nil-tenant    0 attributed
//   /api/agui/threads          175 rows   175 nil-tenant    0 attributed
//   /api/agui/session/refresh  108 rows   108 nil-tenant    0 attributed
//   /api/agui/session/issue     66 rows     0 nil-tenant   66 attributed  <- Keycloak JWT
//   /api/agui/actions            1 row      0 nil-tenant    1 attributed  <- Keycloak JWT
//
// `session/issue` is where the agent token is MINTED, so it arrives carrying a
// Keycloak JWT and attributes correctly. The three routes that arrive carrying
// the minted agent token attribute to nobody: 760 events, 84.4/day, metered to
// the nil tenant and therefore un-billable.
//
// ⚠️ It also removes a real duplication: the secret resolution below existed
// TWICE, in `routes/agui.ts` and `services/agent-session.ts`, so a change to how
// the secret is sourced had two places to remember. The module that owns minting
// and the module that owns verifying must agree by construction, not by care.

import { jwtVerify, type JWTPayload } from 'jose';

/** Audience on every FR-issued agent token. */
export const AGENT_TOKEN_AUDIENCE = 'fr-agent';

/**
 * Secret that signs and verifies agent tokens.
 *
 * Read at call time, not module load: `config` snapshots env at import, and the
 * test setup sets these after that. Same reasoning as `integrations/n8n.ts`.
 */
export function agentTokenSecret(): Uint8Array {
  const secret =
    process.env.FR_AGENT_JWT_SECRET ||
    process.env.JWT_SECRET_KEY ||
    'dev-only-fr-agent-secret-change-me';
  return new TextEncoder().encode(secret);
}

/**
 * Claim on an agent token minted from a SUPER-ADMIN WORKSPACE SWITCH (George
 * 2026-10-27): `tenant_id` is then the ACTIVE workspace the UI showed at session
 * issue, not the user's home. Its only effect is WHICH per-call re-check the
 * token gets (`agentTenantRefusal`, lib/agent-read-identity.ts): the user must
 * still be active AND still hold `super_admin` AND the tenant must still be a
 * switch target — instead of `userHomedIn`. It grants nothing by itself: it is
 * fr-signed, and a token without it is re-checked exactly as before.
 */
export const SUPER_ADMIN_SWITCH_CLAIM = 'super_admin_switch';

/** True iff the verified claims carry the switch marker as the literal `true`. */
export function superAdminSwitchFromClaims(claims: Record<string, unknown>): boolean {
  return claims[SUPER_ADMIN_SWITCH_CLAIM] === true;
}

/** What an agent token asserts about its bearer. */
export interface AgentTokenIdentity {
  userId: string;
  /**
   * Tenant carried on the token (migration 097). `null` on tokens minted before
   * it — callers fall back to their own resolution.
   */
  tenantId: string | null;
  /**
   * ⛔ TENANT roles from fr's own table — NOT Keycloak realm roles. They must
   * never be fed to `isSuperAdmin` or the `aa-orchestrator` check: those gate
   * header-driven tenant OVERRIDES on a SIGNED Keycloak claim, and letting an
   * fr-minted token satisfy them would let an agent nominate any tenant.
   */
  tenantRoles: string[];
  /** Minted from a super-admin workspace switch (`SUPER_ADMIN_SWITCH_CLAIM`). */
  superAdminSwitch: boolean;
}

// fr-agui SPEC §5.7 rule 2 (P1b): there is NO `project_id` claim. It was parsed
// here but never minted (services/agent-session.ts), so it could only ever be
// null — or, if someone started minting it, a SECOND source for the agent's
// project next to the thread binding. The project is the thread's
// (`agent_runtime_sessions.project_id`), read on every turn by routes/agent.ts.
interface AgentTokenClaims extends JWTPayload {
  tenant_roles?: unknown;
  tenant_id?: unknown;
}

/**
 * VERIFY (not decode) an agent token. Returns null for anything that is not a
 * valid, in-date, correctly-audienced FR agent token — including a Keycloak
 * token, which is signed with a different algorithm and key.
 *
 * Verification is real: an unsigned or foreign-signed JWT must not be able to
 * populate the identity frame, which is what `X-Tenant-Id` / `X-Subject-Id`
 * forwarding and metering attribution are read from.
 */
export async function verifyAgentTokenClaims(
  token: string | undefined,
): Promise<AgentTokenIdentity | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, agentTokenSecret(), {
      audience: AGENT_TOKEN_AUDIENCE,
    });
    const claims = payload as AgentTokenClaims;
    const userId = typeof claims.sub === 'string' ? claims.sub : null;
    if (!userId) return null;
    return {
      userId,
      tenantId:
        typeof claims.tenant_id === 'string' && claims.tenant_id
          ? claims.tenant_id
          : null,
      tenantRoles: Array.isArray(claims.tenant_roles)
        ? claims.tenant_roles.filter((r): r is string => typeof r === 'string')
        : [],
      superAdminSwitch: superAdminSwitchFromClaims(claims),
    };
  } catch {
    // Not an agent token (a Keycloak token lands here, and so does a forgery).
    // The caller decides what that means; this function only answers the
    // question it was asked.
    return null;
  }
}
