// A channel link pinned to a workspace (user_channel_prefs.tenant_id, migration 216)
// resolves a multi-workspace sender at BOTH layers: the dispatcher's
// resolveChannelTenant and the write-site re-check assertChannelTenantResolved
// (the park step and projects.create). Real CI postgres; AUTH_BYPASS stands in for
// the Keycloak home-tenant read (userHomedIn), which is not under test here.
process.env.AUTH_BYPASS = 'true';

import { afterAll, beforeEach, describe, expect } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, userRoles } from '../../../src/db/client';
import { assertChannelTenantResolved, resolveChannelTenant } from '../../../src/capabilities/principal';
import { createDbSuite } from '../helpers/db-suite';

const USER = 'channel-tenant-pin-int-user';
const T1 = '7a1c0c4e-2f7e-4e64-9a51-0b6c1d5e0001';
const T2 = '7a1c0c4e-2f7e-4e64-9a51-0b6c1d5e0002';
const T3 = '7a1c0c4e-2f7e-4e64-9a51-0b6c1d5e0003';

const { itDb } = createDbSuite('channel-tenant-pin');

async function clean(): Promise<void> {
  await db.delete(userRoles).where(inArray(userRoles.user_id, [USER]));
}

describe('a pinned channel link for a multi-workspace sender', () => {
  beforeEach(async () => {
    await clean();
    await db.insert(userRoles).values([
      { user_id: USER, tenant_id: T1, role: 'workspace-member' },
      { user_id: USER, tenant_id: T2, role: 'workspace-member' },
    ]);
  });
  afterAll(clean);

  itDb('unpinned: ambiguous at both layers (nothing is created)', async () => {
    expect((await resolveChannelTenant(USER)).kind).toBe('ambiguous');
    await expect(assertChannelTenantResolved({ userId: USER, tenantId: T1 })).rejects.toThrow();
  });

  itDb('pinned to T1: resolves to T1 at the dispatcher AND at the park step', async () => {
    const r = await resolveChannelTenant(USER, T1);
    expect(r.kind === 'ok' && r.tenant.id).toBe(T1);
    await expect(
      assertChannelTenantResolved({ userId: USER, tenantId: T1, channelLinkedTenantId: T1 }),
    ).resolves.toBeUndefined();
    // The pin does not let a request act in a different workspace.
    await expect(
      assertChannelTenantResolved({ userId: USER, tenantId: T2, channelLinkedTenantId: T1 }),
    ).rejects.toThrow();
  });

  itDb('pinned to a workspace the sender is not a member of: refused', async () => {
    expect((await resolveChannelTenant(USER, T3)).kind).toBe('mismatch');
    await expect(
      assertChannelTenantResolved({ userId: USER, tenantId: T3, channelLinkedTenantId: T3 }),
    ).rejects.toThrow();
  });
});
