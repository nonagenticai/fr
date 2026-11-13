// src/routes/assets/triggers.ts
//
// Library alias surface over /api/scheduled-triggers. Same RBAC + tenant
// scoping as the canonical resource; reshapes rows into the Library
// `{ id, title, project_id, dept_id }` envelope and applies the
// `applyEffectiveFilter('trigger', ...)` seam for workspace/department/
// project overrides.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import {
  applyEffectiveFilter,
  projectExists,
  projectScopeHeaders,
} from './_lib/effective-query';
import { applyBindingFilter } from './_lib/binding-filter';
import {
  attachProjectDept,
  listScheduledTriggersForUser,
} from '../../services/scheduled-triggers/list';

interface TriggerRow {
  id: string;
  title: string;
  project_id: string;
  dept_id: string | null;
}

export async function handleListTriggers(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id') ?? undefined;
  // ⛔ AN EMPTY SET MUST SAY WHY IT IS EMPTY. `applyEffectiveFilter` returns
  // `[]` for a well-formed-but-unknown project_id, and `effective-query.ts`
  // justifies that `[]` ONLY because the route reports the cause out of band:
  // "an empty set WITHOUT that header would be the defect that comment warns
  // about." This route applies that filter, so it owes that header.
  //
  // Resolved HERE rather than inside `handle` because `handle`'s response
  // mapper only receives `data` — it cannot see why the list is short.
  // `projectExists` is the SAME predicate the filter uses, so header and body
  // can never disagree; on a non-UUID it throws the identical
  // `BadRequestError('project_id must be a UUID')` the filter would have
  // thrown one layer down, only earlier and before any upstream call.
  const projectResolved =
    projectId === undefined ? undefined : await projectExists(projectId);
  const bound_to = url.searchParams.get('bound_to') ?? undefined;
  const visible_in = url.searchParams.get('visible_in') ?? undefined;
  return handle(
    async () => {
      const rows = await listScheduledTriggersForUser(user, { projectId });
      const enriched = await attachProjectDept(rows);
      const shaped: TriggerRow[] = enriched.map((r) => ({
        id: r.id,
        title: r.name,
        project_id: r.project_id,
        dept_id: r.dept_id,
      }));
      const effective = await applyEffectiveFilter(
        ctxTenantId(user.tenantId),
        'trigger',
        shaped,
        projectId,
        user.tenantName,
      );
      return applyBindingFilter('trigger', effective, {
        bound_to,
        visible_in,
      });
    },
    (data) => jsonResponse({ data }, 200, projectScopeHeaders(projectResolved)),
  );
}
