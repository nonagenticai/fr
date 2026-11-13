// tests/integration/capabilities/principal-agent-approver.integration.test.ts
//
// fr #1683 — an agent member is fr's autonomous user: it has NO Keycloak account and no
// home tenant, only a `user_roles` row in its tenant. `approverActionPrincipal` runs an
// approved action as its approver and used to require a Keycloak home (`userHomedIn`) plus
// an enabled Keycloak user, so every agent decision recorded and then failed 403
// `approver_not_tenant_member` at execution.
//
// DB-BACKED ON PURPOSE: the membership the decide arm admits an agent by is its
// `user_roles` row, so the property under test is the DB half. A stub could not fail for
// a real tenant id and would not exercise the exemption at all.

import { describe, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { approverActionPrincipal } from '../../../src/capabilities/principal';
import { agentMembers, db, userRoles } from '../../../src/db/client';
import { AppError } from '../../../src/utils/errors';
import { createDbSuite } from '../helpers/db-suite';

const { itDb, dbReachable } = createDbSuite('principal-agent-approver');

const TENANT = 'a9e10000-0000-4000-8000-000000000001';
const OTHER_TENANT = 'a9e10000-0000-4000-8000-000000000002';
/** Version-8 UUID: the third group starts with 8 — the shape `isAgentMemberId` requires. */
const AGENT = 'a9e10000-0000-8000-8000-0000000000a1';

async function cleanup(): Promise<void> {
  if (!dbReachable) return;
  await db.delete(userRoles).where(eq(userRoles.user_id, AGENT));
  await db.delete(agentMembers).where(eq(agentMembers.user_id, AGENT));
}

async function seedAgent(tenantId: string): Promise<void> {
  await cleanup();
  await db.insert(agentMembers).values({
    user_id: AGENT,
    tenant_id: tenantId,
    product: 'agent',
    address: `agent:${tenantId}`,
    created_by: 'test',
  });
  await db.insert(userRoles).values({
    user_id: AGENT,
    tenant_id: tenantId,
    role: 'workspace-member',
    granted_by: 'test',
  });
}

describe('approverActionPrincipal — an agent member of the tenant', () => {
  itDb('is a valid executing approver with its tenant role and no Keycloak read', async () => {
    await seedAgent(TENANT);

    const user = await approverActionPrincipal(AGENT, TENANT);

    expect(user.id).toBe(AGENT);
    expect(user.tenantId).toBe(TENANT);
    expect(user.roles).toEqual(['workspace-member']);
    expect(user.isServiceAccount).toBe(false);
    // No Keycloak home: the agent never claims a tenant it cannot prove.
    expect(user.tenantClaim).toBeUndefined();
    expect.hasAssertions();
  });

  itDb('is refused for a tenant it is not a member of', async () => {
    await seedAgent(TENANT);

    let caught: unknown;
    try {
      await approverActionPrincipal(AGENT, OTHER_TENANT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(403);
    expect((caught as AppError).code).toBe('approver_not_tenant_member');
    expect.hasAssertions();
  });
});
