// src/routes/admin/verification.ts
//
// GET /api/admin/verification/* — super-admin verification read models
// (/operate/verification). Contract: judge-oracle tournament review
// fr-routes.md (2026-09-23).
//
// Super-admin only. Non-super-admins get the SAME 404 as every other admin read
// model (requireSuperAdminRead), so the surface stays invisible. Each response is ONE Block<T>
// whose `data` is the upstream payload verbatim; an upstream outage is
// `available:false` inside a 200, never a 500 and never zeros.

import { jsonResponse } from '../../utils/response';
import { daysOnly } from './operator-read-schemas';
import {
  parseQuery,
  requireSuperAdminRead,
  runReadModel,
} from '../../services/read-models/_lib';
import {
  getAlerts,
  getServedModelsTimeline,
} from '../../services/verification';

// The query schemas live in operator-read-schemas.ts (side-effect free: the
// fr-agui capability declarations share them, P4c part 1).

// Every handler returns the service's Block<T> as the literal `{ data, meta }`
// (not `jsonResponse(block)`) so the shape is visible at the handler.

export async function handleGetVerificationServedModels(req: Request): Promise<Response> {
  return runReadModel(req, async (user) => {
    requireSuperAdminRead(user);
    const { data, meta } = await getServedModelsTimeline(parseQuery(daysOnly, req));
    return jsonResponse({ data, meta });
  });
}

// A10.4: fr's own Prometheus read (a second upstream block, not an ILS passthrough).
export async function handleGetVerificationAlerts(req: Request): Promise<Response> {
  return runReadModel(req, async (user) => {
    requireSuperAdminRead(user);
    const { data, meta } = await getAlerts();
    return jsonResponse({ data, meta });
  });
}
