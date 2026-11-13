// src/routes/project-cockpit.ts
//
// GET /api/projects/:id/cockpit — the project cockpit read model v2 (R-CK8).
//   ?scope=header  → { scope:'header', project, status } (the shell header on every project page)
//   (default)      → the full cockpit
//
// Thin router: authenticate (runReadModel) → tenant-scoped 404 gate (loadProjectForRead) →
// aggregate → jsonResponse. Per-source failures never reach here: every panel resolves to the
// `{data, as_of, health, down_since?, detail_code?}` envelope (services/cockpit/panel.ts).

import { runReadModel } from '../services/read-models/_lib';
import { buildProjectCockpit, buildProjectCockpitHeader } from '../services/cockpit/project-cockpit';
import { loadProjectForRead } from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { db } from '../db/client';
import { jsonResponse } from '../utils/response';
import { ValidationError } from '../utils/errors';

export const COCKPIT_SCOPES = ['full', 'header'] as const;

export async function handleGetProjectCockpit(req: Request, id: string): Promise<Response> {
  return runReadModel(req, async (user) => {
    const raw = new URL(req.url).searchParams.get('scope');
    if (raw !== null && !(COCKPIT_SCOPES as readonly string[]).includes(raw)) {
      throw new ValidationError(`scope must be one of: ${COCKPIT_SCOPES.join(', ')}`, { code: 'invalid_scope' });
    }
    // 404-for-everything tenant gate — never leaks which project ids exist across tenants/owners.
    const project = await loadProjectForRead(db, user, id);
    // fr row 14d: every tenant-scoped read here is pinned to the ACTIVE tenant, for every caller.
    const tenantId = ctxTenantId(user.tenantId);
    const cockpit =
      raw === 'header' ? await buildProjectCockpitHeader(project, tenantId) : await buildProjectCockpit(project, tenantId);
    return jsonResponse(cockpit);
  });
}
