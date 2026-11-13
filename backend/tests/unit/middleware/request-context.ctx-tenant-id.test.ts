// tests/unit/middleware/request-context.ctx-tenant-id.test.ts
//
// W2 sweep — covers the new `ctxTenantId()` / `tryCtxTenantId()` helpers
// exported from `src/middleware/request-context`. The helpers are how
// route handlers should read the effective tenant id (post X-Active-Tenant
// override) instead of `user.tenantId` from the JWT claim.

import { test, expect, describe } from 'bun:test';
import {
  ctxTenantId,
  tryCtxTenantId,
  withRequestContext,
} from '../../../src/middleware/request-context';

describe('ctxTenantId / tryCtxTenantId', () => {
  test('ctxTenantId() returns frame tenantId when set', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-1',
        initiator: 'human',
        channel: 'web',
        tenantId: '11111111-1111-4111-8111-111111111111',
        activeTenantSource: 'jwt',
      },
      async () => {
        expect(ctxTenantId()).toBe('11111111-1111-4111-8111-111111111111');
      },
    );
  });

  test('ctxTenantId() reflects header override (super-admin path)', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-2',
        initiator: 'human',
        channel: 'web',
        // tenantId here is the RESOLVED tenant (header winner) —
        // buildRequestContext is what picks header vs JWT.
        tenantId: '22222222-2222-4222-8222-222222222222',
        activeTenantSource: 'header',
      },
      async () => {
        expect(ctxTenantId()).toBe('22222222-2222-4222-8222-222222222222');
      },
    );
  });

  test('ctxTenantId() throws outside an active request frame with no fallback', () => {
    expect(() => ctxTenantId()).toThrow(/tenantId not resolvable/);
  });

  test('ctxTenantId(fallback) returns fallback when no active frame', () => {
    expect(ctxTenantId('44444444-4444-4444-8444-444444444444')).toBe(
      '44444444-4444-4444-8444-444444444444',
    );
  });

  test('ctxTenantId() throws when frame has no tenantId AND no fallback', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-3',
        initiator: 'cron',
        channel: 'cron',
        // tenantId omitted on purpose — cron / startup paths.
      },
      async () => {
        expect(() => ctxTenantId()).toThrow(/tenantId not resolvable/);
      },
    );
  });

  test('ctxTenantId(fallback) returns frame tenantId, ignoring fallback when present', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-3b',
        initiator: 'human',
        channel: 'web',
        tenantId: '55555555-5555-4555-8555-555555555555',
        activeTenantSource: 'jwt',
      },
      async () => {
        expect(ctxTenantId('this-fallback-should-be-ignored')).toBe(
          '55555555-5555-4555-8555-555555555555',
        );
      },
    );
  });

  test('tryCtxTenantId() returns undefined outside an active frame', () => {
    expect(tryCtxTenantId()).toBeUndefined();
  });

  test('tryCtxTenantId() returns undefined when frame has no tenantId', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-4',
        initiator: 'cron',
        channel: 'cron',
      },
      async () => {
        expect(tryCtxTenantId()).toBeUndefined();
      },
    );
  });

  test('tryCtxTenantId() returns the frame tenantId when set', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-5',
        initiator: 'human',
        channel: 'web',
        tenantId: '33333333-3333-4333-8333-333333333333',
        activeTenantSource: 'jwt',
      },
      async () => {
        expect(tryCtxTenantId()).toBe('33333333-3333-4333-8333-333333333333');
      },
    );
  });
});
