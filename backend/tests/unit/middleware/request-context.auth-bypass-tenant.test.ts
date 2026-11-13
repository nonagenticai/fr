// AUTH_BYPASS puts AUTH_BYPASS_TENANT_ID on the request FRAME, not only on
// `bypassUser()`. Without it every `requireTenant` client (workers.ts,
// artifacts.ts) answered 409 MISSING_TENANT in the dev stack and the
// Playwright lanes. Fail closed when the tenant env is unset/blank, and never
// active unless AUTH_BYPASS === 'true' (the `validateAuth` predicate).
import { afterEach, describe, expect, test } from 'bun:test';
import { buildRequestContext } from '../../../src/middleware/request-context';

const BYPASS_TENANT = '0195f48b-d000-7000-8000-0000000000b1';

const saved = {
  bypass: process.env.AUTH_BYPASS,
  tenant: process.env.AUTH_BYPASS_TENANT_ID,
};
afterEach(() => {
  for (const [k, v] of [
    ['AUTH_BYPASS', saved.bypass],
    ['AUTH_BYPASS_TENANT_ID', saved.tenant],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('buildRequestContext under AUTH_BYPASS', () => {
  test('bypass on + AUTH_BYPASS_TENANT_ID set ⇒ the frame carries that tenant', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.AUTH_BYPASS_TENANT_ID = ` ${BYPASS_TENANT} `;
    const ctx = await buildRequestContext(new Request('http://x'));
    expect(ctx.tenantId).toBe(BYPASS_TENANT);
  });

  test('bypass on + tenant UNSET ⇒ tenantless (no invented default uuid)', async () => {
    process.env.AUTH_BYPASS = 'true';
    delete process.env.AUTH_BYPASS_TENANT_ID;
    expect((await buildRequestContext(new Request('http://x'))).tenantId).toBeUndefined();
  });

  test('bypass on + tenant BLANK ⇒ tenantless', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.AUTH_BYPASS_TENANT_ID = '   ';
    expect((await buildRequestContext(new Request('http://x'))).tenantId).toBeUndefined();
  });

  test('bypass OFF ⇒ the env tenant is ignored, frame stays tenantless', async () => {
    process.env.AUTH_BYPASS = 'false';
    process.env.AUTH_BYPASS_TENANT_ID = BYPASS_TENANT;
    expect((await buildRequestContext(new Request('http://x'))).tenantId).toBeUndefined();
  });

  test('bypass truthy-but-not-"true" (e.g. "1") does not activate', async () => {
    process.env.AUTH_BYPASS = '1';
    process.env.AUTH_BYPASS_TENANT_ID = BYPASS_TENANT;
    expect((await buildRequestContext(new Request('http://x'))).tenantId).toBeUndefined();
  });
});
