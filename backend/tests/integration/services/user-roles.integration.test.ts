// tests/integration/services/user-roles.integration.test.ts
//
// Hits real fr-postgres (DATABASE_URL with migration 023 applied).
// skip-if-unreachable pattern.
// Replaces the docker-spawning unit test that worked in isolation but
// suffered cross-file module-cache contamination under bun's parallel
// test runner (drizzle SELECT lost INSERT visibility when other suites had
// already imported src/db/client into the bun process).

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test';
import { db, queryClient, userRoles } from '../../../src/db/client';
import {
  hasRole,
  listUsersByRole,
  grantRole,
  revokeRole,
  DEFAULT_TENANT_ID,
} from '../../../src/services/user-roles';
import { eq, inArray } from 'drizzle-orm';

import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('user-roles');

const sql = queryClient;

const TENANT = DEFAULT_TENANT_ID;
// `isValidUuid` (src/utils/tenant.ts) enforces RFC 9562: version nibble
// in [1-8] (3rd-group 1st char) AND variant nibble in [89ab] (4th-group
// 1st char). The original `11111111-2222-3333-4444-555555555555` had
// `4` in the variant slot which fails the regex; `grantRole` then throws
// `tenantId must be a valid UUID`. Pin a v4-shaped UUID so the call
// reaches the SUT under test.
const ALT_TENANT = '11111111-2222-4333-8444-555555555555';
const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';
const TEST_USER_IDS = [userA, userB];

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM user_roles LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[user-roles.integration] postgres unreachable or migration 023 not applied — skipping:',
      (err as Error).message,
    );
  }
});

afterAll(async () => {
  if (reachable) {
    await db.delete(userRoles).where(inArray(userRoles.user_id, TEST_USER_IDS));
  }
});

beforeEach(async () => {
  if (reachable) {
    await db.delete(userRoles).where(inArray(userRoles.user_id, TEST_USER_IDS));
  }
});

const d = describe;

d('user-roles service (integration)', () => {
  // These cases use 'workspace-admin' and 'workspace-member' as their sample
  // roles. They used to use 'admin' and 'auditor', which was never the point —
  // the role strings here are arbitrary,
  // exercising the MECHANICS (idempotency on the (user, tenant, role) triple,
  // tenant scoping, revoke). Migration 104 added
  // `CHECK (role IN ('workspace-admin','workspace-member'))`, so 'admin' is no
  // longer insertable and these real-database writes would be rejected by the
  // constraint rather than testing anything. Nothing about what they assert
  // changes — the cases that need TWO DISTINCT roles (listUsersByRole filters by
  // role; revokeRole removes only the targeted triple) still have two, they are
  // just both legal values now.

  itDb('hasRole returns false when no row exists', async () => {
    expect(await hasRole(userA, TENANT, 'workspace-admin')).toBe(false);
  });

  itDb('grantRole then hasRole returns true; row carries grantedBy', async () => {
    await grantRole(userA, TENANT, 'workspace-admin', 'system');
    expect(await hasRole(userA, TENANT, 'workspace-admin')).toBe(true);

    const rows = await sql<
      { user_id: string; tenant_id: string; role: string; granted_by: string | null }[]
    >`SELECT user_id, tenant_id, role, granted_by FROM user_roles WHERE user_id = ${userA}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('workspace-admin');
    expect(rows[0]!.granted_by).toBe('system');
  });

  itDb('grantRole is idempotent on the unique (user, tenant, role) triple', async () => {
    await grantRole(userA, TENANT, 'workspace-admin', 'system');
    await grantRole(userA, TENANT, 'workspace-admin', 'someoneelse');
    await grantRole(userA, TENANT, 'workspace-admin', null);

    const rows = await sql<
      { count: string }[]
    >`SELECT COUNT(*)::text AS count FROM user_roles WHERE user_id = ${userA}`;
    expect(rows[0]!.count).toBe('1');
  });

  itDb('roles are tenant-scoped — grant in tenant A does not leak to tenant B', async () => {
    await grantRole(userA, TENANT, 'workspace-admin', null);
    expect(await hasRole(userA, TENANT, 'workspace-admin')).toBe(true);
    expect(await hasRole(userA, ALT_TENANT, 'workspace-admin')).toBe(false);
  });

  itDb('listUsersByRole returns sorted user ids for the matching tenant only', async () => {
    await grantRole(userB, TENANT, 'workspace-admin', null);
    await grantRole(userA, TENANT, 'workspace-admin', null);
    await grantRole(userA, ALT_TENANT, 'workspace-admin', null);
    await grantRole(userA, TENANT, 'workspace-member', null);

    const admins = await listUsersByRole(TENANT, 'workspace-admin');
    expect(admins).toEqual([userA, userB]);

    const members = await listUsersByRole(TENANT, 'workspace-member');
    expect(members).toEqual([userA]);

    const altAdmins = await listUsersByRole(ALT_TENANT, 'workspace-admin');
    expect(altAdmins).toEqual([userA]);
  });

  itDb('revokeRole removes only the targeted (user, tenant, role)', async () => {
    await grantRole(userA, TENANT, 'workspace-admin', null);
    await grantRole(userA, TENANT, 'workspace-member', null);
    await grantRole(userB, TENANT, 'workspace-admin', null);

    await revokeRole(userA, TENANT, 'workspace-admin');

    expect(await hasRole(userA, TENANT, 'workspace-admin')).toBe(false);
    expect(await hasRole(userA, TENANT, 'workspace-member')).toBe(true);
    expect(await hasRole(userB, TENANT, 'workspace-admin')).toBe(true);
  });

  itDb('revokeRole on a missing row is a no-op (no throw)', async () => {
    await expect(revokeRole(userA, TENANT, 'workspace-admin')).resolves.toBeUndefined();
  });

  itDb('hasRole / listUsersByRole short-circuit on empty inputs', async () => {
    expect(await hasRole('', TENANT, 'workspace-admin')).toBe(false);
    expect(await hasRole(userA, '', 'workspace-admin')).toBe(false);
    expect(await hasRole(userA, TENANT, '')).toBe(false);
    expect(await listUsersByRole('', 'workspace-admin')).toEqual([]);
    expect(await listUsersByRole(TENANT, '')).toEqual([]);
  });

  itDb('grantRole rejects empty inputs rather than silently inserting', async () => {
    await expect(grantRole('', TENANT, 'workspace-admin', null)).rejects.toThrow();
    await expect(grantRole(userA, '', 'workspace-admin', null)).rejects.toThrow();
    await expect(grantRole(userA, TENANT, '', null)).rejects.toThrow();
  });

});
