// Unit tests for the super-admin gate (backed by the `super_admin` Keycloak
// realm role). Pure logic — no DB, no Keycloak, no env.

import { describe, expect, test } from 'bun:test';
import {
  SUPER_ADMIN_REALM_ROLE,
  hasSuperAdminRole,
  isSuperAdmin,
} from '../../../src/lib/super-admin-gate';

describe('hasSuperAdminRole', () => {
  test('true only when super_admin is present', () => {
    expect(hasSuperAdminRole([SUPER_ADMIN_REALM_ROLE])).toBe(true);
    expect(hasSuperAdminRole(['workspace-admin', 'super_admin'])).toBe(true);
    expect(hasSuperAdminRole(['workspace-admin'])).toBe(false);
    expect(hasSuperAdminRole([])).toBe(false);
    expect(hasSuperAdminRole(undefined)).toBe(false);
  });
});

describe('isSuperAdmin', () => {
  test('true iff the subject carries the super_admin realm role', () => {
    expect(isSuperAdmin({ roles: ['super_admin'] })).toBe(true);
    expect(isSuperAdmin({ roles: ['workspace-admin', 'super_admin'] })).toBe(true);
    expect(isSuperAdmin({ roles: ['workspace-admin'] })).toBe(false);
    expect(isSuperAdmin({ roles: [] })).toBe(false);
  });

  test('false for an undefined / role-less subject', () => {
    expect(isSuperAdmin(undefined)).toBe(false);
    expect(isSuperAdmin({})).toBe(false);
  });
});
