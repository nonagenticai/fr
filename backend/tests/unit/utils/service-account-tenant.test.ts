// A Keycloak service account's `sub` is a caller identity, never a tenant
// (TENANCY_AND_IMPROVEMENT.md §2.4: the fr-backend SA sub 6d5a9a20-… minted
// three asset streams as a tenant). `deriveTenantId` falls back to `sub`, so
// the request context flags that case and the improvement-card asset branch
// refuses it before getOrCreateAssetStream can provision a stream.

import { describe, expect, test } from 'bun:test';

import {
  isServiceAccountClaims,
  isServiceAccountSubjectTenant,
} from '../../../src/utils/tenant';

const SA_SUB = '6d5a9a20-30d5-48c8-9602-a641bbe9afe1';
const USER_SUB = '7c9b6c8f-1111-2222-3333-444444444444';
const TENANT = '0195f48b-d000-7000-8000-000000000003';

describe('isServiceAccountClaims', () => {
  test('preferred_username service-account-* → true', () => {
    expect(
      isServiceAccountClaims({ sub: SA_SUB, preferred_username: 'service-account-fr-backend' }),
    ).toBe(true);
  });
  test('client credentials client_id / clientId claim → true', () => {
    expect(isServiceAccountClaims({ sub: SA_SUB, client_id: 'fr-backend' })).toBe(true);
    expect(isServiceAccountClaims({ sub: SA_SUB, clientId: 'fr-backend' })).toBe(true);
  });
  test('a human user token (azp present, ordinary username) → false', () => {
    expect(
      isServiceAccountClaims({ sub: USER_SUB, azp: 'fr-frontend', preferred_username: 'george' }),
    ).toBe(false);
  });
});

describe('isServiceAccountSubjectTenant', () => {
  test('SA token with no tenant_id → its sub would be the tenant → true', () => {
    expect(
      isServiceAccountSubjectTenant({ sub: SA_SUB, preferred_username: 'service-account-fr-backend' }),
    ).toBe(true);
  });
  test('SA token WITH a tenant_id claim → false (sub fallback never fires)', () => {
    expect(
      isServiceAccountSubjectTenant({
        sub: SA_SUB,
        tenant_id: TENANT,
        preferred_username: 'service-account-fr-backend',
      }),
    ).toBe(false);
  });
  test('human user with no tenant_id → false', () => {
    expect(isServiceAccountSubjectTenant({ sub: USER_SUB, preferred_username: 'george' })).toBe(
      false,
    );
  });
});

