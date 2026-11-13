// src/routes/project-conveyor-history.ts
//
// GET /api/projects/:id/conveyor-history — what the conveyor did on this project: the asks and
// sign-offs (with answers), every card with its comment timeline, and the pull requests named in
// those comments (services/conveyor-history/history.ts).
//
// Same shape as routes/project-cockpit.ts: authenticate (runReadModel) → the
// 404-for-everything project gate (loadProjectForRead) → `{ data }` whose parts are Blocks, so an
// upstream outage renders as "unavailable: <reason>", never as "nothing happened". A project with
// no RM link is not a conveyor project: it gets `{ applicable: false }` and nothing is read.

import { runReadModel } from '../services/read-models/_lib';
import { loadProjectForRead } from '../lib/project-access';
import { projectKcTenantTag } from '../lib/project-owner-guard';
import { ctxTenantId } from '../middleware/request-context';
import { db } from '../db/client';
import { rmPmProjectIdOf } from '../services/catalogue/project-state';
import {
  buildConveyorHistory,
  NOT_A_CONVEYOR_PROJECT,
  type ConveyorHistoryResponse,
} from '../services/conveyor-history/history';
import { jsonResponse } from '../utils/response';

export async function handleGetProjectConveyorHistory(req: Request, id: string): Promise<Response> {
  return runReadModel(req, async (user) => {
    // Throws NotFoundError (→ 404) for a project the caller cannot read.
    const project = await loadProjectForRead(db, user, id);
    if ((await rmPmProjectIdOf(project)) === null) {
      return jsonResponse({ data: NOT_A_CONVEYOR_PROJECT satisfies ConveyorHistoryResponse });
    }
    const history = await buildConveyorHistory(
      {
        id: project.id,
        planka_board_id: project.planka_board_id ?? null,
        tenant_tag: projectKcTenantTag(project) ?? null,
      },
      // The approvals are pinned to the ACTIVE tenant, like the cockpit's approvals block (fr row 14d).
      ctxTenantId(user.tenantId),
    );
    const data: ConveyorHistoryResponse = { applicable: true, ...history };
    return jsonResponse({ data });
  });
}
