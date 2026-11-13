// src/routes/assets/channels.ts
//
// Library alias surface over /api/channels.
//
// ⭐ TWO TABLES, TWO QUESTIONS — and conflating them was this route's defect.
//
// 1. `asset_assignments` (ASSIGNMENT / effective-set) genuinely CANNOT carry a
//    project-scoped channel. The constraint is real, verbatim, in
//    `backend/migrations/030_asset_assignments.sql`:
//        CHECK (asset_type <> 'channel' OR scope_kind IN ('workspace','department'))
//    ⚠️ This header used to cite "migration 028". That number is WRONG — file
//    028 is `028_streams_canary_enabled.sql`. The confusion is inside the
//    migration itself: 030's own first line still reads
//    `-- backend/migrations/028_asset_assignments.sql` from before it was
//    renumbered. The CONSTRAINT is real; only the citation was stale.
//    ⇒ so with `?project_id=`, applyEffectiveFilter walks workspace → department
//    and project-level rows are physically impossible. That half was correct.
//
// 2. `asset_bindings` (BINDING / "which assets does n8n see on project P")
//    has NO such restriction — migration 067 declares one table for all nine
//    kinds, channel included, and `routes/assets/bindings.ts` validates a
//    channel bind against `channels.workspace_id`. Binding a channel to a
//    project is legal and `POST /api/assets/:kind/:id/bindings` writes it.
//
// ⛔ THE BUG: this route read only `project_id` + `origin` and never
// `bound_to`, so `ProjectLibraryTab` — which requests
// `/api/assets/channels?bound_to=<project_id>` and captions the result
// "{pluralLabel} bound to this project" — had its filter SILENTLY DROPPED and
// was handed the ENTIRE TENANT. The same mismatch made `ProjectBindMore`
// inert by construction: it wrote `asset_bindings` while the only filter this
// route applied read `asset_assignments`. `applyBindingFilter` existed and was
// never called from here, though `triggers.ts`/`workflows.ts` both call it.
// The bindings table is the ONLY viable project scope for a channel, so the
// mismatch was the whole bug — fixed by reading the param and running it
// through the same seam a sibling route uses.
//
// Query params:
//   - project_id : narrow to the effective set for a project (workspace/dept walk)
//   - origin     : 'tenant' | 'workflow' — channels are fr-local with a real
//                  origin_kind column, so this is a real filter (never 'project').
//   - bound_to   : only channels explicitly bound to that project (asset_bindings)
//   - visible_in : bound to that project UNION bound nowhere (tenant-wide)

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { BadRequestError } from '../../utils/errors';
import { handle } from './_lib/handler';
import {
  applyEffectiveFilter,
  projectExists,
  projectScopeHeaders,
} from './_lib/effective-query';
import { applyBindingFilter } from './_lib/binding-filter';
import {
  channelsRegistryService,
  type Channel,
  type ChannelOriginKind,
} from '../../services/channels-registry';

const CHANNEL_ORIGINS: readonly ChannelOriginKind[] = ['tenant', 'workflow'];

function parseChannelOrigin(raw: string | null): ChannelOriginKind | undefined {
  if (raw === null) return undefined;
  if (!(CHANNEL_ORIGINS as readonly string[]).includes(raw)) {
    throw new BadRequestError(
      `origin must be one of ${CHANNEL_ORIGINS.join(', ')} (channels are never project-scoped)`,
    );
  }
  return raw as ChannelOriginKind;
}

interface ChannelRow {
  id: string;
  title: string;
  dept_id: string | null;
}

function shapeChannel(c: Channel): ChannelRow {
  return { id: c.id, title: c.name, dept_id: c.dept_id };
}

export async function handleListChannelsAsset(req: Request): Promise<Response> {
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
  const origin = parseChannelOrigin(url.searchParams.get('origin'));
  // `?? undefined` and not a `=== undefined` guard, deliberately: this mirrors
  // `triggers.ts` / `workflows.ts` byte-for-byte. `bound_to` is NOT the param
  // `projectScopeHeaders` discloses (that is `project_id`), and
  // `applyBindingFilter` treats a present-but-empty value as "no binding
  // filter" for all three routes alike. Diverging here would make channels the
  // one asset kind whose binding filter behaves differently.
  const bound_to = url.searchParams.get('bound_to') ?? undefined;
  const visible_in = url.searchParams.get('visible_in') ?? undefined;
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    async () => {
      const channels = await channelsRegistryService.listChannels(tenantId, {
        origin,
      });
      const rows = channels.map(shapeChannel);
      const effective = await applyEffectiveFilter(
        tenantId,
        'channel',
        rows,
        projectId,
        user.tenantName,
      );
      // Bindings LAST, same order as triggers.ts: the assignment walk decides
      // what this workspace owns, then the binding filter narrows that to what
      // the named project is actually wired to.
      return await applyBindingFilter('channel', effective, {
        bound_to,
        visible_in,
      });
    },
    (data) => jsonResponse({ data }, 200, projectScopeHeaders(projectResolved)),
  );
}
