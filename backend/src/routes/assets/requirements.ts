// src/routes/assets/requirements.ts
//
// Human-facing library surface over requirements_management's requirement
// routes. The AG-UI agent-tool twin lives in `agui/actions/requirements.ts`.
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
import { userRolesService } from '../../services/user-roles';
import {
  createRequirement,
  deleteRequirement,
  getRequirement,
  listRequirements,
  parseListRequirementsParams,
  updateRequirement,
  getRequirementTarget,
} from '../../integrations/requirements';
import type { RequirementIn, RequirementOut } from '@fr/service-client-requirements';
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

// ---------- RBAC bridge ----------------------------------------------------
//
// A requirement is a TENANT-WIDE governance row: every other member of the
// workspace reads it and downstream QA gates are formed against it. So the
// WRITES that can reap or rewrite one (PUT, DELETE) require a workspace-admin
// of the ACTIVE tenant — or, since George 2026-10-16, a member on a
// PROJECT-OWNED asset (_lib/governed-asset-write-gate.ts, the one gate of the
// four governed kinds' PUT and DELETE). Shape copied from `routes/channels.ts` (the canonical
// site); corroborated by `routes/admin/departments.ts::requireWorkspaceAdmin`
// and `routes/decompositions.ts::requireFamilyWriter`.
//
// ⛔ Never a claim-only check. `middleware/auth.ts::requireRole` was DELETED
// for testing only `user.roles.includes('admin')` — a test that matches no
// real grant, since authority lives in `user_roles`.
// `scripts/check-admin-claim-only.ts` fails CI if that shape returns.
//
// 403, not channels.ts's 401: the caller IS authenticated and merely lacks the
// role. `departments.ts` (AppError 403) and `decompositions.ts`
// (`ForbiddenError`) — the two newest sites of this same gate — both answer
// 403; channels.ts's 401 predates them.
//
// ⛔ READS STAY MEMBER-LEVEL. `handleListRequirements`, `handleGetRequirement`
// and `handleSearchRequirements` are deliberately ungated: the library UI and
// the project knowledge page fetch them with a plain member token.
//
// ⭐ `handleCreateRequirement` is deliberately NOT gated here: the conveyor
// does not use it either (workflow authoring goes through
// `routes/assets/internal-create.ts` under the `workflow-runner` role), but
// authoring a new row is not the reap-or-rewrite hazard this change closes,
// and gating creation is a separate product decision.
const REQUIREMENT_ORIGINS = ['tenant', 'project', 'workflow'] as const;
type RequirementOriginKind = (typeof REQUIREMENT_ORIGINS)[number];

/**
 * Parse the caller's `?origin=` into the upstream `origin_kind` value.
 *
 * Rejects rather than ignores an unknown value. requirements_management applies
 * `origin_kind` as an equality filter (`routers/requirements.py` ->
 * `EntityService.list_all`, which is a `getattr(model, key) == value` per
 * filter), so a typo would come back as a 200 carrying an EMPTY list —
 * indistinguishable from "this tenant authored no such rows". A 400 says which
 * of the two happened. The set matches the DB CHECK
 * `ck_requirements_origin_kind`.
 */
function parseRequirementOrigin(
  raw: string | null,
): RequirementOriginKind | undefined {
  if (raw === null) return undefined;
  if (!(REQUIREMENT_ORIGINS as readonly string[]).includes(raw)) {
    throw new BadRequestError(
      `origin must be one of ${REQUIREMENT_ORIGINS.join(', ')}`,
    );
  }
  return raw as RequirementOriginKind;
}

export async function handleListRequirements(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  // `limit` is resolved by `resolveListLimit` below, so keep it out of the
  // upstream param schema. That schema is `z.coerce.number().int().min(1).max(1000)`
  // and THROWS on `?limit=abc`, `?limit=0` or `?limit=5000` — with no ZodError
  // handler in server.ts, a stale bookmark carrying a junk limit is a 500 on a
  // read-only list. One owner for the value, and it degrades instead of throwing.
  const upstreamQuery = new URLSearchParams(url.searchParams);
  upstreamQuery.delete('limit');
  const parsed = parseListRequirementsParams(upstreamQuery);
  // Unlike the sibling routes, this parser DID declare `origin`, so the key
  // survived the `.strip()` — and then went upstream spelled `origin`, which
  // requirements_management does not declare (it declares `origin_kind`).
  // FastAPI discards an undeclared query param silently, so the caller got the
  // whole unfiltered tenant with a 200 either way. The rename happens here now,
  // and `origin` no longer exists on the params type at all.
  const origin = parseRequirementOrigin(url.searchParams.get('origin'));
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
  // Did it resolve? fr's `applyEffectiveFilter` now refuses to fall back to the
  // whole workspace for an unknown project, so the list is correctly empty — but
  // "empty because this project does not exist" and "empty because it holds no
  // requirements" must not look the same to the client. Reported as a HEADER so
  // the `{ data }` envelope is untouched (see PROJECT_RESOLVED_HEADER).
  //
  // ⚠️ THIS ROUTE NEEDS IT MOST. `listRequirementsParams` (generated service
  // client) declares only `limit` and `offset` — no `project_id` — and the
  // upstream FastAPI silently discards undeclared query params, so fr's filter is
  // the ONLY project filter that runs for requirements. `listDecisionsParams` DOES
  // declare it; that asymmetry is why the fail-open flooded rather than narrowed.
  // (Since the rm#208 snapshot RM declares `project_id` on GET /requirements
  // too, so upstream now narrows as well; fr's leg must still not fail open.)
  const projectResolved =
    projectId === undefined ? undefined : await projectExists(projectId);
  // bound_to / visible_in are fr-local filters against asset_bindings;
  // they aren't forwarded to upstream — we apply them after the upstream
  // call returns. project_id stays in params and is forwarded.
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
      listWithSystemUnion(user, 'requirement', projectId, async () => {
        if (boundMode) {
          // `origin_kind` is the only upstream list filter that narrows
          // (`project_id` is discarded upstream, see above; fr's effective
          // filter in listWithSystemUnion still applies it).
          const bound = await listBoundById<RequirementOut>(
            'requirement',
            bound_to!,
            limit,
            (rid) =>
              getWithSystemUnion(user, () => getRequirement(rid), getRequirementTarget(rid)),
            fieldEquals({ origin_kind: params?.origin_kind, project_id: rmProjectId }),
          );
          boundTruncated = bound.truncated;
          return bound.items;
        }
        const upstream = await listRequirements(paramsWithLimit);
        // Raw upstream length, BEFORE the binding filter below: a filtered
        // length cannot tell a capped page from a genuinely short one.
        probe.record(upstream.length);
        return applyBindingFilter('requirement', upstream, {
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

export async function handleCreateRequirement(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as RequirementIn;
  return handle(
    async () => {
      // origin_project_id must name a project of the caller's tenant (governed-asset-write-gate).
      await assertOriginProjectAssignable(user, body);
      return createRequirement(body);
    },
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetRequirement(
  req: Request,
  rid: string,
): Promise<Response> {
  const user = await validateAuth(req);
  return handle(
    () => getWithSystemUnion(user, () => getRequirement(rid), getRequirementTarget(rid)),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateRequirement(
  req: Request,
  rid: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // fr-agui OQ-16 FOLLOW-UPS (George 2026-10-16): a workspace-admin, or a member
  // editing a PROJECT-OWNED asset (that project's override copy, or created in
  // it) of a project they belong to. The ONE shared gate of the four governed
  // kinds' PUTs and DELETEs (_lib/governed-asset-write-gate.ts).
  // ONE upstream read shared by the gate and the origin carry-forward below.
  const loadRow = onceRow(() => getRequirement(rid));
  const arm = await assertGovernedAssetWritable(user, { kind: 'requirement', assetId: rid, loadRow, userRoles: userRolesService });
  const rawBody = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as RequirementIn;
  // System-tenant fallback (mirrors handleGetRequirement). A requirement that
  // lives only under the system tenant is writable by a super-admin and 403
  // `system_asset_read_only` for everyone else (mutateWithSystemUnion).
  return handle(
    () =>
      // Provenance is carried forward / guarded (_lib/governed-asset-write-gate.ts
      // `withPreservedOrigin`): rm's PUT resets an omitted origin to 'tenant'.
      withPreservedOrigin(user, arm, rawBody, loadRow).then((body) =>
        mutateWithSystemUnion(
          user,
          () => getRequirement(rid),
          // G8 / R313: a PROJECT-OWNED row is written FOR its project (RM `scope_project_id`).
          () => scopeProjectOf(loadRow).then((scope) => updateRequirement(rid, body, scope)),
        ),
      ),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteRequirement(
  req: Request,
  rid: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // George 2026-10-16: DELETE gate = PUT gate (_lib/governed-asset-write-gate.ts).
  await assertGovernedAssetWritable(user, { kind: 'requirement', assetId: rid, loadRow: () => getRequirement(rid), userRoles: userRolesService });
  // System-tenant fallback (mirrors handleGetRequirement). A requirement that
  // lives only under the system tenant is deletable by a super-admin and 403
  // `system_asset_read_only` for everyone else (mutateWithSystemUnion).
  return handle(
    () =>
      mutateWithSystemUnion(
        user,
        () => getRequirement(rid),
        () => deleteRequirement(rid),
      ),
    () => noContentResponse(),
  );
}

// Pure relays (routes/assets/_lib/rm-passthrough.ts).
export const handleSearchRequirements = rmPassthrough('searchRequirements');
