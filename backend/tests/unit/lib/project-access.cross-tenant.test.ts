// tests/unit/lib/project-access.cross-tenant.test.ts
//
// Verify the cross-tenant view predicates of project-access.ts:
//   - isSuperAdminHomeView / isSuperAdminSwitchedView: the super-admin views.
//   - the AA orchestrator has NO cross-tenant view any more (fr#1437/fr#1527
//     removed its X-Tenant-Id override and `isOrchestratorSwitchedView` /
//     `isCrossTenantServiceView` with it): even a header-sourced frame on a
//     foreign tenant never widens an `aa-orchestrator` holder.
// Frame is set directly via withRequestContext (isolating from the
// buildRequestContext acceptance gate, proven in the request-context tests).

import { test, expect, describe } from 'bun:test';
import { withRequestContext } from '../../../src/middleware/request-context';
import * as projectAccess from '../../../src/lib/project-access';
import {
  isSuperAdminSwitchedView,
  isSuperAdminHomeView,
  holdsOrchestratorRole,
} from '../../../src/lib/project-access';

const HOME = '0195f48b-d000-7000-8000-000000000003'; // operator home (EXEC)
const CUSTOMER = '019f0ed6-b44e-74bf-9de8-68e28a1cdfc2';

function frame<T>(
  tenantId: string,
  source: 'jwt' | 'header',
  fn: () => T,
): Promise<T> {
  return withRequestContext(
    {
      correlationId: 'xt-test',
      initiator: 'agent',
      channel: 'web',
      tenantId,
      userId: 'op',
      activeTenantSource: source,
    },
    async () => fn(),
  );
}

const orchestrator = { roles: ['aa-orchestrator'], tenantId: HOME };
const regular = { roles: [], tenantId: HOME };
const superAdmin = { roles: ['super_admin'], tenantId: HOME };

describe('isSuperAdminHomeView', () => {
  test('super-admin with no active frame (direct/home) → true', async () => {
    // No withRequestContext frame → tryGetRequestContext() is undefined → not a
    // header override. This is the home/default view approval GET/PUT relax on.
    expect(isSuperAdminHomeView(superAdmin)).toBe(true);
  });

  test('super-admin, jwt-sourced frame (own tenant) → true', async () => {
    const r = await frame(HOME, 'jwt', () => isSuperAdminHomeView(superAdmin));
    expect(r).toBe(true);
  });

  test('super-admin UNDER a header override to a foreign tenant → false (scoped)', async () => {
    const r = await frame(CUSTOMER, 'header', () => isSuperAdminHomeView(superAdmin));
    expect(r).toBe(false);
  });

  test('super-admin header frame that matches their home tenant → true (no real override)', async () => {
    const r = await frame(HOME, 'header', () => isSuperAdminHomeView(superAdmin));
    expect(r).toBe(true);
  });

  test('non-super-admin, even in home view → false', async () => {
    expect(isSuperAdminHomeView(regular)).toBe(false);
  });
});

describe('isSuperAdminSwitchedView — the ONLY cross-tenant project view', () => {
  test('super-admin + header override + foreign tenant → true', async () => {
    const r = await frame(CUSTOMER, 'header', () =>
      isSuperAdminSwitchedView(superAdmin, CUSTOMER),
    );
    expect(r).toBe(true);
  });

  test('aa-orchestrator + header frame + foreign tenant → false (override removed)', async () => {
    const r = await frame(CUSTOMER, 'header', () =>
      isSuperAdminSwitchedView(orchestrator, CUSTOMER),
    );
    expect(r).toBe(false);
  });

  test('regular user, even header source → false', async () => {
    const r = await frame(CUSTOMER, 'header', () =>
      isSuperAdminSwitchedView(regular, CUSTOMER),
    );
    expect(r).toBe(false);
  });

  test('super-admin, tenant source = jwt (no override) → false', async () => {
    const r = await frame(CUSTOMER, 'jwt', () =>
      isSuperAdminSwitchedView(superAdmin, CUSTOMER),
    );
    expect(r).toBe(false);
  });
});

describe('the orchestrator cross-tenant arms are gone', () => {
  test('project-access exports no orchestrator cross-tenant view', () => {
    const exported = projectAccess as Record<string, unknown>;
    expect(exported.isOrchestratorSwitchedView).toBeUndefined();
    expect(exported.isCrossTenantServiceView).toBeUndefined();
  });

  test('holdsOrchestratorRole (own-tenant system seat) is still answered', () => {
    expect(holdsOrchestratorRole(orchestrator)).toBe(true);
    expect(holdsOrchestratorRole(regular)).toBe(false);
  });
});
