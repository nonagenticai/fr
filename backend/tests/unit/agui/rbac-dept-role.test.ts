// tests/unit/agui/rbac-dept-role.test.ts
//
// Foundation Plan 2 §Task 9 — `dept-role` RBAC variant. Mirrors the test
// pattern from tests/unit/services/departments.test.ts (scoped DELETE on
// the workspace UUID + beforeAll drizzle warm-up to dodge bun:test's
// parallel-loader half-link race).
//
// The plan's draft test sketched a 2-arg `assertRbac(ctx, rule)` and a
// 1-arg RbacDeniedError; the actual signatures are
// `assertRbac(action, ctx, input)` and `new RbacDeniedError(code, name,
// reason)`. Test below uses the real signatures.

import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';

import { db, queryClient, workspaces } from '../../../src/db/client';
import { ensureWorkspace } from '../../../src/services/workspaces';
import { createDepartment } from '../../../src/services/departments';
import { addMember } from '../../../src/services/department-members';
import {
  assertRbac,
  RbacDeniedError,
  type RbacRule,
} from '../../../src/agui/rbac';
import type {
  AgentCallableAction,
  ActionContext,
} from '../../../src/agui/types';

const W = '22222222-2222-2222-2222-222222222222';
const U = 'user-rbac-dept';

beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'rbac-dept-ws');
});

afterEach(async () => {
  // Cascade-clean the workspace so the next file using the same id
  // (or this file's next test) starts from a known empty state.
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
});

function makeAction(
  rule: RbacRule,
): AgentCallableAction<{ x: number }, { y: number }> {
  return {
    name: 'demo.read_thing',
    kind: 'read',
    description: 'rbac dept-role test action',
    input: z.object({ x: z.number() }),
    output: z.object({ y: z.number() }),
    approval: { type: 'auto' },
    idempotencyKey: (input) => `rbacdept:${input.x}`,
    cronSafe: true,
    handler: async (input) => ({ y: input.x * 2 }),
    rbac: rule,
  };
}

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    userId: U,
    projectId: null,
    correlationId: 'cid-rbac-dept',
    initiator: 'human',
    channel: 'web',
    ...overrides,
  };
}

test('dept-role grants when user has the required role', async () => {
  const d = await createDepartment(W, { name: 'eng' });
  await addMember(d.id, U, 'dept-admin');

  const rule: RbacRule = { type: 'dept-role', deptId: d.id, min: 'dept-admin' };
  const action = makeAction(rule);

  // Asserted, not merely called: a bare call passes on "did not throw" and
  // executes zero assertions, so this allow-path proved nothing.
  await expect(assertRbac(action, ctx(), { x: 1 })).resolves.toBeUndefined();
});

test('dept-role grants when user role exceeds the required minimum', async () => {
  const d = await createDepartment(W, { name: 'eng' });
  await addMember(d.id, U, 'dept-admin'); // > dept-manager

  const rule: RbacRule = {
    type: 'dept-role',
    deptId: d.id,
    min: 'dept-manager',
  };
  await expect(assertRbac(makeAction(rule), ctx(), { x: 1 })).resolves.toBeUndefined();
});

test('dept-role denies when user role is below required', async () => {
  const d = await createDepartment(W, { name: 'eng' });
  await addMember(d.id, U, 'dept-member');

  const rule: RbacRule = { type: 'dept-role', deptId: d.id, min: 'dept-admin' };
  const action = makeAction(rule);

  await expect(assertRbac(action, ctx(), { x: 1 })).rejects.toBeInstanceOf(
    RbacDeniedError,
  );
});

test('dept-role denies when user is not a member of the dept at all', async () => {
  const d = await createDepartment(W, { name: 'eng' });
  // No addMember call — the user is unknown to the dept.

  const rule: RbacRule = { type: 'dept-role', deptId: d.id, min: 'dept-viewer' };
  const action = makeAction(rule);

  let caught: unknown = null;
  try {
    await assertRbac(action, ctx(), { x: 1 });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RbacDeniedError);
  expect((caught as RbacDeniedError).code).toBe('rbac_not_dept_member');
});
