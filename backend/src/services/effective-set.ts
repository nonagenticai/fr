// src/services/effective-set.ts
//
// Foundation Plan 2 — given (workspace, asset_type, project_id), returns the
// list of asset ids that are effectively in scope for that project. Walks
// workspace → department → project per Spec 1 §6.2:
//
//   * `owns` rows at any scope contribute their asset_id to the result.
//   * `block` rows at department or project scope hide an asset_id from
//     the result, regardless of where the `owns` lived.
//   * `override` rows at a lower scope replace the higher-scope `owns`
//     they reference (via `overrides_id`); the higher-scope row is
//     suppressed and the override row's own asset_id is exposed instead.
//
// The function returns `EffectiveEntry[]` rather than just `string[]` so
// callers (UI / RBAC / list routes) can show a "Workspace / Department /
// Project" source pill on each row and trace back to the assignment id.
//
// Performance: bounded by the assignment-row count for this
// (workspace, asset_type) pair plus one project-row lookup. Reads only.

import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, assetAssignments } from '../db/client';
import { BadRequestError } from '../utils/errors';
import { isUuidShape } from '../lib/uuid-shape';
import type { AssetType } from './asset-assignments';

export type EffectiveEntry = {
  asset_id: string;
  source: 'workspace' | 'department' | 'project';
  via_assignment_id: string;
};

type EffectiveDb = typeof defaultDb;

/**
 * What one `projects` row lookup tells us. TWO facts, not one — and collapsing
 * them is the defect this type exists to prevent.
 *
 * `deptId === null` is AMBIGUOUS on its own: it is what a project with no
 * department returns AND what a project that does not exist returns. The walk
 * below treats both the same way (empty dept bucket), which is correct for the
 * first and catastrophic for the second — see `projectExists` for why.
 */
export type ProjectResolution = {
  /** A `projects` row with this id exists. */
  exists: boolean;
  /** Its department, or null — meaningful ONLY when `exists` is true. */
  deptId: string | null;
};

/**
 * The single `projects` lookup, shared by `effectiveAssetIds` and
 * `projectExists`.
 *
 * ⛔ ONE implementation deliberately, not two callers each running their own
 * SELECT. The route reports resolution in a header while this file's walk
 * decides which rows to emit; if those answered from two different queries they
 * could disagree, and the response would then claim a scope it did not apply.
 * Same argument `utils/errors.ts clientSafePlankaMessage` makes for its shared
 * table: two copies of one mapping cannot disagree loudly.
 */
async function resolveProject(
  projectId: string,
  db: EffectiveDb,
): Promise<ProjectResolution> {
  // `projectId` is caller-supplied (the `?project_id=` query param on the
  // asset-list routes), so it MUST be bound, never interpolated — a raw
  // template here was a SQL-injection sink. drizzle's `sql` tag parameterises
  // `${projectId}` as a bind value. Using `sql` (rather than importing the
  // projects schema) keeps this file free of the routes/projects import cycle.
  const projRows = (await db.execute(
    sql`SELECT dept_id FROM projects WHERE id = ${projectId} LIMIT 1`,
  )) as unknown;
  // postgres.js returns an array directly; drizzle wraps as { rows } in
  // some adapters. Handle both so this works under bun:test + production.
  const proj =
    (projRows as { rows?: { dept_id: string | null }[] }).rows?.[0] ??
    (projRows as { dept_id: string | null }[])[0] ??
    null;
  // A row whose `dept_id` IS NULL is still a row: `exists` keys on the row's
  // presence, never on the truthiness of a column inside it.
  return { exists: proj !== null, deptId: proj?.dept_id ?? null };
}

/**
 * Does a project with this id exist?
 *
 * ⚠️ WHY THIS IS A SEPARATE, EXPORTED FUNCTION — the whole point of the fix.
 * `effectiveAssetIds` below cannot answer it: it returns `EffectiveEntry[]`, and
 * an unknown project is INDISTINGUISHABLE in that return value from a project
 * that resolves and simply has no narrowing rows. Both come back as "every
 * workspace-scope `owns` row", because a missing row yields `deptId = null`,
 * which empties the dept and project buckets while leaving the WORKSPACE bucket
 * untouched — and `routes/assets/_lib/effective-query.ts` lazily `owns`-seeds
 * every upstream row at workspace scope on first sight. So the filter returns
 * EVERYTHING, labelled as belonging to a project that does not exist.
 *
 * Measured on live data: ~30% of well-formed `project_id` values resolve to no
 * project (353 of 1176 requirements, 215 of 830 decisions). For requirements
 * this is the ONLY filter that runs at all — the upstream FastAPI silently
 * discards `project_id` because
 * `packages/service-clients/requirements/.../listRequirementsParams.ts` does not
 * declare it (its sibling `listDecisionsParams.ts` does). A filter that fails
 * open is worse than no filter: it makes a confident claim.
 *
 * A sibling rather than a widened `effectiveAssetIds` return type: its caller
 * `applyEffectiveFilter` has more route callers, all of which consume a plain
 * array. A sibling changes no existing signature.
 *
 * Shape-checks identically to `effectiveAssetIds` (same `BadRequestError`, same
 * message) so a caller that asks BOTH cannot get a 400 from one and a boolean
 * from the other.
 */
export async function projectExists(
  projectId: string,
  db: EffectiveDb = defaultDb,
): Promise<boolean> {
  if (!isUuidShape(projectId)) {
    throw new BadRequestError('project_id must be a UUID');
  }
  return (await resolveProject(projectId, db)).exists;
}

/**
 * Effective asset list for one project.
 *
 * Resolution order:
 *   1. Look up the project's dept_id (null when unscoped).
 *   2. Pull all assignment rows for (workspace_id, asset_type).
 *   3. Bucket rows by scope; project bucket only keeps rows whose
 *      target_id matches `opts.project_id`, dept bucket likewise for
 *      the project's dept.
 *   4. Compute two suppression sets:
 *        * blockedAssetIds — every asset_id blocked at dept or project
 *        * overriddenAssignmentIds — every workspace/dept assignment id
 *          that a lower-scope override row points at via overrides_id
 *   5. Walk W → D → P, emitting `owns` (and override) rows that aren't
 *      blocked / overridden. Department `block` rows are skipped silently
 *      (they exist purely to suppress higher-scope rows).
 */
export async function effectiveAssetIds(
  workspaceId: string,
  assetType: AssetType,
  opts: {
    project_id: string;
  },
  db: EffectiveDb = defaultDb,
): Promise<EffectiveEntry[]> {
  // Shape-check BEFORE the query. `projects.id` is a PostgreSQL `uuid` column;
  // a non-UUID does not return zero rows, it aborts with `22P02 invalid input
  // syntax for type uuid` and escaped as a bare 500. Measured in the live pod:
  // 5 of the 13 HTTP 500s in a 37-minute window landed here, all carrying an id
  // fr's OWN `/api/projects` MINTED AT THE TIME for a stream-backed
  // pseudo-project (`stream:<uuid>`), handed straight back on `?project_id=`.
  // ⚠️ Past tense deliberately: that mint was REMOVED on 2026-09-04 by an
  // explicit operator decision (`routes/projects.ts:1417,1553`) and
  // `handleListProjects` now emits the stream's own uuid. The measurement above
  // describes the window it was taken in; the shape-check below is still
  // required, because a non-UUID from ANY source still aborts with 22P02.
  //
  // 400, not 404, and the distinction is deliberate — this is a non-identity
  // QUERY PARAM, not an identity read. The route's 404 is reserved for "no such
  // asset / not your tenant", so keeping malformed-syntax out of it means a
  // well-formed id still reveals nothing about existence. A syntax rejection
  // leaks nothing: it is decided without touching the database. Same argument
  // as routes/reports/index.ts §handleProjectStatusReport.
  //
  // ⛔ THROW, never `return []`. The caller
  // (routes/assets/_lib/effective-query.ts) does
  // `visible = new Set(eff.map(...)); upstream.filter(...)`, so an empty array
  // would turn a loud 500 into a silent, confident "you own nothing" — a worse
  // defect.
  // `BadRequestError` (an `AppError`) is what `handleError` maps to 400, the
  // same envelope the report routes already answer a malformed id with;
  // `handle` (routes/assets/_lib/handler.ts) only converts IntegrationError and
  // rethrows everything else, so it reaches that boundary unchanged.
  //
  // `isUuidShape`, deliberately NOT `isValidUuid` (utils/tenant): that one also
  // pins the version nibble to 1-8 and the variant to [89ab], rejecting strings
  // Postgres accepts as legal `uuid` literals — it would 400 a project that
  // genuinely exists. Shape-only is exactly what the column requires.
  if (!isUuidShape(opts.project_id)) {
    throw new BadRequestError('project_id must be a UUID');
  }

  // Project lookup — see `resolveProject`, which owns the SQL and the bind.
  //
  // ⚠️ This function deliberately keeps its EXISTING behaviour when the project
  // does not exist: the dept and project buckets are empty and the workspace
  // bucket still emits. That is a fail-OPEN, and it is not fixed here because
  // this function's contract (`EffectiveEntry[]`) has no room to report it and
  // two callers outside this change consume that array. The fail-open is closed
  // one layer up, in `routes/assets/_lib/effective-query.ts`, which asks
  // `projectExists` FIRST and refuses to filter on an unresolved project.
  // ⛔ If you add a caller of this function, ask `projectExists` too.
  const { deptId } = await resolveProject(opts.project_id, db);

  // All candidate assignment rows for this workspace + asset_type. We
  // filter buckets in JS rather than running 3 separate queries — the
  // row count per (workspace, asset_type) is bounded and this lets us
  // build the suppression sets in one pass.
  const all = await db
    .select()
    .from(assetAssignments)
    .where(
      and(
        eq(assetAssignments.workspace_id, workspaceId),
        eq(assetAssignments.asset_type, assetType),
      ),
    );

  const ws = all.filter((r) => r.scope_kind === 'workspace');
  const dpt = all.filter(
    (r) => r.scope_kind === 'department' && r.target_id === deptId,
  );
  const prj = all.filter(
    (r) => r.scope_kind === 'project' && r.target_id === opts.project_id,
  );

  const blockedAssetIds = new Set<string>([
    ...dpt.filter((r) => r.link_kind === 'block').map((r) => r.asset_id),
    ...prj.filter((r) => r.link_kind === 'block').map((r) => r.asset_id),
  ]);

  const overriddenAssignmentIds = new Set<string>([
    ...dpt
      .filter((r) => r.link_kind === 'override' && r.overrides_id)
      .map((r) => r.overrides_id as string),
    ...prj
      .filter((r) => r.link_kind === 'override' && r.overrides_id)
      .map((r) => r.overrides_id as string),
  ]);

  const out: EffectiveEntry[] = [];

  for (const r of ws) {
    if (r.link_kind !== 'owns') continue;
    if (blockedAssetIds.has(r.asset_id)) continue;
    if (overriddenAssignmentIds.has(r.id)) continue;
    out.push({
      asset_id: r.asset_id,
      source: 'workspace',
      via_assignment_id: r.id,
    });
  }
  for (const r of dpt) {
    // dept-level block rows are suppression-only; never emit them.
    if (r.link_kind === 'block') continue;
    // a project-level block on this asset_id hides every higher-scope row
    if (blockedAssetIds.has(r.asset_id)) continue;
    // dept-level owns row that a project override points at — skip
    if (r.link_kind === 'owns' && overriddenAssignmentIds.has(r.id)) continue;
    out.push({
      asset_id: r.asset_id,
      source: 'department',
      via_assignment_id: r.id,
    });
  }
  for (const r of prj) {
    if (r.link_kind === 'block') continue;
    out.push({
      asset_id: r.asset_id,
      source: 'project',
      via_assignment_id: r.id,
    });
  }

  return out;
}
