// Realm-per-app P7 chain C ("realm portal = staff only"): fr's S2S token moves to
// secure-apps by ENV (KEYCLOAK_SERVICE_REALM), so the flip ships in the same gitops change
// as the receivers that accept it, and kag-frontend (same image, kag stays on portal) is
// untouched by leaving the variable unset.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { keycloakRealmConfigProblems } from '../../../src/config';
import {
  getSecureAppsAuthenticator,
  getServiceAuthenticator,
  serviceTokenUsesSecureApps,
} from '../../../src/lib/service-authenticators';

const KEYS = ['KEYCLOAK_SERVICE_REALM', 'KEYCLOAK_SECURE_APPS_REALM'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('KEYCLOAK_SERVICE_REALM', () => {
  test('unset: the default (KEYCLOAK_REALM) client, a different singleton from secure-apps', () => {
    delete process.env.KEYCLOAK_SERVICE_REALM;
    process.env.KEYCLOAK_SECURE_APPS_REALM = 'secure-apps';
    expect(serviceTokenUsesSecureApps()).toBe(false);
    expect(getServiceAuthenticator()).not.toBe(getSecureAppsAuthenticator());
  });

  test('blank is unset', () => {
    process.env.KEYCLOAK_SERVICE_REALM = '  ';
    process.env.KEYCLOAK_SECURE_APPS_REALM = 'secure-apps';
    expect(serviceTokenUsesSecureApps()).toBe(false);
  });

  test('= the secure-apps realm: the S2S token IS the secure-apps fr-backend authenticator', () => {
    process.env.KEYCLOAK_SECURE_APPS_REALM = 'secure-apps';
    process.env.KEYCLOAK_SERVICE_REALM = 'secure-apps';
    expect(serviceTokenUsesSecureApps()).toBe(true);
    expect(getServiceAuthenticator()).toBe(getSecureAppsAuthenticator());
  });

  test('any other realm throws instead of silently minting from portal', () => {
    process.env.KEYCLOAK_SECURE_APPS_REALM = 'secure-apps';
    process.env.KEYCLOAK_SERVICE_REALM = 'fr';
    expect(() => getServiceAuthenticator()).toThrow('KEYCLOAK_SERVICE_REALM');
  });

  test('set while KEYCLOAK_SECURE_APPS_REALM is unset throws', () => {
    delete process.env.KEYCLOAK_SECURE_APPS_REALM;
    process.env.KEYCLOAK_SERVICE_REALM = 'secure-apps';
    expect(() => serviceTokenUsesSecureApps()).toThrow('KEYCLOAK_SECURE_APPS_REALM');
  });

  test('boot validation names the variable for a wrong realm, and is silent when it matches', () => {
    process.env.KEYCLOAK_SECURE_APPS_REALM = 'secure-apps';
    process.env.KEYCLOAK_SERVICE_REALM = 'portal';
    const pins = { intake: [] as string[], decider: [] as string[] };
    expect(keycloakRealmConfigProblems(pins).join('\n')).toContain('KEYCLOAK_SERVICE_REALM (portal is not');
    process.env.KEYCLOAK_SERVICE_REALM = 'secure-apps';
    expect(keycloakRealmConfigProblems(pins).join('\n')).not.toContain('KEYCLOAK_SERVICE_REALM');
  });
});
