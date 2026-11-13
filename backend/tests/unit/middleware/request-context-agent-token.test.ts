// tests/unit/middleware/request-context-agent-token.test.ts
//
// fr has TWO token shapes on `Authorization: Bearer`, and the request-scoped
// identity frame understood only one of them.
//
// `verifyBearerClaims` is Keycloak-only (RS256 via JWKS) and returns `undefined`
// for the HS256 `aud=fr-agent` token fr mints for AG-UI callers. Its docblock
// justifies that silence with "the route's own auth gate still rejects the
// request" — and for this token class that premise is FALSE: the route's gate
// verifies the same token and succeeds. So the request WAS authenticated, the
// route read a tenant off the token one function later, and the identity frame
// stayed empty.
//
// It cannot be rescued downstream: `withRequestContext` is `als.run()`, a true
// nest, so a frame the ROUTE opens is provably invisible to `withUsageSpans`,
// which reads `tryGetRequestContext()` AFTER the handler returns.
//
// MEASURED 2026-09-03 in `billing_metering_events` over 9 days — the token shape
// predicts the outcome with zero exceptions across 827 rows:
//
//   invoke 477 / threads 175 / session-refresh 108   ALL nil-tenant   (agent token)
//   session-issue 66 / actions 1                     ALL attributed   (Keycloak JWT)
//
// 760 events, 84.4/day, metered to the nil tenant and therefore un-billable —
// with the identity available, resolved, and discarded.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';

import { buildRequestContext } from '../../../src/middleware/request-context';
import { AGENT_TOKEN_AUDIENCE, agentTokenSecret } from '../../../src/lib/agent-token';
import { EXECUTION_TENANT_ID } from '../../../src/middleware/internal-tenant-only';

const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';

async function agentToken(
  opts: { sub?: string; tenantId?: string | null; audience?: string; roles?: string[] } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {};
  if (opts.tenantId !== null) body.tenant_id = opts.tenantId ?? TENANT;
  if (opts.roles) body.tenant_roles = opts.roles;
  return await new SignJWT(body)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(opts.sub ?? USER)
    .setAudience(opts.audience ?? AGENT_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(agentTokenSecret());
}

const reqWith = (token: string, headers: Record<string, string> = {}) =>
  new Request('http://fr.test/api/agui/invoke', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });

// Restore (never delete) the preload's value: tests/setup.ts sets
// FR_AGENT_JWT_SECRET for the whole process, and deleting it here made every
// LATER file that runs validateProductionConfig on a full prod config throw
// (scheduled-reports-internal "… no throw" went red whenever this file ran first,
// as it does in devbox's local file order; CI's file order evidently differs).
const PRELOAD_FR_AGENT_JWT_SECRET = process.env.FR_AGENT_JWT_SECRET;
beforeEach(() => {
  process.env.FR_AGENT_JWT_SECRET = 'unit-test-agent-secret';
});
afterEach(() => {
  if (PRELOAD_FR_AGENT_JWT_SECRET === undefined) delete process.env.FR_AGENT_JWT_SECRET;
  else process.env.FR_AGENT_JWT_SECRET = PRELOAD_FR_AGENT_JWT_SECRET;
});

describe('an agent token populates the identity frame', () => {
  test('its tenant reaches the frame — the 84/day defect', async () => {
    // Before the fix this was `undefined`, and `withUsageSpans` metered the
    // request to the nil tenant.
    const ctx = await buildRequestContext(reqWith(await agentToken()));
    expect(ctx.tenantId).toBe(TENANT);
  });

  test('its subject reaches the frame too', async () => {
    const ctx = await buildRequestContext(reqWith(await agentToken()));
    expect(ctx.userId).toBe(USER);
    expect(ctx.subjectId).toBe(USER);
  });

  test('a pre-097 token with no tenant claim yields no tenant, not a fabricated one', async () => {
    // Absent must stay absent. Inventing a tenant here would bill somebody
    // else's workspace — strictly worse than the nil tenant it replaces.
    const ctx = await buildRequestContext(reqWith(await agentToken({ tenantId: null })));
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.userId).toBe(USER);
  });
});

describe('verification is REAL — the frame is not populated from an unverified token', () => {
  test('a token signed with the wrong secret is ignored', async () => {
    const forged = await new SignJWT({ tenant_id: OTHER_TENANT })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER)
      .setAudience(AGENT_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode('not-the-real-secret'));
    const ctx = await buildRequestContext(reqWith(forged));
    expect(ctx.tenantId).toBeUndefined();
  });

  test('a correctly-signed token for the WRONG audience is ignored', async () => {
    const ctx = await buildRequestContext(
      reqWith(await agentToken({ audience: 'some-other-app' })),
    );
    expect(ctx.tenantId).toBeUndefined();
  });

  test('garbage in the Authorization header is ignored', async () => {
    const ctx = await buildRequestContext(reqWith('not.a.jwt'));
    expect(ctx.tenantId).toBeUndefined();
  });
});

describe('⛔ an agent token must NOT unlock the Keycloak-gated tenant overrides', () => {
  // This is the boundary the fix had to preserve. Everything downstream that
  // reads `claims` gates a header-driven tenant OVERRIDE on a SIGNED Keycloak
  // role. If the agent identity were merged into `claims`, an agent could
  // nominate ANY tenant by adding a header — turning a metering fix into a
  // cross-tenant escalation.

  test('X-Active-Tenant is refused even when the token claims super_admin', async () => {
    // ⚠️ The header MUST name an ALLOWLISTED tenant, or this test passes for the
    // wrong reason. The override also requires the target to be an internal
    // tenant / the execution tenant / the caller's own — so an arbitrary uuid is
    // refused by the ALLOWLIST and the role gate is never reached. The first
    // version of this test used an arbitrary uuid, survived the escalation
    // mutant, and was therefore a vacuous security assertion.
    const ctx = await buildRequestContext(
      reqWith(await agentToken({ roles: ['super_admin'] }), {
        'X-Active-Tenant': EXECUTION_TENANT_ID,
      }),
    );
    // The token's OWN tenant, never the header's.
    expect(ctx.tenantId).toBe(TENANT);
    expect(ctx.tenantId).not.toBe(EXECUTION_TENANT_ID);
  });

  test('X-Tenant-Id is refused even when the token claims aa-orchestrator', async () => {
    const ctx = await buildRequestContext(
      reqWith(await agentToken({ roles: ['aa-orchestrator'] }), {
        'X-Tenant-Id': OTHER_TENANT,
      }),
    );
    expect(ctx.tenantId).toBe(TENANT);
    expect(ctx.tenantId).not.toBe(OTHER_TENANT);
  });
});
