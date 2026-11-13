// src/routes/assets/kag-documents.ts
//
// Library alias surface over the KAG document registry. The full surface
// `/api/assets/kag/documents` returns an `{ items, total }` shape; the Library
// page expects `data` to be the row array, so this handler reshapes to
// `{ data }`.
//
// ⚠️ NOT page-capped, and NOT forwarding `next_cursor` — deliberately, both
// measured. kag's `/api/documents` does accept `limit`/`offset`, but it reads
// the set from graph-adapter's `GET /nodes/`, which declares only `label`,
// `properties` and `envelope`. FastAPI drops undeclared query params, so the
// limit dies one hop down and the whole set comes back regardless: a live call
// returned 559 rows alongside `next_cursor: "100"`. That cursor is
// `str(offset + limit)` over an offset nothing honours, so a client following
// it re-requests the same 559 rows forever. Sending a limit that is ignored
// and then reporting `X-Truncated: false` would be a NEW false claim of
// completeness (see pm.ts `handleListPmDependencies`), and forwarding the
// cursor would hand clients a loop — so this route does neither.
//
// No `total` is emitted either. Upstream's is null on every call — kag never
// sends `envelope=true`, so graph-adapter returns a bare list with nothing to
// pass through — and no consumer reads the field. What must never appear here
// is a count taken from `data.length`: `applyEffectiveFilter` and
// `applyBindingFilter` both drop rows, so that number would describe this page
// after filtering while reading as the size of the set.
//
// Both this and `/api/assets/kag/documents` go through the same
// listKagDocuments + applyEffectiveFilter pipeline so the effective set
// stays consistent across surfaces.

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
  listKagDocuments,
  parseListKagDocumentsParams,
  type KagDocumentItem,
} from '../../integrations/kag';

interface KagDocumentRow {
  id: string;
  title: string;
}

function shapeKagDocument(d: KagDocumentItem): KagDocumentRow {
  return { id: d.id, title: d.title ?? d.id };
}

export async function handleListKagDocumentsAsset(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  // This route accepts no `limit` (see the header comment), so strip one out of
  // the query before parsing rather than passing it through. The upstream param
  // schema is `z.coerce.number().int().min(1).max(1000)` and THROWS on
  // `?limit=abc`, `?limit=0` or `?limit=5000`; server.ts has no ZodError
  // handler, so a stale bookmark carrying a junk limit would be a 500 on a
  // read-only list. Ignoring it is the correct outcome — refusing is not.
  const upstreamQuery = new URLSearchParams(url.searchParams);
  upstreamQuery.delete('limit');
  const params = parseListKagDocumentsParams(upstreamQuery);
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
      const upstream = await listKagDocuments(params);
      const rows = upstream.items.map(shapeKagDocument);
      const effective = await applyEffectiveFilter(
        ctxTenantId(user.tenantId),
        'kag_document',
        rows,
        projectId,
        user.tenantName,
      );
      const filtered = await applyBindingFilter('kag_document', effective, {
        bound_to,
        visible_in,
      });
      return filtered;
    },
    (data) => jsonResponse({ data }, 200, projectScopeHeaders(projectResolved)),
  );
}
