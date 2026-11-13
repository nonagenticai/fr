// tests/unit/routes/tools/analytics-ctx.test.ts
//
// Regression guard (no DB) for `actionUserFromCtx` in
// `src/routes/tools/analytics.ts`.
//
// The field this file protects is load-bearing, not cosmetic:
// `summaryFromDb` / `exportFromDb` / `breakdownFromDb` all filter
// `eq(analyticsRollups.tenant_id, ctxTenantId(user.tenantId))`. The function
// used to return `tenantId: ctx.userId` — a USER uuid in a TENANT column — and
// no rollup row's tenant_id can ever equal a user uuid, so every analytics
// call returned zero rows. Nothing threw: the caller saw `{kpis: []}` /
// `{rows: [], row_count: 0}`, indistinguishable from "no data collected yet".
// A revert would therefore be invisible to every other test in the suite.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { actionUserFromCtx } from '../../../../src/routes/tools/analytics';
import type { ActionContext } from '../../../../src/agui/types';

// Deliberately unrelated uuids: if the implementation regressed to
// `tenantId: ctx.userId` the equality assertions below cannot pass by
// coincidence the way two similar-looking ids might.
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const BYPASS_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const ORIGINAL_AUTH_BYPASS = process.env.AUTH_BYPASS;

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    userId: USER_ID,
    projectId: null,
    correlationId: 'analytics-ctx-test',
    initiator: 'agent',
    channel: 'web',
    ...overrides,
  };
}

beforeEach(() => {
  // `tests/unit/analytics-actions.test.ts` sets AUTH_BYPASS='true' at module
  // scope and bun shares one process across test files, so without this the
  // real-tenant assertions could read the bypass constant instead of
  // ctx.tenantId and pass while the fix was reverted.
  delete process.env.AUTH_BYPASS;
});

afterAll(() => {
  if (ORIGINAL_AUTH_BYPASS === undefined) delete process.env.AUTH_BYPASS;
  else process.env.AUTH_BYPASS = ORIGINAL_AUTH_BYPASS;
});

describe('actionUserFromCtx tenant threading', () => {
  test('carries ctx.tenantId — and specifically NOT ctx.userId', () => {
    const user = actionUserFromCtx(ctx({ tenantId: TENANT_ID }));
    expect(user.id).toBe(USER_ID);
    expect(user.tenantId).toBe(TENANT_ID);
    // The exact regression: a user uuid in the tenant filter matches no
    // analytics_rollups row, so every KPI/export silently returns empty.
    expect(user.tenantId).not.toBe(USER_ID);
  });

  test('a context with no tenant yields empty string, never a fallback', () => {
    // Empty is deliberate. `ctxTenantId('')` throws "tenantId not resolvable"
    // rather than accepting a fallback, so an unaffiliated caller is REFUSED
    // instead of being scoped to some other tenant's rollups. Returning
    // `ctx.userId` (or any placeholder) here would turn a refusal into a
    // silent mis-scope. Matches the posture of routes/tools/kag.ts buildCtx.
    expect(actionUserFromCtx(ctx()).tenantId).toBe('');
    expect(actionUserFromCtx(ctx({ tenantId: undefined })).tenantId).toBe('');
  });

  test('AUTH_BYPASS=true still returns the all-zeros bypass tenant', () => {
    // Local/dev bypass path: analytics must stay usable without Keycloak, so
    // the zeros tenant must survive any future rework of this function.
    process.env.AUTH_BYPASS = 'true';
    expect(actionUserFromCtx(ctx()).tenantId).toBe(BYPASS_TENANT_ID);
    // Bypass wins even when the context carries a real tenant — that is the
    // documented behaviour of the branch, asserted so a reorder is caught.
    expect(actionUserFromCtx(ctx({ tenantId: TENANT_ID })).tenantId).toBe(BYPASS_TENANT_ID);
  });
});
