// src/lib/super-admin-session-trust.ts
//
// ⭐ George 2026-10-27 + coordinator decision: the super_admin tenant-admin arm
// (switch into any live customer workspace, act there as tenant-admin) is
// honoured ONLY for an FR SUPER-ADMIN SESSION — a HUMAN token signed by the fr
// realm issuer (FR_SUPER_ADMIN_SWITCH_ISSUER) for fr's browser client
// (FR_SUPER_ADMIN_SWITCH_AZP). Both unset ⇒ nothing is trusted (fail closed).
//
// ONE classifier for every surface, on the SIGNED claims:
//   * the REST gate (`buildRequestContext`, middleware/request-context.ts);
//   * the kanban / approvals WebSocket upgrade — `keycloak.validateToken` stamps
//     the same answer on the `User` it returns (`User.superAdminSessionTrust`),
//     so the socket never re-derives it from a narrower `User` view.
// Pure (config + utils/tenant only), so services/keycloak.ts can import it.

import { frSuperAdminSessionAzps, frSuperAdminSessionIssuers } from '../config';
import { isServiceAccountClaims } from '../utils/tenant';

/**
 * Who presented the super_admin token:
 *   - `fr`                — a human on fr's own login (fr realm issuer + fr browser client);
 *   - `service_account`   — a client-credentials token, whatever roles it carries;
 *   - `untrusted_session` — a human token from any other issuer or client.
 */
export type SuperAdminSessionTrust = 'fr' | 'service_account' | 'untrusted_session';

/**
 * Classify a token from its SIGNED claims. Service account first: fr's own
 * detector `isServiceAccountClaims` (`preferred_username` starting
 * `service-account-`, or a `client_id` / `clientId` claim), Keycloak's
 * client-credentials mappers `clientHost` / `clientAddress`, and a missing
 * `sub` or `preferred_username` (a signed-in human has both). Then `iss` must be
 * in FR_SUPER_ADMIN_SWITCH_ISSUER and `azp` in FR_SUPER_ADMIN_SWITCH_AZP
 * (config.ts — no defaults). `undefined` claims ⇒ untrusted.
 */
export function superAdminSessionTrustFromClaims(
  claims: Record<string, unknown> | undefined,
): SuperAdminSessionTrust {
  if (!claims) return 'untrusted_session';
  if (isServiceAccountClaims(claims)) return 'service_account';
  if (claims.clientHost !== undefined || claims.clientAddress !== undefined) return 'service_account';
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return 'service_account';
  const username = claims.preferred_username;
  if (typeof username !== 'string' || username.length === 0) return 'service_account';
  const iss = typeof claims.iss === 'string' ? claims.iss.replace(/\/+$/, '') : '';
  const azp = typeof claims.azp === 'string' ? claims.azp : '';
  return iss && azp && frSuperAdminSessionIssuers().includes(iss) && frSuperAdminSessionAzps().includes(azp)
    ? 'fr'
    : 'untrusted_session';
}
