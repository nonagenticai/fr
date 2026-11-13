// tests/integration/domain/agent-members.integration.test.ts
//
// fr #1683: an agent product acts over mcp as its OWN member of the tenant — fr's
// autonomous user there. Real CI postgres, and no Keycloak at all — which is the point:
// the agent member has no Keycloak user, so every path below must answer without one.

import { afterEach, describe, expect } from 'bun:test';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';

import { KeycloakIdentityResolver } from '../../../src/agent-core/identity';
import type { ActionContext, AgentCallableAction } from '../../../src/agui/types';
import { assertChannelTenantResolved, resolveChannelTenant } from '../../../src/capabilities/principal';
import {
  agentMembers,
  approvals,
  db,
  engagementDeliveries,
  requiredApprovers,
  projects,
  userChannelPrefs,
  userRoles,
  workspaces,
} from '../../../src/db/client';
import {
  AgentMemberExistsError,
  createAgentMember,
  deleteAgentMember,
  findAgentMemberByAddress,
  isReservedAgentAddress,
  listAgentMembers,
  newAgentMemberId,
} from '../../../src/domain/engagement/agent-members';
import { requestActionApproval, shouldSelfApprove } from '../../../src/domain/engagement/action-approvals';
import { resolveApprover } from '../../../src/domain/engagement/approval-routing';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '6a83e0b5-1683-4c11-9a55-000000001683';
const HUMAN = '6a83e0b5-1683-4c11-9a55-0000000016aa';
const JOB = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const { itDb } = createDbSuite('agent-members');

async function clean(): Promise<void> {
  const ids = (await db.select({ id: agentMembers.user_id }).from(agentMembers).where(eq(agentMembers.tenant_id, TENANT))).map((r) => r.id);
  await db.delete(agentMembers).where(eq(agentMembers.tenant_id, TENANT));
  await db.delete(userRoles).where(eq(userRoles.tenant_id, TENANT));
  if (ids.length) await db.delete(userChannelPrefs).where(inArray(userChannelPrefs.user_id, ids));
  const appr = (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.tenant_id, TENANT))).map((r) => r.id);
  if (appr.length) {
    await db.delete(requiredApprovers).where(inArray(requiredApprovers.approval_id, appr));
    await db.delete(engagementDeliveries).where(inArray(engagementDeliveries.engagement_id, appr));
    await db.delete(approvals).where(inArray(approvals.id, appr));
  }
}
afterEach(clean);

const agentCtx = (userId: string, extra: Partial<ActionContext> = {}): ActionContext => ({
  userId,
  projectId: null,
  correlationId: 'job-1683',
  initiator: 'agent',
  channel: 'mcp',
  tenantRoles: [],
  tenantId: TENANT,
  channelLinkedTenantId: TENANT,
  ...extra,
});

describe('agent members', () => {
  itDb('an admin-created member gets a role, a pinned mcp link and the agent:<tenant> address; one per product', async () => {
    const m = await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-member', createdBy: HUMAN });
    expect(m.user_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8/);
    expect(m.address).toBe(`agent:${TENANT}`);
    const [link] = await db.select().from(userChannelPrefs).where(eq(userChannelPrefs.user_id, m.user_id));
    expect(link).toMatchObject({ channel: 'mcp', address: `agent:${TENANT}`, tenant_id: TENANT, enabled: true });
    expect((await listAgentMembers(TENANT)).map((x) => [x.product, x.role])).toEqual([['agent', 'workspace-member']]);
    await expect(
      createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-admin', createdBy: HUMAN }),
    ).rejects.toBeInstanceOf(AgentMemberExistsError);
    const other = await createAgentMember({ tenantId: TENANT, product: 'care-bus', role: 'workspace-member', createdBy: HUMAN });
    expect(other.address).toBe(`agent:${TENANT}:care-bus`);

    expect(await deleteAgentMember(TENANT, 'agent')).toBe(true);
    expect(await findAgentMemberByAddress(`agent:${TENANT}`)).toBeNull();
    expect(await db.select().from(userChannelPrefs).where(eq(userChannelPrefs.user_id, m.user_id))).toHaveLength(0);
    expect(await deleteAgentMember(TENANT, 'agent')).toBe(false);
  });

  itDb('the mcp resolver answers the agent member without Keycloak, in its own tenant', async () => {
    const m = await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-member', createdBy: HUMAN });
    const id = await new KeycloakIdentityResolver().resolveIdentity({
      channel: 'mcp', userId: '', address: `agent:${TENANT}`, text: 'help', correlationId: 'c', raw: {},
    });
    expect(id).toEqual({ userId: m.user_id, tenantRoles: [], agentMember: { tenantId: TENANT, product: 'agent' } });

    const r = await resolveChannelTenant(m.user_id, TENANT);
    expect(r.kind === 'ok' && r.tenant.id).toBe(TENANT);
    await expect(assertChannelTenantResolved({ userId: m.user_id, tenantId: TENANT, channelLinkedTenantId: TENANT })).resolves.toBeUndefined();
  });

  itDb('a self-link row cannot speak as the agent: an agent: address on another principal is not the agent', async () => {
    await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-member', createdBy: HUMAN });
    // A forged second agent-member link on the same address (no agent_members row of its own).
    const forged = newAgentMemberId();
    await db.insert(userChannelPrefs).values({ user_id: forged, channel: 'mcp', address: `agent:${TENANT}`, enabled: true });
    const id = await new KeycloakIdentityResolver().resolveIdentity({
      channel: 'mcp', userId: '', address: `agent:${TENANT}`, text: 'help', correlationId: 'c', raw: {},
    });
    expect(id?.agentMember?.tenantId).toBe(TENANT);
    expect(id?.userId).not.toBe(forged);
    await db.delete(userChannelPrefs).where(eq(userChannelPrefs.user_id, forged));
    expect(isReservedAgentAddress(' Agent:x')).toBe(true);
    expect(isReservedAgentAddress('care-bus:t:1')).toBe(false);
  });

  itDb('its own write runs directly when the policy names the initiator; a person still confirms theirs', async () => {
    const m = await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-member', createdBy: HUMAN });
    const selfPolicy = {
      name: 'test.agent_write', description: 'x', kind: 'write',
      approval: { type: 'single-approver', approver: 'initiator' },
    } as unknown as AgentCallableAction;
    expect(await shouldSelfApprove(selfPolicy, agentCtx(m.user_id, { initiator: 'human' }))).toBe(true);
    // A person on a channel (no autoApproveForInitiator) parks for their own `approve <id>`.
    expect(await shouldSelfApprove(selfPolicy, agentCtx(HUMAN, { initiator: 'human' }))).toBe(false);
    // A policy naming someone else is never self-approved, for the agent either.
    const otherPolicy = { ...selfPolicy, approval: { type: 'single-approver', approver: HUMAN } } as unknown as AgentCallableAction;
    expect(await shouldSelfApprove(otherPolicy, agentCtx(m.user_id, { initiator: 'human' }))).toBe(false);
  });

  itDb('a write the agent asks that names another approver parks for them, with via', async () => {
    const m = await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-member', createdBy: HUMAN });
    const action = {
      name: 'test.agent_write', description: 'agent member park test', kind: 'write',
      approval: { type: 'single-approver', approver: HUMAN },
    } as unknown as AgentCallableAction;
    const via = { channel: 'mcp', agent_member_id: m.user_id, product: 'agent', job_id: JOB };
    const pending = await requestActionApproval(action, {}, agentCtx(m.user_id, { initiator: 'human', decisionVia: via }));
    const [row] = await db.select().from(approvals).where(eq(approvals.id, pending.approvalId));
    expect(row!.requester_id).toBe(m.user_id);
    expect(row!.metadata).toMatchObject({ initiator: 'human', via });
    const roster = await db.select().from(requiredApprovers).where(eq(requiredApprovers.approval_id, pending.approvalId));
    expect(roster.map((r) => r.user_id)).toEqual([HUMAN]);
  });

  itDb('the agent is an ordinary member in routing: no agent-only rule', async () => {
    // Owner direction 2026-10-31: approvals multicast to every member's channels; the agent
    // is routed like any member (its mcp link is its push channel), on every project.
    const m = await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-member', createdBy: HUMAN });
    await db.insert(userRoles).values({ user_id: HUMAN, tenant_id: TENANT, role: 'workspace-admin' });
    await db.insert(userChannelPrefs).values({ user_id: HUMAN, channel: 'telegram', address: 'human-1683-tg', enabled: true });
    await db.insert(workspaces).values({ id: TENANT, name: 'agent members test' }).onConflictDoNothing();
    const [agentProject] = await db
      .insert(projects)
      .values({ owner_id: m.user_id, name: 'agent-1683-project', project_data: { keycloak_tenant_id: TENANT } })
      .returning({ id: projects.id });
    const [humanProject] = await db
      .insert(projects)
      .values({ owner_id: HUMAN, name: 'human-1683-project', project_data: { keycloak_tenant_id: TENANT } })
      .returning({ id: projects.id });
    try {
      // The admin rung first, then the project owner: the agent is a candidate like any owner.
      const agentOwned = await resolveApprover({ tenantId: TENANT, projectId: agentProject!.id });
      expect(agentOwned.approver?.userId).toBe(HUMAN);
      expect((await resolveApprover({ tenantId: TENANT, projectId: humanProject!.id })).approver?.userId).toBe(HUMAN);
      // A tenant whose only member with a push channel is the agent is agent-run: the
      // approval is routed to it rather than refused for want of an approver.
      // mcp counts as a push channel only when fr can reach the MCP server, which config
      // reads at import: a fresh child with it configured.
      // No project (no owner rung): the agent as the tenant's only admin.
      await db.delete(userRoles).where(eq(userRoles.user_id, HUMAN));
      await db.update(userRoles).set({ role: 'workspace-admin' }).where(eq(userRoles.user_id, m.user_id));
      const child = Bun.spawnSync(['bun', '-e', `
        const { resolveApprover } = await import('./src/domain/engagement/approval-routing');
        const r = await resolveApprover({ tenantId: ${JSON.stringify(TENANT)} });
        console.log('RESULT ' + JSON.stringify(r.approver));
        process.exit(0);
      `], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, MCP_EVENTS_URL: 'http://mcp.invalid/api/channels/fr/events', FR_MCP_CHANNEL_SECRET: 'test-secret' },
      });
      const out = child.stdout.toString() + child.stderr.toString();
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      expect(line, out).toBeDefined();
      expect(JSON.parse(line!.slice('RESULT '.length)), out).toMatchObject({ userId: m.user_id, channels: ['mcp'] });
    } finally {
      await db.delete(projects).where(inArray(projects.id, [agentProject!.id, humanProject!.id]));
      await db.delete(userChannelPrefs).where(eq(userChannelPrefs.address, 'human-1683-tg'));
      await db.delete(workspaces).where(eq(workspaces.id, TENANT));
    }
  });
});
