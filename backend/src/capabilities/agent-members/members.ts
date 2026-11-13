// fr #1683 — `/api/workspace/agent-members` (routes/agent-members.ts): the request tenant's agent members — an agent product's own
// member that acts over the `mcp` channel from the admin-created address
// `agent:<tenant>[:<product>]` as fr's autonomous user (agent decisions are allowed and
// recorded as decided_by_kind='agent'; domain/engagement/agent-members.ts). Classic API only.
//
// Gate: validateAuth (its doors), then workspace-admin of the request tenant
// (`ctxTenantId(user.tenantId)`), else 401 'workspace-admin role required' — the
// route-aware `workspace-admin` rule.
import { z } from 'zod';

import type { ResponseSpec } from '../define';
import { CreateAgentMemberBody } from '../../routes/agent-members';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, settingsCapabilities, unauthorizedBody, workspaceAdminRule } from '../settings/_shared';

const member = z.object({
  user_id: z.string().describe('The synthetic principal, a version-8 UUID (no Keycloak user, no login)'),
  product: z.string(),
  address: z.string().describe('The mcp address the agent sends from: `agent:<tenant>` or `agent:<tenant>:<product>`'),
  role: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});

const RESPONSES = (extra: string): ResponseSpec[] => [
  {
    status: 401,
    description: VALIDATE_AUTH_401 + " Or 'workspace-admin role required' (not a workspace-admin of the request tenant).",
    schema: unauthorizedBody,
  },
  {
    status: 'default',
    description: extra + DOOR_403 + " 500: fr's own (`error`), e.g. the database is unreachable.",
    schema: frErrorBody,
  },
];

export const AGENT_MEMBER_CAPABILITIES = settingsCapabilities(
  {
    area: 'workspace', tag: 'Tenant', tenancy: 'tenant',
    module: 'src/routes/agent-members.ts', load: () => import('../../routes/agent-members'),
    rule: workspaceAdminRule(),
  },
  [
    {
      id: 'workspace.list_agent_members', method: 'GET', path: '/api/workspace/agent-members', handler: 'handleListAgentMembers',
      summary: "The request tenant's agent members (workspace-admin)", effect: 'read',
      input: z.object({}), output: z.object({ data: z.array(member) }), responses: RESPONSES(''),
    },
    {
      id: 'workspace.create_agent_member', method: 'POST', path: '/api/workspace/agent-members', handler: 'handleCreateAgentMember',
      summary: "Create an agent product's own member of the request tenant and its mcp link (workspace-admin)", effect: 'write',
      description:
        'One member per (tenant, product): fr\'s autonomous user over mcp, a normal member within its role. ' +
        "Agent decisions are allowed and recorded as decided_by_kind='agent'. The default product `agent` gets the address `agent:<tenant_id>`.",
      input: CreateAgentMemberBody, output: z.object({ data: member }), successStatus: 201,
      responses: RESPONSES("400/422: invalid body. 409 `code` 'agent_member_exists'. "),
    },
    {
      id: 'workspace.delete_agent_member', method: 'DELETE', path: '/api/workspace/agent-members/:product', handler: 'handleDeleteAgentMember',
      summary: 'Remove an agent member, its role and its mcp link (workspace-admin)', effect: 'destructive',
      input: z.object({ product: z.string().describe('The agent product') }), output: z.object({}), successStatus: 204,
      responses: RESPONSES('404: no such agent member in this tenant. '),
    },
  ],
);
