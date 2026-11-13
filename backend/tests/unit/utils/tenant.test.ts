import { describe, test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  deriveTenantId,
  deriveTenantName,
  isValidUuid,
  normalizeTenantId,
} from '../../../src/utils/tenant';

describe('deriveTenantId', () => {
  test('prefers tenant_id claim when present', () => {
    expect(
      deriveTenantId({ tenant_id: 'tenant-abc', sub: 'user-123' }),
    ).toBe('tenant-abc');
  });

  test('falls back to sub when tenant_id is absent', () => {
    expect(deriveTenantId({ sub: 'user-123' })).toBe('user-123');
  });

  // Was `toBe('anonymous')`. deriveTenantId no longer invents a tenant: the
  // literal was neither a UUID nor a registered tenant name, and
  // worker_management (tenant_id is a Postgres `uuid` column since
  // 2026-08-25) answers 400 INVALID_TENANT to it. null == "omit the header",
  // which is already what a request with no verified claims does.
  test('returns null when both tenant_id and sub are missing', () => {
    expect(deriveTenantId({})).toBeNull();
  });
});

describe('deriveTenantName', () => {
  test('returns the claim string when present', () => {
    expect(deriveTenantName({ tenant_name: 'gerard-dev' })).toBe('gerard-dev');
  });

  test('returns null when claim is missing', () => {
    expect(deriveTenantName({})).toBeNull();
  });

  test('returns null when claim is empty', () => {
    expect(deriveTenantName({ tenant_name: '' })).toBeNull();
  });

  test('returns null when claim is non-string', () => {
    expect(deriveTenantName({ tenant_name: 42 })).toBeNull();
    expect(deriveTenantName({ tenant_name: null })).toBeNull();
    expect(deriveTenantName({ tenant_name: undefined })).toBeNull();
  });
});

describe('isValidUuid', () => {
  test('accepts node:crypto.randomUUID output (v4)', () => {
    for (let i = 0; i < 5; i++) {
      expect(isValidUuid(randomUUID())).toBe(true);
    }
  });

  test('accepts UUIDv1 through v8', () => {
    // Each version literal: vN goes in the third group's leading nibble.
    expect(isValidUuid('11111111-1111-1111-8111-111111111111')).toBe(true); // v1
    expect(isValidUuid('11111111-1111-2111-8111-111111111111')).toBe(true); // v2
    expect(isValidUuid('11111111-1111-3111-8111-111111111111')).toBe(true); // v3
    expect(isValidUuid('11111111-1111-4111-8111-111111111111')).toBe(true); // v4
    expect(isValidUuid('11111111-1111-5111-8111-111111111111')).toBe(true); // v5
    expect(isValidUuid('11111111-1111-6111-8111-111111111111')).toBe(true); // v6
    expect(isValidUuid('11111111-1111-7111-8111-111111111111')).toBe(true); // v7
    expect(isValidUuid('11111111-1111-8111-8111-111111111111')).toBe(true); // v8
  });

  test('accepts the all-zero (system/bootstrap) UUID', () => {
    expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  test('accepts bootstrap-class UUIDs with non-zero suffix', () => {
    // Pre-existing prod tenants use `00000000-0000-0000-0000-XXX…` for
    // reserved-namespace system rows (e.g. `…001`, `…002`). They predate
    // RFC 9562 strictness in this codebase; accepting them here keeps the
    // DB-backed admin gate reachable in those tenants.
    expect(isValidUuid('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(isValidUuid('00000000-0000-0000-0000-000000000002')).toBe(true);
    expect(isValidUuid('00000000-0000-0000-0000-00000000abcd')).toBe(true);
    expect(isValidUuid('00000000-0000-0000-0000-ffffffffffff')).toBe(true);
  });

  test('still rejects almost-all-zero UUIDs that violate the prefix', () => {
    // Anything other than `00000000-0000-0000-0000-…` for the bootstrap
    // path must fall through to the strict v1–v8 check and fail.
    expect(isValidUuid('00000001-0000-0000-0000-000000000001')).toBe(false);
    expect(isValidUuid('00000000-0001-0000-0000-000000000001')).toBe(false);
    expect(isValidUuid('00000000-0000-0001-0000-000000000001')).toBe(false);
    expect(isValidUuid('00000000-0000-0000-0001-000000000001')).toBe(false);
  });

  test('rejects legacy non-UUID tenant claims', () => {
    expect(isValidUuid('gerard-dev')).toBe(false);
    expect(isValidUuid('tenant-abc')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('anonymous')).toBe(false);
  });

  test('rejects malformed UUID-shaped strings', () => {
    // Wrong version nibble (0 in v-position is reserved → not a real UUID).
    expect(isValidUuid('11111111-1111-0111-8111-111111111111')).toBe(false);
    // v9 doesn't exist.
    expect(isValidUuid('11111111-1111-9111-8111-111111111111')).toBe(false);
    // Wrong variant nibble (must be 8/9/a/b).
    expect(isValidUuid('11111111-1111-4111-7111-111111111111')).toBe(false);
    // Missing dashes.
    expect(isValidUuid('11111111111111111111111111111111')).toBe(false);
    // Too short.
    expect(isValidUuid('11111111-1111-4111-8111-1111111111')).toBe(false);
  });

  test('is case-insensitive', () => {
    const id = randomUUID();
    expect(isValidUuid(id)).toBe(true);
    expect(isValidUuid(id.toUpperCase())).toBe(true);
  });
});

describe('normalizeTenantId', () => {
  test('returns the value when valid UUID', () => {
    const id = randomUUID();
    expect(normalizeTenantId(id)).toEqual({ tenantId: id });
  });

  test('returns null for legacy non-UUID claim', () => {
    expect(normalizeTenantId('gerard-dev')).toEqual({ tenantId: null });
  });

  test('returns null for "anonymous" fallthrough', () => {
    expect(normalizeTenantId('anonymous')).toEqual({ tenantId: null });
  });

  test('returns null for empty string', () => {
    expect(normalizeTenantId('')).toEqual({ tenantId: null });
  });

  test('passes through the all-zero bootstrap UUID', () => {
    const zero = '00000000-0000-0000-0000-000000000000';
    expect(normalizeTenantId(zero)).toEqual({ tenantId: zero });
  });
});
