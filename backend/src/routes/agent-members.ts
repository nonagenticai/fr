// src/routes/agent-members.ts
//
// fr #1683 — a tenant's agent members: an agent product's own service member that
// acts over the `mcp` channel (domain/engagement/agent-members.ts). Created by a
// workspace-admin only; never self-linked.
//
//   GET    /api/workspace/agent-members            → 200 { data: AgentMember[] }
//   POST   /api/workspace/agent-members            → 201 { data: AgentMember }   body { product?, role? }
//   DELETE /api/workspace/agent-members/:product   → 204
//
// Gate: validateAuth, then `isWorkspaceAdminVia` of the request tenant, else 401
// 'workspace-admin role required'.

import { z } from 'zod';

import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { createdResponse, jsonResponse, noContentResponse } from '../utils/response';
import { AppError, handleError, NotFoundError, UnauthorizedError } from '../utils/errors';
import type { User } from '../types/api';
import { userRolesService } from '../services/user-roles';
import {
  AGENT_PRODUCT_PATTERN,
  AgentMemberExistsError,
  DEFAULT_AGENT_PRODUCT,
  createAgentMember,
  deleteAgentMember,
  listAgentMembers,
  type AgentMember,
} from '../domain/engagement/agent-members';

export const CreateAgentMemberBody = z.object({
  product: z.string().regex(AGENT_PRODUCT_PATTERN).default(DEFAULT_AGENT_PRODUCT),
  role: z.enum(['workspace-member', 'workspace-admin']).default('workspace-member'),
});

async function requireAdmin(req: Request): Promise<{ user: User; tenantId: string }> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  if (!(await userRolesService.isWorkspaceAdminVia(user, tenantId, userRolesService.hasRole))) {
    throw new UnauthorizedError('workspace-admin role required');
  }
  return { user, tenantId };
}

function wire(m: AgentMember) {
  return {
    user_id: m.user_id,
    product: m.product,
    address: m.address,
    role: m.role,
    created_by: m.created_by,
    created_at: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
  };
}

export async function handleListAgentMembers(req: Request): Promise<Response> {
  try {
    const { tenantId } = await requireAdmin(req);
    return jsonResponse({ data: (await listAgentMembers(tenantId)).map(wire) });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleCreateAgentMember(req: Request): Promise<Response> {
  try {
    const { user, tenantId } = await requireAdmin(req);
    const body = CreateAgentMemberBody.parse(await req.json().catch(() => ({})));
    try {
      const member = await createAgentMember({ tenantId, product: body.product, role: body.role, createdBy: user.id });
      return createdResponse({ data: wire(member) });
    } catch (err) {
      if (err instanceof AgentMemberExistsError) {
        throw new AppError(409, err.message).withCode('agent_member_exists');
      }
      throw err;
    }
  } catch (err) {
    return handleError(err);
  }
}

export async function handleDeleteAgentMember(req: Request, product: string): Promise<Response> {
  try {
    const { tenantId } = await requireAdmin(req);
    if (!AGENT_PRODUCT_PATTERN.test(product) || !(await deleteAgentMember(tenantId, product))) {
      throw new NotFoundError('Agent member not found');
    }
    return noContentResponse();
  } catch (err) {
    return handleError(err);
  }
}
