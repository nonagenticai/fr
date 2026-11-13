// src/domain/engagement/agent-members.ts
//
// fr #1683 (owner decisions 2026-10-31): the agent platform is fr's autonomous user over
// mcp. Each agent product is its OWN member of the tenant, never a linked person: one
// member per (tenant, product), created by a workspace-admin (routes/agent-members.ts),
// never self-linked:
//
//   agent_members        user_id (a version-8 UUID), tenant, product, address
//   user_roles           its admin-assigned role in the tenant
//   user_channel_prefs   its `mcp` link, address `agent:<tenant>[:<product>]`,
//                        pinned to the tenant (replies, results, approvals)
//
// It has no Keycloak user and no login. The identity resolver accepts it only for an
// `agent:` address whose agent_members row matches the link (agent-core/identity.ts).
// It is a normal member within its role: it starts projects, runs writes and decides
// approvals. Agent decisions are allowed and recorded as decided_by_kind='agent', with
// `via` naming the agent member and job; a message carrying a resolvable `on_behalf_of`
// runs as that staff member instead (recorded 'human' + via).
// Approvals and questions multicast to every member's configured channels, the agent's
// mcp link included, on every project (owner direction 2026-10-31); the first answer from
// any channel wins and later ones get already_decided. Self-links cannot claim an
// `agent:` address (routes/me/channels.ts).

import { and, eq } from 'drizzle-orm';

import { agentMembers, db, projects, userChannelPrefs, userRoles, workspaces } from '../../db/client';

/** Version-8 UUID: Keycloak issues only v4 ids, so this shape never names a person. */
const AGENT_MEMBER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const AGENT_ADDRESS_PREFIX = 'agent:';
export const AGENT_PRODUCT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The product whose address is the bare `agent:<tenant>` the agent platform sends. */
export const DEFAULT_AGENT_PRODUCT = 'agent';

export type AgentMemberRole = 'workspace-member' | 'workspace-admin';

export interface AgentMember {
  user_id: string;
  tenant_id: string;
  product: string;
  address: string;
  role: string | null;
  created_by: string;
  created_at: Date;
}

/** A synthetic agent principal (pure shape check, no lookup). */
export function isAgentMemberId(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && AGENT_MEMBER_ID_RE.test(userId);
}

export function newAgentMemberId(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}

/** Reserved for admin-created agent links; a person can never link one. */
export function isReservedAgentAddress(address: string): boolean {
  return address.trim().toLowerCase().startsWith(AGENT_ADDRESS_PREFIX);
}

export function agentAddressFor(tenantId: string, product: string): string {
  return product === DEFAULT_AGENT_PRODUCT
    ? `${AGENT_ADDRESS_PREFIX}${tenantId}`
    : `${AGENT_ADDRESS_PREFIX}${tenantId}:${product}`;
}

export class AgentMemberExistsError extends Error {
  constructor(readonly existing: AgentMember) {
    super(`an agent member for product '${existing.product}' already exists in this tenant`);
    this.name = 'AgentMemberExistsError';
  }
}

export async function listAgentMembers(tenantId: string): Promise<AgentMember[]> {
  const rows = await db
    .select({
      user_id: agentMembers.user_id,
      tenant_id: agentMembers.tenant_id,
      product: agentMembers.product,
      address: agentMembers.address,
      role: userRoles.role,
      created_by: agentMembers.created_by,
      created_at: agentMembers.created_at,
    })
    .from(agentMembers)
    .leftJoin(userRoles, and(eq(userRoles.user_id, agentMembers.user_id), eq(userRoles.tenant_id, agentMembers.tenant_id)))
    .where(eq(agentMembers.tenant_id, tenantId))
    .orderBy(agentMembers.product);
  return rows;
}

/** The agent member that owns `address`, or null. Only an `agent:` address can match. */
export async function findAgentMemberByAddress(address: string): Promise<AgentMember | null> {
  if (!isReservedAgentAddress(address)) return null;
  const [row] = await db
    .select({
      user_id: agentMembers.user_id,
      tenant_id: agentMembers.tenant_id,
      product: agentMembers.product,
      address: agentMembers.address,
      role: userRoles.role,
      created_by: agentMembers.created_by,
      created_at: agentMembers.created_at,
    })
    .from(agentMembers)
    .leftJoin(userRoles, and(eq(userRoles.user_id, agentMembers.user_id), eq(userRoles.tenant_id, agentMembers.tenant_id)))
    .where(eq(agentMembers.address, address))
    .limit(1);
  return row ?? null;
}

/**
 * The `user_id` of the tenant's default agent member (product `agent`), or null.
 * Used where a gate needs a decider in a tenant that has no human member: the
 * agent member holds a `user_roles` row in the same tenant and can decide.
 */
export async function findDefaultAgentMemberId(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ user_id: agentMembers.user_id })
    .from(agentMembers)
    .where(and(eq(agentMembers.tenant_id, tenantId), eq(agentMembers.product, DEFAULT_AGENT_PRODUCT)))
    .limit(1);
  return row?.user_id ?? null;
}

export async function createAgentMember(input: {
  tenantId: string;
  product: string;
  role: AgentMemberRole;
  createdBy: string;
}): Promise<AgentMember> {
  const address = agentAddressFor(input.tenantId, input.product);
  const userId = newAgentMemberId();
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agentMembers)
      .values({ user_id: userId, tenant_id: input.tenantId, product: input.product, address, created_by: input.createdBy })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    const [ws] = await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, input.tenantId)).limit(1);
    await tx.insert(userRoles).values({
      user_id: userId,
      tenant_id: input.tenantId,
      tenant_name: ws?.name ?? null,
      role: input.role,
      granted_by: input.createdBy,
    });
    await tx.insert(userChannelPrefs).values({
      user_id: userId,
      channel: 'mcp',
      address,
      tenant_id: input.tenantId,
      enabled: true,
      is_default: true,
    });
    return { ...row, role: input.role };
  });
  if (created) return created;
  const existing = (await listAgentMembers(input.tenantId)).find((m) => m.product === input.product);
  if (existing) throw new AgentMemberExistsError(existing);
  // The address is taken by another tenant's row: impossible while addresses embed the tenant.
  throw new Error(`agent address ${address} is already registered`);
}

/** Remove the member, its role and its link. Returns false when the tenant has no such member. */
export async function deleteAgentMember(tenantId: string, product: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(agentMembers)
      .where(and(eq(agentMembers.tenant_id, tenantId), eq(agentMembers.product, product)))
      .returning({ user_id: agentMembers.user_id });
    if (!row) return false;
    await tx.delete(userRoles).where(eq(userRoles.user_id, row.user_id));
    await tx.delete(userChannelPrefs).where(eq(userChannelPrefs.user_id, row.user_id));
    return true;
  });
}
