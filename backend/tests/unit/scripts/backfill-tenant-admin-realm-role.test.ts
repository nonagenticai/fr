// tests/unit/scripts/backfill-tenant-admin-realm-role.test.ts
//
// fr#1289 backfill: classification of existing workspace-admin rows, and the
// --apply fences (refused while the write-through is off; only WOULD_ADD rows
// are written; a 'failed' sync exits non-zero). All side effects are injected,
// so no database or Keycloak is touched.

import { describe, expect, test } from 'bun:test';

import {
  applyRefusal,
  classifyGrant,
  isNotFoundError,
  type UserTenantAndRoles,
} from '../../../scripts/backfill-tenant-admin-realm-role';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const row = { user_id: 'u1', tenant_id: T1 };

function info(over: Partial<UserTenantAndRoles> = {}): UserTenantAndRoles {
  return { tenantId: T1, directRoles: [], effectiveRoles: [], enabled: true, ...over };
}

describe('classifyGrant — one case per class', () => {
  test('orphan: Keycloak has no such user', () => {
    expect(classifyGrant(row, { kind: 'not_found' })).toBe('orphan');
  });
  test('lookup_failed: a non-404 error is NOT silently an orphan', () => {
    expect(classifyGrant(row, { kind: 'error', message: 'ECONNRESET' })).toBe('lookup_failed');
  });
  test('skipped_super_admin (even with a matching tenant)', () => {
    expect(classifyGrant(row, { kind: 'found', info: info({ effectiveRoles: ['super_admin'] }) })).toBe(
      'skipped_super_admin',
    );
  });
  test('skipped_no_tenant', () => {
    expect(classifyGrant(row, { kind: 'found', info: info({ tenantId: null }) })).toBe('skipped_no_tenant');
  });
  test('skipped_tenant_mismatch — even when they hold tenant_admin elsewhere', () => {
    expect(
      classifyGrant(row, { kind: 'found', info: info({ tenantId: T2, effectiveRoles: ['tenant_admin'] }) }),
    ).toBe('skipped_tenant_mismatch');
  });
  test('already_holder: a DIRECT tenant_admin mapping', () => {
    expect(
      classifyGrant(row, {
        kind: 'found',
        info: info({ directRoles: ['tenant_admin'], effectiveRoles: ['tenant_admin'] }),
      }),
    ).toBe('already_holder');
  });
  test('composite-only tenant_admin is WOULD_ADD (sync adds a direct mapping)', () => {
    expect(classifyGrant(row, { kind: 'found', info: info({ effectiveRoles: ['tenant_admin'] }) })).toBe(
      'WOULD_ADD',
    );
  });
  test('WOULD_ADD: matching tenant, no tenant_admin, not super-admin', () => {
    expect(classifyGrant(row, { kind: 'found', info: info({ effectiveRoles: ['default-roles'] }) })).toBe(
      'WOULD_ADD',
    );
  });
  test('legacy realm `admin` alone is not the tenant_admin role → WOULD_ADD', () => {
    expect(classifyGrant(row, { kind: 'found', info: info({ effectiveRoles: ['admin'] }) })).toBe('WOULD_ADD');
  });
});

describe('isNotFoundError', () => {
  test('recognises 404 shapes', () => {
    expect(isNotFoundError({ status: 404 })).toBe(true);
    // The shape keycloak.getUserTenantAndRoles actually throws.
    expect(isNotFoundError(Object.assign(new Error('keycloak getUserTenantAndRoles failed with 404'), { upstreamStatus: 404 }))).toBe(true);
  });
  test('control: other errors are not 404s', () => {
    expect(isNotFoundError(Object.assign(new Error('failed with 503'), { upstreamStatus: 503 }))).toBe(false);
    // Message text alone never counts — an unrelated "not found" must not read as orphan.
    expect(isNotFoundError(new Error('role tenant_admin not found'))).toBe(false);
    expect(isNotFoundError({ status: 500 })).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});

describe('applyRefusal', () => {
  test('dry-run is never refused', () => {
    expect(applyRefusal(false, false)).toBeNull();
  });
  test('--apply with write-through OFF is refused', () => {
    expect(applyRefusal(true, false)).toContain('FR_TENANT_ADMIN_WRITE_THROUGH');
  });
  test('--apply with write-through ON proceeds', () => {
    expect(applyRefusal(true, true)).toBeNull();
  });
});

