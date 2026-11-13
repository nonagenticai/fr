// src/services/teams-jwt.ts
// Bot Framework JWT verification for Teams action-callback webhooks.
// See https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { keycloak as defaultKeycloak } from './keycloak';

const BOT_APP_ID = process.env.TEAMS_BOT_APP_ID ?? '';
const JWKS_URL =
  process.env.TEAMS_JWKS_URL ?? 'https://login.botframework.com/v1/.well-known/keys';

/**
 * Keycloak IdP alias the Teams bot is federated under. Defaults to "teams".
 * If your realm uses a different alias (e.g. "azure" for the same AAD
 * tenant), set `TEAMS_KEYCLOAK_IDP_ALIAS=azure`. Read at call time so
 * tests can flip the env after module load.
 */
function getTeamsIdpAlias(): string {
  return process.env.TEAMS_KEYCLOAK_IDP_ALIAS ?? 'teams';
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));
  return jwks;
}

/**
 * Verify a Bot Framework signed JWT. Returns the Azure AD object id (oid) and
 * tenant id (tid) claims that identify the Teams user who clicked the card.
 * Throws when the token is invalid, expired, or missing required claims.
 */
export async function verifyTeamsJwt(token: string): Promise<{ oid: string; tid: string }> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: 'https://api.botframework.com',
    audience: BOT_APP_ID,
  });
  if (!payload.oid || !payload.tid) throw new Error('missing oid/tid claim');
  return { oid: String(payload.oid), tid: String(payload.tid) };
}

/**
 * Result of mapping a verified Teams identity to a Keycloak user id.
 *
 * - `mapped` — Keycloak resolved the federated identity to a single user.
 * - `not-found` — Keycloak admin API responded but no user is federated
 *    under (idpAlias=<alias>, idpUserId=oid). The caller MUST NOT silently
 *    fall back to a different identity — recording the decision under a
 *    different user would break audit.
 * - `not-configured` — Keycloak admin client / IdP alias not provisioned
 *    yet, OR Keycloak is unreachable. Caller may fall back to its
 *    pre-mapping resolution chain (required-approver / requester).
 *
 * This shape replaces the previous `Promise<string | null>` return so
 * callers can't conflate "mapping failed because we haven't wired Keycloak"
 * with "the user clicking is not federated, reject this decision".
 */
export type TeamsIdentityMapping =
  | { kind: 'mapped'; userId: string }
  | { kind: 'not-found' }
  | {
      kind: 'not-configured';
      code: 'KEYCLOAK_NOT_CONFIGURED';
      reason: string;
    };

/**
 * Map verified Teams identity claims to an internal Keycloak user id via
 * the federated-identity admin search:
 *
 *   GET /admin/realms/{realm}/users?idpAlias={alias}&idpUserId={oid}
 *
 * Distinguishes three outcomes — mapped / not-found / not-configured — so
 * the webhook handler can fail-closed on "this Teams user isn't on the
 * approver list" while still soft-falling-back when the bot tenant
 * federation hasn't been provisioned yet.
 */
export async function mapTeamsIdentityToUserId(
  claims: { oid: string; tid: string },
): Promise<TeamsIdentityMapping> {
  const alias = getTeamsIdpAlias();
  if (!alias) {
    return {
      kind: 'not-configured',
      code: 'KEYCLOAK_NOT_CONFIGURED',
      reason: 'TEAMS_KEYCLOAK_IDP_ALIAS is not set',
    };
  }

  let userId: string | null;
  try {
    userId = await defaultKeycloak.findUserByFederatedIdentity(alias, claims.oid);
  } catch (err) {
    // findUserByFederatedIdentity is non-throwing by contract, but we treat
    // an unexpected throw as "not configured / Keycloak unreachable" so the
    // caller can soft-fall-back rather than rejecting a legitimate
    // approver because the admin API blipped.
    return {
      kind: 'not-configured',
      code: 'KEYCLOAK_NOT_CONFIGURED',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (userId) return { kind: 'mapped', userId };
  return { kind: 'not-found' };
}
