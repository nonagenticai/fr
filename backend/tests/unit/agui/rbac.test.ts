// Unit tests for E-12 per-action RBAC: assertRbac rule resolution for the
// rules that need no project-membership provider (public, tenant-role,
// custom) and default-rule synthesis for tenant-scoped contexts.
//
// Membership-provider cases are not unit-tested here: they need a provider,
// and the only real one (tenantMemberProjectMembershipProvider) is exercised
// against postgres by tenant-member-provider-parity.test.ts.

import { test, expect, describe } from 'bun:test';
import { z } from 'zod';

import { assertRbac, RbacDeniedError, type RbacRule } from '../../../src/agui/rbac';
import type { AgentCallableAction, ActionContext } from '../../../src/agui/types';

// ---------- Helpers ----------

function makeAction(
  overrides: Partial<AgentCallableAction<{ x: number }, { y: number }>> = {},
): AgentCallableAction<{ x: number }, { y: number }> {
  return {
    name: 'demo.read_thing',
    kind: 'read',
    description: 'rbac test action',
    input: z.object({ x: z.number() }),
    output: z.object({ y: z.number() }),
    approval: { type: 'auto' },
    idempotencyKey: (input) => `rbacdemo:${input.x}`,
    cronSafe: true,
    handler: async (input) => ({ y: input.x * 2 }),
    ...overrides,
  };
}

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    userId: 'u1',
    projectId: null,
    correlationId: 'cid-rbac',
    initiator: 'human',
    channel: 'web',
    ...overrides,
  };
}

// ---------- assertRbac per-rule ----------

describe('assertRbac — public', () => {
  test('allows any context, regardless of projectId / tenantRoles', async () => {
    const a = makeAction({ rbac: { type: 'public' } });
    await expect(assertRbac(a, ctx(), { x: 1 })).resolves.toBeUndefined();
    await expect(
      assertRbac(a, ctx({ projectId: 'p1', userId: 'nobody' }), { x: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('assertRbac — tenant-role', () => {
  test('allows when role is in caller claims', async () => {
    const a = makeAction({ rbac: { type: 'tenant-role', role: 'admin' } });
    await expect(
      assertRbac(a, ctx({ tenantRoles: ['user', 'admin'] }), { x: 1 }),
    ).resolves.toBeUndefined();
  });

  test('denies with rbac_missing_tenant_role when role absent', async () => {
    const a = makeAction({ rbac: { type: 'tenant-role', role: 'admin' } });
    try {
      await assertRbac(a, ctx({ tenantRoles: ['user'] }), { x: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacDeniedError);
      const e = err as RbacDeniedError;
      expect(e.code).toBe('rbac_missing_tenant_role');
      expect(e.reason).toContain('admin');
    }
  });

  test('denies when ctx has no tenantRoles at all', async () => {
    const a = makeAction({ rbac: { type: 'tenant-role', role: 'user' } });
    try {
      await assertRbac(a, ctx(), { x: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacDeniedError);
      expect((err as RbacDeniedError).code).toBe('rbac_missing_tenant_role');
    }
  });
});

describe('assertRbac — custom', () => {
  test('allows when async predicate resolves true', async () => {
    let received: { ctx: ActionContext; input: unknown } | null = null;
    const rule: RbacRule = {
      type: 'custom',
      check: async (c, i) => {
        received = { ctx: c, input: i };
        return true;
      },
    };
    const a = makeAction({ rbac: rule });
    await assertRbac(a, ctx({ userId: 'u-custom' }), { x: 42 });
    expect(received).not.toBeNull();
    expect(received!.ctx.userId).toBe('u-custom');
    expect(received!.input).toEqual({ x: 42 });
  });

  test('denies with rbac_custom_denied when predicate resolves false', async () => {
    const a = makeAction({
      rbac: { type: 'custom', check: async () => false },
    });
    try {
      await assertRbac(a, ctx(), { x: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacDeniedError);
      expect((err as RbacDeniedError).code).toBe('rbac_custom_denied');
    }
  });

  test('does NOT wrap thrown errors from custom predicate (propagates as-is)', async () => {
    class BoomError extends Error {
      constructor() {
        super('boom');
        this.name = 'BoomError';
      }
    }
    const a = makeAction({
      rbac: {
        type: 'custom',
        check: async () => {
          throw new BoomError();
        },
      },
    });
    try {
      await assertRbac(a, ctx(), { x: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BoomError);
      expect(err).not.toBeInstanceOf(RbacDeniedError);
    }
  });
});

// ---------- Default rule synthesis ----------

describe('assertRbac — default rule', () => {
  test('projectId === null + missing user role -> denies as tenant-role:user', async () => {
    const a = makeAction(); // no rbac
    try {
      await assertRbac(a, ctx({ projectId: null }), { x: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacDeniedError);
      expect((err as RbacDeniedError).code).toBe('rbac_missing_tenant_role');
    }
  });

  test('projectId === null + tenantRoles includes user -> allows', async () => {
    const a = makeAction(); // no rbac
    await expect(
      assertRbac(a, ctx({ projectId: null, tenantRoles: ['user'] }), { x: 1 }),
    ).resolves.toBeUndefined();
  });
});
