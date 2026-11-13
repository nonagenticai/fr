// src/routes/auth.ts
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { conveyorConfigured } from '../config';
import { jsonResponse } from '../utils/response';

/**
 * GET /api/auth/me - Get current user profile
 *
 * Returns the resolved tenant id (from ctxTenantId so the super-admin
 * X-Active-Tenant override is reflected). Previously the response omitted
 * tenant_id entirely, which surfaced as `tenant_id: ''` in the frontend
 * auth-store log and broke "current workspace" rendering for super-admins.
 */
export async function handleGetCurrentUser(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  return jsonResponse({
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles || [],
    avatar_url: user.avatar_url || null,
    tenant_id: ctxTenantId(user.tenantId),
    created_at: new Date().toISOString(),
    // Deployment posture (config.ts conveyorConfigured): false on an instance
    // without the v4 conveyor wiring (kag.nonagentic.ai), where project creation
    // is 503 conveyor_not_configured. The SPA hides "New project" on false.
    conveyor_configured: conveyorConfigured(),
  });
}
