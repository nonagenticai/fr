// tests/auth/requireDeptRole.test.ts
//
// Spec 2 Plan 2-C Phase 0.5 Task 0.5.1 — coverage for the dept-role HTTP gate
// that gates the scheduled-triggers + scheduled-reports handlers (Spec §13).
//
// Runs against the real Postgres with the real default lookup
// (`getMemberRole`): one workspace + department is seeded per run, with one
// member per dept role, so the ordering rules
// (dept-viewer < dept-member < dept-manager < dept-admin) and the
// workspace-admin bypass are exercised exactly as production runs them.

import {
  afterAll,
  beforeAll,
  describe,
  expect,
} from 'bun:test';
import { eq } from 'drizzle-orm';

import { requireDeptRole } from '../../src/auth/requireDeptRole';
import { db, departments, departmentMembers, workspaces } from '../../src/db/client';
import type { DeptRole } from '../../src/db/schema';
import { AppError } from '../../src/utils/errors';
import type { User } from '../../src/types/api';
import { createDbSuite } from '../integration/helpers/db-suite';

const { itDb } = createDbSuite('require-dept-role');

const TENANT = crypto.randomUUID();
let DEPT = '';
const ROLES: DeptRole[] = ['dept-viewer', 'dept-member', 'dept-manager', 'dept-admin'];
const userIdFor = (role: DeptRole | 'none'): string => `rdr-${TENANT.slice(0, 8)}-${role}`;

function user(over: Partial<User> = {}): User {
  return {
    id: userIdFor('none'),
    email: 'u@example.com',
    name: 'Test User',
    roles: [],
    tenantId: TENANT,
    ...over,
  };
}

const member = (role: DeptRole): User => user({ id: userIdFor(role) });

beforeAll(async () => {
  try {
    await db.insert(workspaces).values({ id: TENANT, name: `require-dept-role-${TENANT.slice(0, 8)}` });
    const [dept] = await db
      .insert(departments)
      .values({ workspace_id: TENANT, name: 'require-dept-role' })
      .returning({ id: departments.id });
    DEPT = dept!.id;
    await db
      .insert(departmentMembers)
      .values(ROLES.map((role) => ({ dept_id: DEPT, user_id: userIdFor(role), role })));
  } catch {
    // No database: createDbSuite skips (or hard-fails in CI) every itDb below.
  }
});

afterAll(async () => {
  try {
    // departments + department_members cascade from the workspace.
    await db.delete(workspaces).where(eq(workspaces.id, TENANT));
  } catch {
    // No database — nothing was seeded.
  }
});

describe('requireDeptRole — workspace-admin bypass', () => {
  // fr#1289: the claim arm is PINNED — realm `tenant_admin` (or legacy
  // `admin`) bypasses only when the raw `tenant_id` claim equals the tenant.
  // The caller is NOT a member of the department, so only the bypass can pass it.
  itDb('tenant_admin pinned to the tenant passes every minRole without membership', async () => {
    const u = user({ roles: ['tenant_admin'], tenantClaim: TENANT });
    for (const min of ROLES) {
      await expect(requireDeptRole(u, DEPT, min)).resolves.toBeUndefined();
    }
  });

  itDb('legacy admin pinned to the tenant bypasses', async () => {
    const u = user({ roles: ['admin'], tenantClaim: TENANT });
    await expect(requireDeptRole(u, DEPT, 'dept-admin')).resolves.toBeUndefined();
  });

  // The test user has no `user_roles` grant, so the claim arm alone decides.
  itDb('bare admin WITHOUT a tenant_id claim is refused (no unpinned arm)', async () => {
    const u = user({ roles: ['admin'] });
    await expect(requireDeptRole(u, DEPT, 'dept-admin')).rejects.toBeInstanceOf(AppError);
  });

  itDb('bare workspace-admin claim is refused even when pinned (no such realm role)', async () => {
    const u = user({ roles: ['workspace-admin'], tenantClaim: TENANT });
    await expect(requireDeptRole(u, DEPT, 'dept-admin')).rejects.toBeInstanceOf(AppError);
  });
});

describe('requireDeptRole — role ordering (real department_members rows)', () => {
  itDb('each role satisfies exactly the minRoles at or below it', async () => {
    for (const [have, haveRole] of ROLES.entries()) {
      for (const [need, minRole] of ROLES.entries()) {
        const gate = requireDeptRole(member(haveRole), DEPT, minRole);
        if (have >= need) await expect(gate).resolves.toBeUndefined();
        else await expect(gate).rejects.toBeInstanceOf(AppError);
      }
    }
  });

  itDb('a membership in this department does not carry to another department', async () => {
    await expect(
      requireDeptRole(member('dept-admin'), crypto.randomUUID(), 'dept-viewer'),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('requireDeptRole — non-member', () => {
  itDb('a non-member is rejected with 403 AppError', async () => {
    let caught: unknown;
    try {
      await requireDeptRole(user(), DEPT, 'dept-viewer');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(403);
  });
});
