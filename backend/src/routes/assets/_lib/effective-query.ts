// src/routes/assets/_lib/effective-query.ts
//
// Foundation Plan 2 §Task 7 — `applyEffectiveFilter` is the single seam
// every list route uses to honour `?project_id=` scoping. For asset types
// whose canonical rows live in upstream services (requirements, principles,
// decisions, kag_documents, artifacts) fr does not know the id
// list at backfill time. Instead this helper writes a workspace-scope
// `owns` row on first sight, then lets `effectiveAssetIds` apply
// override + block resolution per Spec 1 §6.2.
//
// When `projectId` is undefined we short-circuit and return the upstream
// list unscoped: library list views without a project context show the
// workspace's full set, which is what the UI expects — minus system-owned rows
// for a customer caller (strict tenant separation applies on BOTH branches).
//
// ⛔ AN ABSENT project_id AND AN UNKNOWN ONE ARE NOT THE SAME QUESTION, and
// answering both with "the whole workspace" was this file's central defect. An
// absent param means "do not scope"; an unknown one means "scope to a project
// that does not exist", whose only honest answer is the empty set plus an
// explicit `X-Project-Resolved: false`. See `applyEffectiveFilter`.

import {
  effectiveAssetIds,
  projectExists,
} from '../../../services/effective-set';
import { upsertOwnsMany, type AssetType } from '../../../services/asset-assignments';
import { ensureWorkspace } from '../../../services/workspaces';
import { db as defaultDb } from '../../../db/client';
import { BadRequestError } from '../../../utils/errors';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../middleware/internal-tenant-only';
// Function-only use, so the system-union <-> effective-query import cycle is
// safe: neither module touches the other's bindings at evaluation time.
import { isPlatformTenant } from './system-union';

export type EffectiveFilterDb = typeof defaultDb;

/**
 * Response header naming whether `?project_id=` resolved to a real project.
 *
 * A HEADER, not a body field, for the reason `_lib/page-cap.ts` already states
 * and acts on: every one of these routes answers in the `data` envelope, and a
 * body field would change that shape for every client. So
 * `jsonResponse({ data }, 200, …)` keeps `GET /api/assets/requirements` and
 * `GET /api/assets/decisions` in shape `data`.
 */
export const PROJECT_RESOLVED_HEADER = 'X-Project-Resolved';

/**
 * Parse `?project_id=` into the three states the filter can actually honour.
 *
 * ⚠️ THE BUG THIS CLOSES: `url.searchParams.get('project_id') ?? undefined`
 * yields `''` for a present-but-empty `?project_id=`, because `get` returns the
 * empty string for a valueless param and only `null` for an absent one. That
 * `''` then met a `if (!projectId) return upstream` short-circuit and meant
 * UNFILTERED — while a bogus-but-well-formed UUID blanked or flooded the result.
 * Two invalid inputs, opposite behaviours, neither reported.
 *
 *   absent (`null`)  -> `undefined` -> unfiltered, unchanged behaviour
 *   present + empty  -> 400         -> the caller asked a question it cannot mean
 *   present + value  -> the value   -> shape-checked downstream
 *
 * `BadRequestError` because it is what the neighbouring code already throws for
 * a malformed query param on these very routes (`parseRequirementOrigin` /
 * `parseDecisionOrigin`, and `effective-set.ts` for a non-UUID `project_id`), and
 * `handleError` maps it to a 400 with the same envelope. Trimmed, so `?project_id=%20`
 * cannot slip through as a "value" that then 400s further down with a UUID message.
 */
export function parseProjectIdParam(sp: URLSearchParams): string | undefined {
  const raw = sp.get('project_id');
  if (raw === null) return undefined;
  if (raw.trim() === '') {
    throw new BadRequestError(
      'project_id must not be empty; omit the parameter to list without a project filter',
    );
  }
  return raw;
}

/**
 * `?rm_project_id=` — RM's OWN project filter, forwarded verbatim as RM's
 * `project_id`, with RM's meaning (requirements / decisions: the row's
 * `project_id` column; principles: `origin_project_id`, "minted by this
 * project" — provenance, not scoping). fr's effective-scope filter (the
 * `?project_id=` path: asset_assignments, lazy `owns` seed, dept/project
 * blocks) is NOT applied to such a read; the strict tenant drop of system rows
 * for a customer still is (`listWithSystemUnion`).
 *
 * The two parameters mean different things, so a request carrying both is a
 * 400 rather than a guess at which one the caller meant. An empty value is a
 * 400 for the same reason `parseProjectIdParam` refuses one. Anything else is
 * forwarded as-is: RM, not fr, judges its shape.
 */
export function parseRmProjectIdParam(sp: URLSearchParams): string | undefined {
  const raw = sp.get('rm_project_id');
  if (raw === null) return undefined;
  if (raw.trim() === '') {
    throw new BadRequestError('rm_project_id must not be empty; omit the parameter to list without it');
  }
  if (sp.has('project_id')) {
    throw new BadRequestError(
      "send project_id (fr's project scope) OR rm_project_id (requirements_management's own project filter), not both",
    );
  }
  return raw;
}

/**
 * Merge the project-resolution header into an existing header bag.
 *
 * `projectResolved === undefined` means no `?project_id=` was supplied, so the
 * headers are returned untouched — the route asserts nothing about a filter it
 * never applied.
 *
 * ⚠️ MERGES `Access-Control-Expose-Headers` rather than setting it. `jsonResponse`
 * spreads header objects into one literal, so a second `Access-Control-Expose-Headers`
 * key would CLOBBER the `X-Applied-Limit, X-Truncated` list `pageCapHeaders`
 * already publishes — silently un-exposing two working headers to every
 * cross-origin reader as a side effect of adding a third. Without the expose
 * entry the new header is on the wire and invisible to JS, which is the same
 * silence this change exists to remove.
 */
export function projectScopeHeaders(
  projectResolved: boolean | undefined,
  base: Record<string, string> = {},
): Record<string, string> {
  if (projectResolved === undefined) return base;
  const exposed = (base['Access-Control-Expose-Headers'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (!exposed.includes(PROJECT_RESOLVED_HEADER)) {
    exposed.push(PROJECT_RESOLVED_HEADER);
  }
  return {
    ...base,
    [PROJECT_RESOLVED_HEADER]: projectResolved ? 'true' : 'false',
    'Access-Control-Expose-Headers': exposed.join(', '),
  };
}

export { projectExists };

/** The row's own `tenant_id`, when the upstream reports one. */
function rowTenantId(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const t = (row as { tenant_id?: unknown }).tenant_id;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/**
 * May `workspaceId` record an `owns` row for this upstream row?
 *
 * ⛔ STRICT TENANT SEPARATION (owner ruling 2026-09-30). The lazy seed used to
 * write `owns` for EVERYTHING the upstream returned, so system-tenant rows an
 * upstream inherited into a customer frame (or that a regressed upstream leaked)
 * became permanent "<customer> owns <system decision>" assignments — measured
 * on netcare. Ownership is recorded ONLY for a row that is the caller's own:
 *   - a row carrying a customer `tenant_id` must carry the caller's tenant;
 *   - a system-tenant row is owned by a PLATFORM tenant (it inherits system
 *     rows by design) and never by a customer tenant;
 *   - a row with NO `tenant_id` (upstreams that do not report one, e.g. n8n
 *     workflows) keeps the old behaviour: the upstream already scoped the list
 *     to the caller's frame and there is nothing to compare against.
 */
/**
 * Is this upstream row SYSTEM-owned, by the row's own say-so?
 *
 * Two markers, because the upstreams do not agree on one:
 *   - `tenant_id === <system tenant>` — requirements, principles, decisions
 *     (and every row `listWithSystemUnion` tags);
 *   - `is_system === true` — artifact_service's `ArtifactOut` exposes ONLY this
 *     (no `tenant_id` on the wire, `src/models/schemas.py`), so a tenant_id-only
 *     test is structurally blind to an inherited system artifact.
 * A row carrying neither is not claimed to be system (n8n workflows, kag
 * documents, fr-local channels/triggers report no owner at all).
 */
function isSystemOwnedRow(row: unknown): boolean {
  if (rowTenantId(row) === INTERNAL_SYSTEM_TENANT_ID) return true;
  return (
    row !== null &&
    typeof row === 'object' &&
    (row as { is_system?: unknown }).is_system === true
  );
}

/**
 * ⛔ STRICT TENANT SEPARATION — the ONE rule both branches of
 * `applyEffectiveFilter` (and agent-search's unscoped path) apply: a
 * non-platform caller never receives a system-owned row, whatever the upstream
 * returned. A PLATFORM caller's list is returned untouched (same array), so
 * platform / super-admin-in-a-platform-frame behaviour cannot change.
 *
 * A missing/blank `workspaceId` is NOT platform — fail closed.
 */
export function dropSystemRowsForCustomer<T>(
  workspaceId: string | null | undefined,
  rows: T[],
): T[] {
  if (isPlatformTenant(workspaceId)) return rows;
  return rows.filter((r) => !isSystemOwnedRow(r));
}

function mayRecordOwnership(workspaceId: string, row: unknown): boolean {
  const t = rowTenantId(row);
  if (t === undefined) {
    // An `is_system` row with no tenant_id (artifacts) is system-owned too.
    return isSystemOwnedRow(row) ? isPlatformTenant(workspaceId) : true;
  }
  // A system-tenant row is owned by PLATFORM tenants (system, improvement,
  // execution, AA conveyor) — they inherit system decisions and must
  // keep seeing them in `?project_id=` lists — and by no customer.
  if (t === INTERNAL_SYSTEM_TENANT_ID) return isPlatformTenant(workspaceId);
  return t === workspaceId;
}

/**
 * Filter an upstream-aggregated asset list by project scope.
 *
 * - `projectId === undefined` → returns `upstream` unscoped, minus system-owned
 *   rows for a non-platform caller (`dropSystemRowsForCustomer`).
 * - `projectId` present but not a real project → returns `[]`. It does NOT fall
 *   back to the workspace set; the caller learns why from `X-Project-Resolved`.
 * - `projectId` provided      → lazily writes a workspace-scope `owns` row
 *   for any upstream id we haven't seen yet (idempotent via the partial
 *   unique index in `upsertOwnsMany`), computes the effective set, and
 *   filters the upstream array preserving order.
 *
 * The "lazy own" path is the contract that lets fr-backend honour Spec 1
 * §6.2 without a costly bulk backfill of every upstream id at workspace
 * creation time. The trade-off is ONE extra batched `INSERT ... ON CONFLICT
 * DO NOTHING` covering every upstream row on the first list-with-project
 * call; that cost amortises to zero on subsequent reads.
 *
 * The `T extends { id: string | number }` generic supports upstream
 * services with non-uuid ids. `asset_assignments.asset_id`
 * is `text` (see migration 031), so we string-coerce here on both the
 * write path (`upsertOwnsMany`) and the read path (`visible.has`).
 */
export async function applyEffectiveFilter<T extends { id: string | number }>(
  workspaceId: string,
  assetType: AssetType,
  upstream: T[],
  projectId: string | undefined,
  workspaceName: string | null | undefined = undefined,
  db: EffectiveFilterDb = defaultDb,
): Promise<T[]> {
  // ⛔ `=== undefined`, NOT `!projectId`. The truthiness short-circuit this
  // replaces made a present-but-empty `?project_id=` mean UNFILTERED — see
  // `parseProjectIdParam`, which now rejects that at the route boundary. Keeping
  // the check explicit here means a `''` reaching this seam from any OTHER caller
  // (artifacts, channels, kag, kag-documents, triggers, workflows all call this
  // directly) falls through to the UUID shape-check and gets a loud 400 instead
  // of silently widening to the whole workspace.
  //
  // ⛔ "UNCHANGED" MEANS UNSCOPED, NOT UNFILTERED. This branch used to be a bare
  // `return upstream`, so the strict-separation drop below applied ONLY when a
  // project was named: a customer listing without `?project_id=` received
  // whatever system rows its upstream returned. Measured 2026-10-02 against
  // origin/main of every direct caller's upstream, none serves one to a
  // customer today (channels/triggers: fr-local `tenant_id =` equality;
  // workflows: customers short-circuit to [] before this seam; artifacts:
  // upstream `may_inherit_system` platform gate; kag documents and
  // requirements/principles/decisions search: strict own-tenant). So this is
  // fr's SECOND layer — the same one `listWithSystemUnion` already applies —
  // and it is what holds if any of those upstreams regresses.
  if (projectId === undefined) {
    return dropSystemRowsForCustomer(workspaceId, upstream);
  }

  // ⛔ DOES THE PROJECT EXIST? Asked BEFORE anything narrows, because the
  // narrowing cannot answer it.
  //
  // `effectiveAssetIds` resolves the project's `dept_id` to decide which
  // department rows apply. A project that does not exist yields `dept_id = null`,
  // which empties the dept AND project buckets — but leaves the WORKSPACE bucket
  // alone, and the lazy seed below `owns`-writes EVERY upstream row at workspace
  // scope. Net effect of the old code: an unknown project_id returned the ENTIRE
  // tenant, presented as that project's assets. Measured on live data, ~30% of
  // well-formed project_id values resolve to no project, and for `requirements`
  // fr's filter is the ONLY one — the upstream FastAPI silently discards a
  // `project_id` it does not declare.
  //
  // THE HONEST BEHAVIOUR IS THE EMPTY SET, and it is a genuine trade-off:
  //   * Returning everything is a FALSE POSITIVE — it asserts membership of a
  //     project that does not exist. It is the one answer that is certainly
  //     wrong, and it is wrong in the direction that leaks the whole tenant.
  //   * Returning [] is honest about the scope actually applied: no project, no
  //     members. It CANNOT over-report.
  //   * Throwing was rejected: a well-formed-but-unknown uuid must not be
  //     answered 404, or the route becomes an existence oracle for projects in
  //     other tenants — the same reasoning `effective-set.ts` gives for choosing
  //     400 over 404 on a MALFORMED id.
  //
  // ⚠️ AND [] MUST NOT BE SILENT. `effective-set.ts` argues at length that an
  // empty array here would turn a loud failure into a confident "you own
  // nothing". That
  // objection is answered, not ignored: the route reports the cause out of band
  // as `X-Project-Resolved: false` (see `projectScopeHeaders`), so an empty list
  // caused by an unknown project is distinguishable by the client from a project
  // that genuinely holds no assets. An empty set WITHOUT that header would be
  // the defect that comment warns about.
  //
  // ⛔ THAT IS A CLAIM ABOUT THE ROUTES, NOT ABOUT THIS FILE, and it was FALSE
  // on most of them when it was first written: only requirements and decisions
  // emitted the header, so principles, procedures, channels, artifacts,
  // workflows, kag, kag-documents and triggers each answered a ghost project
  // with a silent `{"data":[]}`. The full set of handlers this paragraph
  // depends on is NINE — channels, artifacts, workflows, kag (documents),
  // kag-documents and triggers call `applyEffectiveFilter` directly;
  // requirements, decisions and principles reach it through
  // `_lib/system-union.ts`, which is why grepping for this function alone
  // under-counts by three. All nine now call `projectScopeHeaders`.
  //
  // ⛔ THE ELEVENTH CALLER ALREADY EXISTED WHEN THAT SENTENCE WAS WRITTEN, and
  // this comment used to end by warning about a future one: "⚠️ If you add an
  // eleventh caller, this justification goes stale silently — the empty set is
  // still returned, the header simply is not." It was not a prediction. It was a
  // description. `src/agui/actions/agent-search.ts` calls this filter for four
  // asset types and lives outside `src/routes/`, so both the grep that produced
  // the "TEN" above and the integration file that enumerates those ten were
  // structurally incapable of seeing it — and it answered an unresolvable
  // projectId with a silent `[]` on all four. It now discharges the same
  // obligation in its response BODY (`project_scope: {project_id, resolution}`),
  // which is the only form available to a surface that emits no headers.
  //
  // The warning is retired rather than re-aimed: `tests/unit/routes/assets/
  // project-scope-caller-census.test.ts` scans ALL of `backend/src/` for call
  // sites of this function and fails unless each one either emits
  // `projectScopeHeaders` or carries a written exemption whose stated alternative
  // disclosure is still present in that file. A twelfth caller cannot go stale
  // silently; it fails that census by name on the commit that adds it.
  //
  // Checked before `ensureWorkspace` / the lazy seed so a junk project_id
  // performs no writes at all.
  if (!(await projectExists(projectId, db))) return [];

  const seedIds = upstream
    .filter((item) => mayRecordOwnership(workspaceId, item))
    .map((item) => String(item.id));

  // `asset_assignments` has a FK to `workspaces.id`; provision the row first if it
  // doesn't exist (idempotent — see services/workspaces.ts:24-40). Caller
  // should pass the Keycloak `tenant_name` claim from `User.tenantName` so
  // the row gets a meaningful name on first sight; fall back to the id when
  // unknown (still queryable, just less legible in the admin UI).
  await ensureWorkspace(workspaceId, workspaceName?.trim() || workspaceId, db);

  // Lazy seed. Idempotent due to ON CONFLICT DO NOTHING in upsertOwnsMany.
  // String-coerce so numeric upstream ids are stored
  // consistently in the text column.
  //
  // ONE round-trip for the whole list, not one per row. This was a
  // `for (const item of upstream) await upsertOwns(...)` — N sequential
  // INSERTs on a READ path. Measured in production:
  // `GET /api/assets/workflows?project_id=<uuid>` took a stable ~11.3 s for
  // a ~255-workflow catalogue (~44 ms per round-trip) against 117 ms for the
  // same route without `project_id`, which returns above before reaching
  // here. `upsertOwnsMany` no-ops on an empty list (drizzle's `.values([])`
  // throws) and chunks at 5000 rows to stay under Postgres's 65535
  // bind-parameter cap. Do NOT reintroduce the loop.
  //
  // Only the caller's OWN rows are seeded — see `mayRecordOwnership`.
  await upsertOwnsMany(
    workspaceId,
    assetType,
    seedIds,
    { scope: 'workspace', by: 'system-lazy' },
    db,
  );

  const eff = await effectiveAssetIds(
    workspaceId,
    assetType,
    { project_id: projectId },
    db,
  );
  const visible = new Set(eff.map((e) => e.asset_id));
  // A customer never sees a system-tenant row, even one a pre-fix lazy seed
  // already recorded as "owned" by this tenant.
  return dropSystemRowsForCustomer(workspaceId, upstream).filter((item) =>
    visible.has(String(item.id)),
  );
}
