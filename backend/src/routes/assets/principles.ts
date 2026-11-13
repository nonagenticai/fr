// src/routes/assets/principles.ts
//
// Human-facing library surface over requirements_management's principle routes.
// The AG-UI agent-tool twin lives in `agui/actions/principles.ts`.
//
// Query params on the list route:
//   - bound_to / visible_in : fr-local binding filters
//   - origin : 'tenant' | 'project' | 'workflow' — the row's provenance.
//     Caller-facing name is `origin`, matching the `?origin=` the library
//     Origin filter already emits (frontend/src/routes/library/[type]) and the
//     sibling `/api/assets/channels` routes; it goes on the WIRE
//     as `origin_kind`, the column's real name, exactly as the AG-UI action does.
//
// ⛔ `project_id` is parsed here for the fr-local system-union/effective-scope
// pass ONLY, and must never be forwarded upstream or derived from `origin`.
// `Principle` has no `project_id` column — the only project-shaped column is
// `origin_project_id`, which is PROVENANCE ("which project's intake minted
// this") and not SCOPING ("which principles govern this project"). Mapping one
// onto the other would hide every tenant-wide principle behind a confident 200
// — and since rm#208 RM's `GET /principles?project_id=` IS that provenance
// filter, so forwarding the library's project scope would now silently narrow
// the project library to minted-only principles.
//
//   - rm_project_id : RM's provenance read, forwarded as RM's `project_id`
//     ("principles this project minted"). fr's effective-scope filter does not
//     apply to it (see `parseRmProjectIdParam`); a request naming both
//     `project_id` and `rm_project_id` is a 400.

import { validateAuth } from '../../middleware/auth';
import { IntegrationError } from '../../integrations/_lib/errors';
import { BadRequestError } from '../../utils/errors';
import {
  createPrinciple,
  deletePrinciple,
  getPrinciple,
  listPrinciples,
  parseListPrinciplesParams,
  updatePrinciple,
  getPrincipleTarget,
} from '../../integrations/principles';
import type { PrincipleIn, PrincipleOut } from '@fr/service-client-requirements';
import type { ListPrinciplesParams } from '../../integrations/principles';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import { rmPassthrough } from './_lib/rm-passthrough';
import { assertGovernedAssetWritable, assertOriginProjectAssignable, onceRow, scopeProjectOf, withPreservedOrigin } from './_lib/governed-asset-write-gate';
import {
  getWithSystemUnion,
  listWithSystemUnion,
  mutateWithSystemUnion,
} from './_lib/system-union';
import { applyBindingFilter } from './_lib/binding-filter';
import {
  assertBoundToShape,
  assertNoOffsetInBoundMode,
  fieldEquals,
  listBoundById,
} from './_lib/bound-by-id';
import {
  parseRmProjectIdParam,
  projectExists,
  projectScopeHeaders,
} from './_lib/effective-query';
import {
  frameProbe,
  pageCapHeaders,
  resolveListLimit,
} from './_lib/page-cap';

const PRINCIPLE_ORIGINS = ['tenant', 'project', 'workflow'] as const;
type PrincipleOriginKind = (typeof PRINCIPLE_ORIGINS)[number];

/**
 * Parse the caller's `?origin=` into the upstream `origin_kind` value.
 *
 * Rejects rather than ignores an unknown value. requirements_management applies
 * `origin_kind` as an equality filter (`routers/principles.py` ->
 * `EntityService.list_all`, which is a `getattr(model, key) == value` per
 * filter), so a typo would come back as a 200 carrying an EMPTY list —
 * indistinguishable from "this tenant authored no such rows". A 400 says which
 * of the two happened. The set matches the DB CHECK `ck_principles_origin_kind`.
 *
 * `origin=project` narrows on `origin_kind`, NOT on `origin_project_id` — it
 * answers "minted by some project's intake", never "governs project X".
 */
/**
 * The upstream list params: the sanitised query, plus `origin_kind` from
 * `?origin=`, plus RM's `project_id` ONLY from `?rm_project_id=`. fr's own
 * `?project_id=` never reaches RM (the parser schema does not carry it; this
 * drops it again in case a caller hands one in). Pure, so it is unit-tested.
 */
function principleUpstreamParams(
  parsed: ListPrinciplesParams | undefined,
  origin: PrincipleOriginKind | undefined,
  rmProjectId: string | undefined,
): ListPrinciplesParams | undefined {
  const { project_id: _frScope, ...rest } = parsed ?? {};
  const out: ListPrinciplesParams = {
    ...rest,
    ...(origin === undefined ? {} : { origin_kind: origin }),
    ...(rmProjectId === undefined ? {} : { project_id: rmProjectId }),
  };
  return parsed === undefined && Object.keys(out).length === 0 ? undefined : out;
}

function parsePrincipleOrigin(
  raw: string | null,
): PrincipleOriginKind | undefined {
  if (raw === null) return undefined;
  if (!(PRINCIPLE_ORIGINS as readonly string[]).includes(raw)) {
    throw new BadRequestError(
      `origin must be one of ${PRINCIPLE_ORIGINS.join(', ')}`,
    );
  }
  return raw as PrincipleOriginKind;
}

export async function handleListPrinciples(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  // `limit` is resolved by `resolveListLimit` below, so keep it out of the
  // upstream param schema. That schema is `z.coerce.number().int().min(1).max(1000)`
  // and THROWS on `?limit=abc`, `?limit=0` or `?limit=5000` — with no ZodError
  // handler in server.ts, a stale bookmark carrying a junk limit is a 500 on a
  // read-only list. One owner for the value, and it degrades instead of throwing.
  const upstreamQuery = new URLSearchParams(url.searchParams);
  upstreamQuery.delete('limit');
  const parsed = parseListPrinciplesParams(upstreamQuery);
  // `parseListPrinciplesParams` uses a `.strip()` zod object, so ANY key it does
  // not declare is dropped without a word — including `origin`. Merge after
  // parsing rather than widening that schema: the parser's job is to sanitise
  // the raw query string, and `origin` needs its own validation (and its own
  // rename) before it is fit to go on the wire.
  const origin = parsePrincipleOrigin(url.searchParams.get('origin'));
  const rmProjectId = parseRmProjectIdParam(url.searchParams);
  const params = principleUpstreamParams(parsed, origin, rmProjectId);
  const projectId = url.searchParams.get('project_id') ?? undefined;
  // ⛔ AN EMPTY SET MUST SAY WHY IT IS EMPTY. `applyEffectiveFilter` returns
  // `[]` for a well-formed-but-unknown project_id, and `effective-query.ts`
  // justifies that `[]` ONLY because the route reports the cause out of band:
  // "an empty set WITHOUT that header would be the defect that comment warns
  // about." `listWithSystemUnion` applies that filter, so it owes that header.
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
  // Ask for an explicit page. Sending no limit let the upstream apply its own
  // default of 100, and fr rendered that page as the whole set — see page-cap.ts.
  const limit = resolveListLimit(url.searchParams);
  const probe = frameProbe();
  const paramsWithLimit = { ...(params ?? {}), limit };
  // BOUND MODE — see the same block in decisions.ts. `visible_in` keeps the
  // upstream-page-then-filter path.
  const boundMode = !!bound_to && !visible_in;
  if (boundMode) {
    assertBoundToShape(bound_to!);
    assertNoOffsetInBoundMode(params?.offset);
  }
  let boundTruncated: boolean | undefined;
  return handle(
    () =>
      listWithSystemUnion(user, 'principle', projectId, async () => {
        if (boundMode) {
          // Re-apply the upstream list filters to the fetched rows:
          // `origin_kind` (column equality) and `active_only=true`
          // (`PrincipleOut.active`). `project_id` filters nothing upstream
          // (see the header) and stays with listWithSystemUnion's effective
          // filter, exactly as on the list path.
          const originEq = fieldEquals<PrincipleOut>({
            origin_kind: params?.origin_kind,
            origin_project_id: rmProjectId,
          });
          const activeOnly = params?.active_only === true;
          const bound = await listBoundById<PrincipleOut>(
            'principle',
            bound_to!,
            limit,
            (pid) =>
              getWithSystemUnion(user, () => getPrinciple(pid), getPrincipleTarget(pid)),
            (row) =>
              (originEq ? originEq(row) : true) &&
              (!activeOnly || (row as { active?: boolean }).active === true),
          );
          boundTruncated = bound.truncated;
          return bound.items;
        }
        const upstream = await listPrinciples(paramsWithLimit);
        // Raw upstream length, BEFORE the binding filter below: a filtered
        // length cannot tell a capped page from a genuinely short one.
        probe.record(upstream.length);
        return applyBindingFilter('principle', upstream, {
          bound_to,
          visible_in,
        });
      }),
    // MERGED, never spread side by side: both helpers set
    // `Access-Control-Expose-Headers` and a second key would clobber the first.
    (data) =>
      jsonResponse(
        { data },
        200,
        projectScopeHeaders(
          projectResolved,
          pageCapHeaders(limit, probe, boundTruncated),
        ),
      ),
  );
}

export async function handleCreatePrinciple(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as PrincipleIn;
  return handle(
    async () => {
      // origin_project_id must name a project of the caller's tenant (governed-asset-write-gate).
      await assertOriginProjectAssignable(user, body);
      return createPrinciple(body);
    },
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetPrinciple(
  req: Request,
  pid: string,
): Promise<Response> {
  const user = await validateAuth(req);
  return handle(
    () => getWithSystemUnion(user, () => getPrinciple(pid), getPrincipleTarget(pid)),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdatePrinciple(
  req: Request,
  pid: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // fr-agui OQ-16 FOLLOW-UPS (George 2026-10-16): originals are workspace-admin
  // only; a member edits only a PROJECT-OWNED asset (that project's override
  // copy, or created in it) of a project they belong to. The ONE shared gate of
  // the four governed kinds' PUTs and DELETEs.
  // ONE upstream read shared by the gate and the origin carry-forward below.
  const loadRow = onceRow(() => getPrinciple(pid));
  const arm = await assertGovernedAssetWritable(user, { kind: 'principle', assetId: pid, loadRow });
  const rawBody = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as PrincipleIn;
  // System-tenant fallback (mirrors handleGetPrinciple). A principle that lives
  // only under the system tenant is writable by a super-admin and 403
  // `system_asset_read_only` for everyone else (mutateWithSystemUnion).
  return handle(
    () =>
      // Provenance is carried forward / guarded (_lib/governed-asset-write-gate.ts
      // `withPreservedOrigin`): rm's PUT resets an omitted origin to 'tenant'.
      withPreservedOrigin(user, arm, rawBody, loadRow).then((body) =>
        mutateWithSystemUnion(
          user,
          () => getPrinciple(pid),
          // G8 / R313: a PROJECT-OWNED row is written FOR its project (RM `scope_project_id`).
          () => scopeProjectOf(loadRow).then((scope) => updatePrinciple(pid, body, scope)),
        ),
      ),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeletePrinciple(
  req: Request,
  pid: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // George 2026-10-16: DELETE gate = PUT gate (_lib/governed-asset-write-gate.ts).
  // Was any member.
  await assertGovernedAssetWritable(user, { kind: 'principle', assetId: pid, loadRow: () => getPrinciple(pid) });
  // System-tenant fallback (mirrors handleGetPrinciple). A principle that lives
  // only under the system tenant is deletable by a super-admin and 403
  // `system_asset_read_only` for everyone else (mutateWithSystemUnion).
  return handle(
    () =>
      mutateWithSystemUnion(
        user,
        () => getPrinciple(pid),
        () => deletePrinciple(pid),
      ),
    () => noContentResponse(),
  );
}

// Pure relays (routes/assets/_lib/rm-passthrough.ts).
export const handleSearchPrinciples = rmPassthrough('searchPrinciples');
export const handleListPrincipleVersions = rmPassthrough('listPrincipleVersions');
