// src/lib/service-authenticators.ts
import { ServiceAuthenticator } from './service-auth';
import { config } from '../config';

/**
 * Service Authenticators for OAuth2 Client Credentials Flow
 * 
 * This module provides pre-configured authenticators for backend services
 * that need to authenticate with external APIs.
 * 
 * The fr-frontend client has the following roles:
 * - access-secrets: Access to secrets.example.com API
 * - access-licenses: Access to licenses.example.com API  
 * - access-kag: Access to kag.example.com API
 */

// Single authenticator instance for all services (shared token)
// The token includes all three roles: access-secrets, access-licenses, access-kag
let serviceAuthenticator: ServiceAuthenticator | null = null;

/**
 * Get the service authenticator instance
 * Lazy initialization to ensure config is available
 */
export function getServiceAuthenticator(): ServiceAuthenticator {
  // Realm-per-app P7 chain C ("realm portal = staff only"): the S2S token moves to
  // secure-apps by ENV, not by code, so the flip lands in the same gitops change as the
  // receivers that start accepting it (provisioning PROVISION_ISSUERS, IR's admin JWKS,
  // CP's fr-feedback door) — and kag-frontend, which runs this same image on portal
  // (kag stays on portal), is untouched by leaving the variable unset.
  if (serviceTokenUsesSecureApps()) return getSecureAppsAuthenticator();
  if (!serviceAuthenticator) {
    serviceAuthenticator = new ServiceAuthenticator({
      keycloakUrl: config.keycloak.url,
      realm: config.keycloak.realm,
      clientId: config.keycloak.clientId,
      clientSecret: config.keycloak.clientSecret,
      refreshBuffer: 60, // Refresh token 60 seconds before expiry
    });
  }
  
  return serviceAuthenticator;
}

/**
 * KEYCLOAK_SERVICE_REALM — the realm fr's S2S token (licenses regenerate-token, provisioning,
 * the IR admin API, CommonPractice fr-feedback) is minted from. Unset/empty = today's
 * KEYCLOAK_REALM + KEYCLOAK_CLIENT_ID client (byte-identical). The ONLY other accepted value is
 * the secure-apps realm (KEYCLOAK_SECURE_APPS_REALM): the token is then the secure-apps
 * fr-backend client's — the SAME singleton `getSecureAppsAuthenticator()` already uses (one
 * client, one cache). Any other value THROWS on first use: fr holds no client in another realm,
 * and silently minting from portal would defeat the flip.
 */
export function serviceTokenUsesSecureApps(): boolean {
  const want = (process.env.KEYCLOAK_SERVICE_REALM ?? '').trim();
  if (want === '') return false;
  const secureApps = (process.env.KEYCLOAK_SECURE_APPS_REALM ?? '').trim();
  if (secureApps !== '' && want === secureApps) return true;
  throw new Error(
    `[fr] KEYCLOAK_SERVICE_REALM=${JSON.stringify(want)} must be empty or equal KEYCLOAK_SECURE_APPS_REALM ` +
      `(${JSON.stringify(secureApps)}): fr has no service client in any other realm`,
  );
}

/**
 * Get authenticator for secrets.example.com API
 * Uses client with access-secrets role
 */
export function getSecretsAuthenticator(): ServiceAuthenticator {
  return getServiceAuthenticator();
}

/**
 * Get authenticator for licenses.example.com API
 * Uses client with access-licenses role
 */
export function getLicensesAuthenticator(): ServiceAuthenticator {
  return getServiceAuthenticator();
}

/**
 * Get authenticator for kag.example.com API
 * Uses client with access-kag role
 */
export function getKagAuthenticator(): ServiceAuthenticator {
  return getServiceAuthenticator();
}

// ----- secure-apps realm authenticator (metering-service writes) ---------
//
// metering-service verifies JWTs against the `secure-apps` realm, not
// `portal`. The portal-realm fr-backend client signs tokens with a kid that
// secure-apps doesn't know, so its tokens are rejected at metering's
// `require_internal` gate. We mint a separate Bearer through the
// `fr-backend` client in `secure-apps` (created 2026-05-05) — the
// service-account user holds `license-admin`, `service-internal` and
// `default-roles-secure-apps` in that realm (read back from Keycloak with
// kcadm 2026-08-11). `license-admin` is the grant that satisfies billing's
// `require_pricing_writer` on the money-config writes, and its
// `require_admin` / `require_pricing_admin` siblings.
//
// It does NOT hold `metering-internal`: that role was revoked fleet-wide and
// the realm role deleted (billing_service/src/auth_deps.py records the
// 2026-07-16 retirement). The comment here claimed otherwise until 2026-08-11.
//
// Env-driven: KEYCLOAK_SECURE_APPS_URL / KEYCLOAK_SECURE_APPS_REALM /
// KEYCLOAK_SECURE_APPS_CLIENT_ID / KEYCLOAK_SECURE_APPS_CLIENT_SECRET.
// All four default to the portal-realm values when unset, so dev /
// integration tests that only have a single Keycloak realm still work.
let secureAppsAuthenticator: ServiceAuthenticator | null = null;

export function getSecureAppsAuthenticator(): ServiceAuthenticator {
  if (!secureAppsAuthenticator) {
    secureAppsAuthenticator = new ServiceAuthenticator({
      keycloakUrl: process.env.KEYCLOAK_SECURE_APPS_URL ?? config.keycloak.url,
      realm:
        process.env.KEYCLOAK_SECURE_APPS_REALM ?? config.keycloak.realm,
      clientId:
        process.env.KEYCLOAK_SECURE_APPS_CLIENT_ID ??
        config.keycloak.clientId,
      clientSecret:
        process.env.KEYCLOAK_SECURE_APPS_CLIENT_SECRET ??
        config.keycloak.clientSecret,
      refreshBuffer: 60,
    });
  }
  return secureAppsAuthenticator;
}


