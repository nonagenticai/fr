// src/routes/admin/control-tower.ts
//
// GET /api/admin/control-tower — super-admin control-tower read model (AA
// cockpit B5, the last cockpit). Design contract:
// docs/cockpit-super-admin-control-tower-proposal.html. Super-admin only —
// non-super-admins get the SAME 404 shape as requireInternalTenant so the
// operator surface stays invisible. The aggregator composes the three
// improvement lenses' cheap lane summaries with fleet-wide fr-DB + read-only
// upstream probes; every block degrades independently (block envelope), so a
// dead upstream never 500s the tower.

import { runReadModel, requireSuperAdminRead } from '../../services/read-models/_lib';
import { buildControlTower } from '../../services/control-tower';
import { jsonResponse } from '../../utils/response';

export async function handleGetControlTower(req: Request): Promise<Response> {
  return runReadModel(req, async (user) => {
    requireSuperAdminRead(user);
    return jsonResponse(await buildControlTower());
  });
}
