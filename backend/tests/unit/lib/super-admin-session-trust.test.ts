// tests/unit/lib/super-admin-session-trust.test.ts
//
// George 2026-10-27 + coordinator decision: the super_admin tenant-admin arm is
// honoured ONLY for an fr super-admin session, and FAILS CLOSED: with
// FR_SUPER_ADMIN_SWITCH_ISSUER / _AZP unset nothing is trusted — and no default
// may ever be derived that lands on the portal realm. This is the ONE classifier
// the REST gate and the WS upgrade (via keycloak.validateToken) both use.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { superAdminSessionTrustFromClaims } from '../../../src/lib/super-admin-session-trust';
import { superAdminSwitchConfigWarning } from '../../../src/config';

const FR = 'https://auth.nonagentic.ai/realms/fr';
const PORTAL = 'https://auth.nonagentic.ai/realms/portal';
const ENV = ['FR_SUPER_ADMIN_SWITCH_ISSUER', 'FR_SUPER_ADMIN_SWITCH_AZP', 'KEYCLOAK_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_USER_REALM', 'KEYCLOAK_ISSUER'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.FR_SUPER_ADMIN_SWITCH_ISSUER = FR;
  process.env.FR_SUPER_ADMIN_SWITCH_AZP = 'fr-frontend';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const human = (over: Record<string, unknown> = {}) => ({
  iss: FR,
  azp: 'fr-frontend',
  sub: 'b9e40000-0000-4000-8000-000000000001',
  preferred_username: 'fr-test',
  ...over,
});

describe('superAdminSessionTrustFromClaims', () => {
  test('fr realm + fr-frontend + a human → fr (a trailing slash on iss is tolerated)', () => {
    expect(superAdminSessionTrustFromClaims(human())).toBe('fr');
    expect(superAdminSessionTrustFromClaims(human({ iss: `${FR}/` }))).toBe('fr');
  });

  test.each([
    ['portal issuer', { iss: PORTAL }, 'untrusted_session'],
    ['wrong azp', { azp: 'portal-bff' }, 'untrusted_session'],
    ['no azp', { azp: undefined }, 'untrusted_session'],
    ['service-account username', { preferred_username: 'service-account-conveyor' }, 'service_account'],
    ['client_id claim', { client_id: 'conveyor' }, 'service_account'],
    ['clientHost mapper', { clientHost: '10.0.0.1' }, 'service_account'],
    ['clientAddress mapper', { clientAddress: '10.0.0.1' }, 'service_account'],
    ['missing sub', { sub: undefined }, 'service_account'],
    ['missing preferred_username', { preferred_username: undefined }, 'service_account'],
  ])('%s → %s', (_l, over, want) => {
    expect(superAdminSessionTrustFromClaims(human(over as Record<string, unknown>))).toBe(want as never);
  });

  test('no claims (agent / licence / unauthenticated) → untrusted', () => {
    expect(superAdminSessionTrustFromClaims(undefined)).toBe('untrusted_session');
  });
});

describe('fail CLOSED without explicit config — and no portal default is possible', () => {
  test('FR_SUPER_ADMIN_SWITCH_* unset → the arm is OFF for every token, with a boot warning', () => {
    delete process.env.FR_SUPER_ADMIN_SWITCH_ISSUER;
    delete process.env.FR_SUPER_ADMIN_SWITCH_AZP;
    expect(superAdminSessionTrustFromClaims(human())).toBe('untrusted_session');
    const w = superAdminSwitchConfigWarning();
    expect(w).toContain('FR_SUPER_ADMIN_SWITCH_ISSUER and FR_SUPER_ADMIN_SWITCH_AZP unset');
    expect(w).toContain('OFF');
  });

  test('only one of the two set → still OFF, and the warning names the missing one', () => {
    delete process.env.FR_SUPER_ADMIN_SWITCH_AZP;
    expect(superAdminSessionTrustFromClaims(human())).toBe('untrusted_session');
    expect(superAdminSwitchConfigWarning()).toContain('FR_SUPER_ADMIN_SWITCH_AZP unset');
  });

  test('the Keycloak realm env (portal everywhere) can never become the trusted issuer', () => {
    delete process.env.FR_SUPER_ADMIN_SWITCH_ISSUER;
    process.env.KEYCLOAK_URL = 'https://auth.nonagentic.ai';
    process.env.KEYCLOAK_REALM = 'portal';
    process.env.KEYCLOAK_USER_REALM = 'portal';
    process.env.KEYCLOAK_ISSUER = PORTAL;
    expect(superAdminSessionTrustFromClaims(human({ iss: PORTAL }))).toBe('untrusted_session');
    expect(superAdminSessionTrustFromClaims(human())).toBe('untrusted_session');
  });

  test('both set → no warning', () => {
    expect(superAdminSwitchConfigWarning()).toBeNull();
  });
});
