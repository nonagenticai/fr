// tests/unit/services/user-roles.test.ts
//
// Pure coverage of the realm-claim arm of tenant-admin resolution. The DB arm
// (hasRole / grantRole / isWorkspaceAdminOf) is not unit-tested here: those
// cases ran against a hand-built fake drizzle db or an injected lookup and were
// removed under the no-test-doubles ruling.

import { describe, test, expect } from 'bun:test';
import {
  isRealmTenantAdminOf,
  REALM_TENANT_ADMIN_ROLE,
  REALM_TENANT_ADMIN_ROLES,
} from '../../../src/services/user-roles';

const TENANT = '00000000-1111-7000-8000-000000000001';
const OTHER = '00000000-1111-7000-8000-000000000002';

/**
 * The Keycloak realm role `tenant_admin`, pinned to the RAW `tenant_id` claim.
 * The arm must pin to the raw claim, NOT `user.tenantId`: `deriveTenantId`
 * falls back to `sub` when `tenant_id` is absent, so reading `tenantId` would
 * make a claim-less tenant_admin the admin of a tenant whose id equals their
 * own subject.
 */
describe('isRealmTenantAdminOf / tenant_admin realm arm', () => {
  test('tenant_admin + matching raw tenant_id claim -> admin', () => {
    expect(isRealmTenantAdminOf({ roles: ['tenant_admin'], tenantClaim: TENANT }, TENANT)).toBe(true);
  });

  test('tenant_admin + a DIFFERENT tenant_id claim -> not admin', () => {
    expect(isRealmTenantAdminOf({ roles: ['tenant_admin'], tenantClaim: OTHER }, TENANT)).toBe(false);
  });

  test('matching tenant_id WITHOUT the tenant_admin role -> not admin', () => {
    expect(isRealmTenantAdminOf({ roles: ['user'], tenantClaim: TENANT }, TENANT)).toBe(false);
  });

  test('an empty tenant_id claim or empty target tenant never matches', () => {
    expect(isRealmTenantAdminOf({ roles: ['tenant_admin'], tenantClaim: '' }, '')).toBe(false);
    expect(isRealmTenantAdminOf({ roles: ['tenant_admin'], tenantClaim: TENANT }, '')).toBe(false);
  });
});

/**
 * George 2026-09-29 (fr#1289): "a fr admin is a tenant_admin". The legacy realm
 * role `admin` is a PINNED alias of `tenant_admin`.
 */
describe('legacy realm admin is a pinned tenant_admin alias', () => {
  test('REALM_TENANT_ADMIN_ROLES is exactly tenant_admin + admin, never workspace-admin', () => {
    expect([...REALM_TENANT_ADMIN_ROLES]).toEqual(['tenant_admin', 'admin']);
    expect(REALM_TENANT_ADMIN_ROLE).toBe('tenant_admin');
  });

  test('admin + matching tenant claim -> admin; a different claim -> not', () => {
    expect(isRealmTenantAdminOf({ roles: ['admin'], tenantClaim: TENANT }, TENANT)).toBe(true);
    expect(isRealmTenantAdminOf({ roles: ['admin'], tenantClaim: OTHER }, TENANT)).toBe(false);
  });

  test('a workspace-admin CLAIM is not a realm admin', () => {
    expect(isRealmTenantAdminOf({ roles: ['workspace-admin'], tenantClaim: TENANT }, TENANT)).toBe(false);
  });
});
