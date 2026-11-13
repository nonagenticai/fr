// src/routes/assets/workflows.ts
//
// READ-ONLY Library surface over the n8n workflow registry.
//
// Per Foundation Design §6.4, workflows are owned by n8n — fr never
// creates / mutates them through this route. The agent generates
// workflow JSON and imports it into n8n; this surface is the Library
// reader for the resulting catalog.
//
// `?project_id=` is forwarded to applyEffectiveFilter('workflow', ...)
// so workspace overrides/blocks tied to workflow assignments shape the
// effective set. When no asset_assignments rows exist for a given
// workflow id (the typical case until Wave 3 wiring), the lazy-owns
// branch in applyEffectiveFilter populates them on first read.
//
// ⛔ THIS ROUTE NEVER TALKS TO n8n.
//
// It used to: `handleListWorkflows` called `integrations/n8n listWorkflows()`
// directly, unbounded, on a user request — which that function's own docstring
// forbids ("never run it on a user request"). The crawl is ~36 s typical and
// 82,635 ms worst MEASURED, so `GET /api/assets/workflows` outlived
// Cloudflare's proxy window and the client got the edge's 6411-byte HTML
// "Bad gateway" page instead of fr's JSON envelope — with n8n perfectly
// healthy. The rows now come from the process-global catalogue in
// `routes/workflows.ts`, refreshed by `workers/workflows-cache.ts` on a
// background tick, via `readWorkflowsCatalogue()`. Its fresh / degraded /
// too-stale semantics are inherited verbatim; this file adds no policy.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { BadRequestError } from '../../utils/errors';
import { isUuidShape } from '../../lib/uuid-shape';
import { handle } from './_lib/handler';
import {
  applyEffectiveFilter,
  projectExists,
  projectScopeHeaders,
} from './_lib/effective-query';
import { applyBindingFilter } from './_lib/binding-filter';
import { readWorkflowsCatalogue, type ListRow } from '../workflows';
import { canReadProductionWorkflows } from '../../lib/production-workflows-gate';

interface WorkflowRow {
  id: string;
  title: string;
}

/**
 * Catalogue row → Library row. `ListRow.name` is already `w.name ?? w.id`
 * (see `shapeRow` in routes/workflows.ts), but n8n's public API marks `name`
 * as optional, so the `|| r.id` fallback is kept here too: an empty title in
 * the Library picker is unusable, and it is the shape this route has always
 * emitted.
 */
function shapeWorkflow(r: ListRow): WorkflowRow {
  return { id: r.id, title: r.name || r.id };
}

export async function handleListWorkflows(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id') ?? undefined;
  const bound_to = url.searchParams.get('bound_to') ?? undefined;
  const visible_in = url.searchParams.get('visible_in') ?? undefined;

  // Shape-check BEFORE anything else, and that ordering is the point.
  // `applyEffectiveFilter` → `effectiveAssetIds` already throws the identical
  // `BadRequestError('project_id must be a UUID')` for this input (see
  // services/effective-set.ts, which explains why it is 400 and why it is
  // `isUuidShape` rather than `isValidUuid` — the latter pins the version and
  // variant nibbles and would reject `uuid` literals Postgres accepts). But it
  // only ever got the chance AFTER the row source had run, so a malformed id
  // paid the full upstream cost and then reported the UPSTREAM's failure: with
  // n8n down this route answered 502, and with n8n up it answered after a
  // multi-second crawl. Deciding here makes the 400 deterministic and free,
  // independent of upstream health. Same class, same message, same envelope —
  // `handleError` maps `AppError.statusCode` — so the contract is unchanged;
  // only when it is decided moves.
  if (projectId !== undefined && !isUuidShape(projectId)) {
    throw new BadRequestError('project_id must be a UUID');
  }

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

  // ⛔ STRICT TENANT SEPARATION (2026-09-30): every row here is a PRODUCTION
  // n8n workflow (the conveyor). A customer tenant gets the same `{data}`
  // envelope, empty — and `applyEffectiveFilter` is never run for it, so its
  // lazy-owns branch cannot write assignment rows for platform workflows into
  // a customer workspace. See `lib/production-workflows-gate.ts`.
  if (!canReadProductionWorkflows(user)) {
    return jsonResponse({ data: [] }, 200, projectScopeHeaders(projectResolved));
  }

  return handle(
    // `async` so the synchronous throw from `readWorkflowsCatalogue` (cold or
    // too-stale catalogue) becomes a rejection `handle` maps to the
    // integration-error response — 504 for UPSTREAM_TIMEOUT, 502 for an
    // unreachable n8n recorded by the background refresh. Never an empty 200:
    // a total outage must not be laundered into "this workspace owns nothing".
    async () => {
      // `readWorkflowsCatalogue().degraded` is deliberately NOT put on this
      // envelope, though the viewer route's `cacheResponse` does exactly that.
      // Two reasons, and neither is indifference to staleness: this surface's
      // contract is the bare `{data}` every sibling asset route emits and
      // that shape stays fixed, and no consumer
      // reads a marker here (the viewer's does — see
      // frontend/src/lib/api/workflows.ts). The outage SIGNAL is not lost: the
      // `[workflows] … serving cached catalogue age=…s as degraded` warn is
      // emitted inside `readCache`, which both surfaces share.
      const read = readWorkflowsCatalogue();
      const rows = read.rows.map(shapeWorkflow);
      const effective = await applyEffectiveFilter(
        ctxTenantId(user.tenantId),
        'workflow',
        rows,
        projectId,
        user.tenantName,
      );
      const filtered = await applyBindingFilter('workflow', effective, {
        bound_to,
        visible_in,
      });
      return filtered;
    },
    (data) => jsonResponse({ data }, 200, projectScopeHeaders(projectResolved)),
  );
}
