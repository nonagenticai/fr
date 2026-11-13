// src/routes/assets/decisions.ts
//
// Human-facing library surface over requirements_management's decision routes.
// The AG-UI agent-tool twin lives in `agui/actions/decisions.ts`.
//
// Query params on the list route:
//   - project_id / bound_to / visible_in : binding filters
//   - rm_project_id : RM's own project_id filter, no fr effective filter
//   - origin : 'tenant' | 'project' | 'workflow' — the row's provenance.
//     Caller-facing name is `origin`, matching the `?origin=` the library
//     Origin filter already emits (frontend/src/routes/library/[type]) and the
//     sibling `/api/assets/channels` routes; it goes on the WIRE
//     as `origin_kind`, the column's real name, exactly as the AG-UI action does.

import { validateAuth } from '../../middleware/auth';
import { IntegrationError } from '../../integrations/_lib/errors';
import { BadRequestError } from '../../utils/errors';
import {
  createDecision,
  deleteDecision,
  getDecision,
  listDecisions,
  parseListDecisionsParams,
  updateDecision,
  getDecisionTarget,
} from '../../integrations/decisions';
import type { DecisionIn, DecisionOut } from '@fr/service-client-requirements';
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
  parseProjectIdParam,
  parseRmProjectIdParam,
  projectExists,
  projectScopeHeaders,
} from './_lib/effective-query';
import {
  frameProbe,
  pageCapHeaders,
  resolveListLimit,
} from './_lib/page-cap';

const DECISION_ORIGINS = ['tenant', 'project', 'workflow'] as const;
type DecisionOriginKind = (typeof DECISION_ORIGINS)[number];

/**
 * Parse the caller's `?origin=` into the upstream `origin_kind` value.
 *
 * Rejects rather than ignores an unknown value. requirements_management applies
 * `origin_kind` as an equality filter (`routers/decisions.py` ->
 * `EntityService.list_all`, which is a `getattr(model, key) == value` per
 * filter), so a typo would come back as a 200 carrying an EMPTY list —
 * indistinguishable from "this tenant authored no such rows". A 400 says which
 * of the two happened. The set matches the DB CHECK `ck_decisions_origin_kind`.
 */
function parseDecisionOrigin(
  raw: string | null,
): DecisionOriginKind | undefined {
  if (raw === null) return undefined;
  if (!(DECISION_ORIGINS as readonly string[]).includes(raw)) {
    throw new BadRequestError(
      `origin must be one of ${DECISION_ORIGINS.join(', ')}`,
    );
  }
  return raw as DecisionOriginKind;
}

export async function handleListDecisions(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  // `limit` is resolved by `resolveListLimit` below, so keep it out of the
  // upstream param schema. That schema is `z.coerce.number().int().min(1).max(1000)`
  // and THROWS on `?limit=abc`, `?limit=0` or `?limit=5000` — with no ZodError
  // handler in server.ts, a stale bookmark carrying a junk limit is a 500 on a
  // read-only list. One owner for the value, and it degrades instead of throwing.
  const upstreamQuery = new URLSearchParams(url.searchParams);
  upstreamQuery.delete('limit');
  const parsed = parseListDecisionsParams(upstreamQuery);
  // `parseListDecisionsParams` uses a `.strip()` zod object, so ANY key it does
  // not declare is dropped without a word — including `origin`. Merge after
  // parsing rather than widening that schema: the parser's job is to sanitise
  // the raw query string, and `origin` needs its own validation (and its own
  // rename) before it is fit to go on the wire.
  const origin = parseDecisionOrigin(url.searchParams.get('origin'));
  const originParams =
    origin === undefined
      ? parsed
      : { ...(parsed ?? {}), origin_kind: origin };
  // `?rm_project_id=` — RM's own `project_id` filter WITHOUT fr's effective-
  // scope filter (see `parseRmProjectIdParam`). The project artifacts page
  // reads "what this project produced" this way: fr's effective filter answers
  // a different question ("what applies to this project") and hides a row an
  // admin BLOCKED in this project's scope even when the project produced it.
  // The strict system-row drop for customers still applies.
  const rmProjectId = parseRmProjectIdParam(url.searchParams);
  const params =
    rmProjectId === undefined
      ? originParams
      : { ...(originParams ?? {}), project_id: rmProjectId };
  // ⚠️ NOT `get('project_id') ?? undefined` — that yielded `''` for a
  // present-but-empty `?project_id=`, which the filter's truthiness check read as
  // "no filter". `parseProjectIdParam` rejects the empty value with a 400 and
  // keeps absent meaning unfiltered. See its doc comment.
  const projectId = parseProjectIdParam(url.searchParams);
  // Did it resolve? `applyEffectiveFilter` no longer falls back to the whole
  // workspace for an unknown project, so an unknown id yields an empty list —
  // reported out of band so the client can tell it apart from a project that
  // genuinely holds no decisions. A HEADER, so the `{ data }` envelope is
  // untouched (see PROJECT_RESOLVED_HEADER).
  //
  // Unlike requirements, `listDecisionsParams` DOES declare `project_id`, so
  // upstream narrows too — but fr's leg failed open independently, and a decision
  // list flooded to the whole tenant the moment the id did not resolve.
  const projectResolved =
    projectId === undefined ? undefined : await projectExists(projectId);
  const bound_to = url.searchParams.get('bound_to') ?? undefined;
  const visible_in = url.searchParams.get('visible_in') ?? undefined;
  // Ask for an explicit page. Sending no limit let the upstream apply its own
  // default of 100, and fr rendered that page as the whole set — see page-cap.ts.
  const limit = resolveListLimit(url.searchParams);
  const probe = frameProbe();
  const paramsWithLimit = { ...(params ?? {}), limit };
  // BOUND MODE: `bound_to` without `visible_in` is served from asset_bindings,
  // id by id (bound-by-id.ts), so a bound decision beyond upstream row 200 is
  // still returned and `X-Truncated` describes the BOUND set. `visible_in`
  // (alone or with bound_to) keeps the upstream-page-then-filter path: its
  // "unbound everywhere" half has no id list to start from.
  const boundMode = !!bound_to && !visible_in;
  if (boundMode) {
    assertBoundToShape(bound_to!);
    assertNoOffsetInBoundMode(params?.offset);
  }
  let boundTruncated: boolean | undefined;
  return handle(
    () =>
      listWithSystemUnion(user, 'decision', projectId, async () => {
        if (boundMode) {
          // The upstream list filters that are column equality are re-applied
          // to the fetched rows. `card_id` filters nothing upstream either
          // (integrations/decisions.ts), so it is not applied here.
          const bound = await listBoundById<DecisionOut>(
            'decision',
            bound_to!,
            limit,
            (did) =>
              getWithSystemUnion(user, () => getDecision(did), getDecisionTarget(did)),
            fieldEquals({
              origin_kind: params?.origin_kind,
              status: params?.status,
              project_id: params?.project_id,
            }),
          );
          boundTruncated = bound.truncated;
          return bound.items;
        }
        const upstream = await listDecisions(paramsWithLimit);
        // Raw upstream length, BEFORE the binding filter below: a filtered
        // length cannot tell a capped page from a genuinely short one.
        probe.record(upstream.length);
        return applyBindingFilter('decision', upstream, {
          bound_to,
          visible_in,
        });
      }),
    (data) =>
      jsonResponse(
        { data },
        200,
        // Merged, never spread side by side: both helpers set
        // `Access-Control-Expose-Headers`, and a second key would clobber the
        // first.
        projectScopeHeaders(
          projectResolved,
          pageCapHeaders(limit, probe, boundTruncated),
        ),
      ),
  );
}

export async function handleCreateDecision(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as DecisionIn;
  return handle(
    async () => {
      // origin_project_id must name a project of the caller's tenant (governed-asset-write-gate).
      await assertOriginProjectAssignable(user, body);
      return createDecision(body);
    },
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetDecision(
  req: Request,
  did: string,
): Promise<Response> {
  const user = await validateAuth(req);
  return handle(
    () => getWithSystemUnion(user, () => getDecision(did), getDecisionTarget(did)),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateDecision(
  req: Request,
  did: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // fr-agui OQ-16 FOLLOW-UPS (George 2026-10-16): originals are workspace-admin
  // only; a member edits only a PROJECT-OWNED asset (that project's override
  // copy, or created in it) of a project they belong to. The ONE shared gate of
  // the four governed kinds' PUTs and DELETEs.
  // ONE upstream read shared by the gate and the origin carry-forward below.
  const loadRow = onceRow(() => getDecision(did));
  const arm = await assertGovernedAssetWritable(user, { kind: 'decision', assetId: did, loadRow });
  const rawBody = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as DecisionIn;
  // System-tenant fallback (mirrors handleGetDecision). A decision that lives
  // only under the system tenant is writable by a super-admin and 403
  // `system_asset_read_only` for everyone else (mutateWithSystemUnion).
  return handle(
    () =>
      // Provenance is carried forward / guarded (_lib/governed-asset-write-gate.ts
      // `withPreservedOrigin`): rm's PUT resets an omitted origin to 'tenant'.
      withPreservedOrigin(user, arm, rawBody, loadRow).then((body) =>
        mutateWithSystemUnion(
          user,
          () => getDecision(did),
          // G8 / R313: a PROJECT-OWNED row is written FOR its project (RM `scope_project_id`).
          () => scopeProjectOf(loadRow).then((scope) => updateDecision(did, body, scope)),
        ),
      ),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteDecision(
  req: Request,
  did: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // George 2026-10-16: DELETE gate = PUT gate (_lib/governed-asset-write-gate.ts).
  // Was any member.
  await assertGovernedAssetWritable(user, { kind: 'decision', assetId: did, loadRow: () => getDecision(did) });
  // System-tenant fallback (mirrors handleGetDecision). A decision that lives
  // only under the system tenant is deletable by a super-admin and 403
  // `system_asset_read_only` for everyone else (mutateWithSystemUnion).
  return handle(
    () =>
      mutateWithSystemUnion(
        user,
        () => getDecision(did),
        () => deleteDecision(did),
      ),
    () => noContentResponse(),
  );
}

// Pure relays (routes/assets/_lib/rm-passthrough.ts).
export const handleSearchDecisions = rmPassthrough('searchDecisions');
export const handleListDecisionVersions = rmPassthrough('listDecisionVersions');
