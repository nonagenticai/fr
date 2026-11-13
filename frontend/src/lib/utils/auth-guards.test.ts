import { describe, it, expect } from 'vitest';
import { hasSuperAdmin, SUPER_ADMIN_ROLE } from './auth-guards';

describe('auth-guards', () => {
  it('hasSuperAdmin only on the super_admin realm role', () => {
    expect(hasSuperAdmin({ roles: [SUPER_ADMIN_ROLE] })).toBe(true);
    expect(hasSuperAdmin({ roles: ['workspace-admin', 'super_admin'] })).toBe(true);
    expect(hasSuperAdmin({ roles: ['workspace-admin'] })).toBe(false);
    expect(hasSuperAdmin({ roles: [] })).toBe(false);
    expect(hasSuperAdmin(null)).toBe(false);
    expect(hasSuperAdmin(undefined)).toBe(false);
    expect(hasSuperAdmin({})).toBe(false);
  });
});
