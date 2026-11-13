// src/services/asset-assignments.ts
//
// Foundation Plan 2 — `asset_assignments` is the single source of truth
// for "where does this asset live in the org tree?". Each row links one
// asset (typed by `asset_type`) to one scope target (workspace /
// department / project) with a relationship kind:
//
//   * owns      — the asset is part of this scope's effective set
//   * override  — replaces a higher-scope owns row (overrides_id is set)
//   * block     — hides a higher-scope owns row at this scope
//
// Per Spec 1 §6.2 the SQL side enforces:
//   * channels can only live at workspace / department scope (CHECK)
//   * link_kind='override' iff overrides_id IS NOT NULL (CHECK)
//   * uniqueness within (workspace_id, asset_type, asset_id, scope_kind,
//     target_id) — two partial unique indexes (one for target_id NOT NULL,
//     one for workspace-scope rows where target_id IS NULL).
//
// ⛔ `workspace_id` IS PART OF BOTH UNIQUE KEYS (migration 111) and must stay
// there. Until 111 it was absent, which made an assignment row unique GLOBALLY
// across tenants. That interacts lethally with the BARE `.onConflictDoNothing()`
// below: with no `target:`, drizzle emits a plain `ON CONFLICT DO NOTHING` that
// fires on ANY unique violation on the table, so a second tenant seeding the
// same upstream asset id had its row silently DISCARDED and got a successful
// statement back. Upstream ids are process-global (n8n workflow
// ids), so the first workspace to list an asset type claimed the entire
// catalogue for the estate. MEASURED on prod: 2,288 workspace-scope rows over
// 2,288 distinct asset_ids, none shared. Regression cover:
// tests/unit/services/asset-assignments-tenant-scope.test.ts.
//
// This service is the only writer; routes call into here. The
// `effective-set.ts` helper is the only "advanced" reader and lives in
// its own module so this file stays mechanical.

import { and, eq } from 'drizzle-orm';
import { db as defaultDb, assetAssignments } from '../db/client';

export type AssetType =
  | 'requirement'
  | 'principle'
  | 'decision'
  | 'kag_document'
  | 'workflow'
  | 'trigger'
  | 'artifact'
  | 'channel';

export type AssignmentScope = 'workspace' | 'department' | 'project';

export type LinkKind = 'owns' | 'override' | 'block';

/**
 * Discriminated union for any caller specifying a scope target. Workspace
 * scope has no target_id; the other two require one.
 */
export type AssignmentTarget =
  | { scope: 'workspace' }
  | { scope: 'department'; target_id: string }
  | { scope: 'project'; target_id: string };

type AssignmentsDb = typeof defaultDb;

/**
 * Insert an `owns` link for the asset at the given scope. Idempotent: if
 * an `owns` row already exists at the same (asset_type, asset_id, scope,
 * target_id) tuple, the partial unique index makes this a no-op.
 *
 * Channels at project scope are rejected by the SQL CHECK constraint.
 *
 * `assetId` is a `string` because `asset_assignments.asset_id` is `text`
 * (see migration 031). Callers with non-uuid upstream ids (e.g.
 * n8n workflow string ids) must
 * string-coerce their id (`String(x)`) before passing it here. The
 * `applyEffectiveFilter` route helper handles this on the list path.
 */
export async function upsertOwns(
  workspaceId: string,
  assetType: AssetType,
  assetId: string,
  opts: AssignmentTarget & { by: string },
  db: AssignmentsDb = defaultDb,
): Promise<void> {
  const target_id = opts.scope === 'workspace' ? null : opts.target_id;
  await db
    .insert(assetAssignments)
    .values({
      workspace_id: workspaceId,
      asset_type: assetType,
      asset_id: assetId,
      scope_kind: opts.scope,
      target_id,
      link_kind: 'owns',
      overrides_id: null,
      assigned_by: opts.by,
    })
    .onConflictDoNothing();
}

/**
 * Postgres caps a single extended-query statement at 65535 bind parameters
 * (`int16` on the wire). Each row here binds exactly 8 columns —
 * workspace_id, asset_type, asset_id, scope_kind, target_id, link_kind,
 * overrides_id, assigned_by (`id` and `effective_at` come from DB-side
 * defaults and are not bound), so the hard ceiling is 65535 / 8 = 8191 rows.
 *
 * 5000 is deliberately below that: it leaves room for up to 13 bound columns
 * before the ceiling is breached, so adding a column to `asset_assignments`
 * later cannot silently turn this into a runtime `bind message supplies N
 * parameters` error. At the observed catalogue sizes (~255 workflows) it is
 * one statement either way; the chunking only matters for pathological
 * upstream lists, and it CHUNKS rather than truncates — every id is written.
 */
export const UPSERT_OWNS_MANY_CHUNK_SIZE = 5000;

/**
 * Batch form of {@link upsertOwns}: one multi-row
 * `INSERT ... ON CONFLICT DO NOTHING` for the whole id list instead of one
 * statement per id.
 *
 * This exists because `applyEffectiveFilter` (the `?project_id=` seam on
 * every upstream-aggregated asset list route) used to `await upsertOwns`
 * once per upstream row — N sequential round-trips on a READ path. Measured
 * in production: `GET /api/assets/workflows?project_id=<uuid>` took a stable
 * ~11.3 s for a ~255-workflow catalogue (~44 ms per round-trip), against
 * 117 ms for the same route with no `project_id` (which short-circuits the
 * loop entirely).
 *
 * Semantics are identical to calling `upsertOwns` for each id in turn:
 *   * same `link_kind: 'owns'`, `overrides_id: null`, `assigned_by: opts.by`
 *   * same `target_id` derivation (`null` at workspace scope)
 *   * same `onConflictDoNothing()` — so re-running is a no-op and a
 *     concurrent writer cannot make this throw
 * `assetId`s must already be strings (`asset_assignments.asset_id` is `text`,
 * see migration 031); callers with numeric upstream ids coerce first.
 *
 * Duplicate ids inside one call are collapsed before the insert. Postgres
 * tolerates intra-statement duplicates under `DO NOTHING` (verified: three
 * values, two distinct → `INSERT 0 2`), so this is a bind-parameter saving,
 * not a correctness fix.
 *
 * An empty `assetIds` issues NO statement — drizzle's `.values([])` throws
 * ("values() must be called with at least one value"; verified against
 * drizzle-orm 0.45.x). The explicit early return is belt-and-braces: the
 * chunk loop below is already vacuous at length 0, so deleting the guard
 * alone does NOT resurrect the throw. What the empty-case tests actually
 * defend against is a non-chunked rewrite that calls `.values(assetIds.map
 * (...))` unconditionally — measured: that mutation reddens them.
 */
export async function upsertOwnsMany(
  workspaceId: string,
  assetType: AssetType,
  assetIds: string[],
  opts: AssignmentTarget & { by: string },
  db: AssignmentsDb = defaultDb,
): Promise<void> {
  if (assetIds.length === 0) return;
  const target_id = opts.scope === 'workspace' ? null : opts.target_id;
  const unique = [...new Set(assetIds)];

  for (let i = 0; i < unique.length; i += UPSERT_OWNS_MANY_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + UPSERT_OWNS_MANY_CHUNK_SIZE);
    await db
      .insert(assetAssignments)
      .values(
        chunk.map((assetId) => ({
          workspace_id: workspaceId,
          asset_type: assetType,
          asset_id: assetId,
          scope_kind: opts.scope,
          target_id,
          link_kind: 'owns' as const,
          overrides_id: null,
          assigned_by: opts.by,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Insert an `override` link: the new (assetId, scope, target) replaces an
 * existing `owns` row referenced by `overrides_id`. The CHECK constraint
 * `(link_kind='override') = (overrides_id IS NOT NULL)` rejects misuse.
 *
 * Override lives at department or project scope only — workspace overrides
 * have no parent to override.
 */
export async function addOverride(
  workspaceId: string,
  assetType: AssetType,
  assetId: string,
  opts: {
    scope: 'department' | 'project';
    target_id: string;
    overrides_id: string;
    by: string;
  },
  db: AssignmentsDb = defaultDb,
): Promise<void> {
  await db.insert(assetAssignments).values({
    workspace_id: workspaceId,
    asset_type: assetType,
    asset_id: assetId,
    scope_kind: opts.scope,
    target_id: opts.target_id,
    link_kind: 'override',
    overrides_id: opts.overrides_id,
    assigned_by: opts.by,
  });
}

/**
 * Insert a `block` link: hides a higher-scope `owns` for this assetId at
 * the given (scope, target). Unlike override, block does not replace —
 * the asset simply disappears from the effective set at this scope.
 */
export async function addBlock(
  workspaceId: string,
  assetType: AssetType,
  assetId: string,
  opts: { scope: 'department' | 'project'; target_id: string; by: string },
  db: AssignmentsDb = defaultDb,
): Promise<void> {
  await db.insert(assetAssignments).values({
    workspace_id: workspaceId,
    asset_type: assetType,
    asset_id: assetId,
    scope_kind: opts.scope,
    target_id: opts.target_id,
    link_kind: 'block',
    overrides_id: null,
    assigned_by: opts.by,
  });
}

/**
 * All assignment rows for one asset within ONE workspace, across every
 * scope. Used by the "where is this asset assigned?" panel and by
 * override/block bookkeeping.
 *
 * ⛔ `workspaceId` IS REQUIRED — not optional, not defaulted. Three facts
 * make it the only safe signature:
 *
 *  1. `asset_id` IS PROCESS-GLOBAL. It is `text` (migration 035) holding an
 *     UPSTREAM id — n8n workflow ids, kag document
 *     ids — minted by a system that knows nothing about fr's tenants. Two
 *     workspaces listing the same upstream catalogue legitimately hold rows
 *     with the SAME `asset_id`.
 *  2. MIGRATION 111 MADE THAT COLLISION REAL. Before it, `workspace_id` was
 *     absent from both partial unique indexes, so a given (asset_type,
 *     asset_id, scope_kind, target_id) tuple could exist only ONCE in the
 *     whole table and an unscoped read could not span tenants even in
 *     principle. 111 added `workspace_id` to both keys — correctly — and in
 *     doing so turned every unscoped read here into a cross-tenant leak.
 *  3. NOTHING IN THIS REPO WOULD CATCH THE REGRESSION.
 *     `scripts/check-tenant-field-misuse.ts` scans assignment right-hand
 *     sides for a user id or role written INTO a tenant column; it has no
 *     model of a MISSING `WHERE` predicate, so a comment here would be
 *     defended by nothing. Requiring the parameter is the mechanism: a
 *     future caller that does not have a tenant in hand FAILS TO COMPILE.
 *
 * `workspaceId` comes first to match `listAssignmentsByScope` /
 * `removeAssignment` and the writers above.
 *
 * Regression cover: tests/unit/services/asset-assignments-tenant-scope.test.ts
 * ("listAssignmentsForAsset returns ONLY the caller's tenant's rows").
 */
export async function listAssignmentsForAsset(
  workspaceId: string,
  assetType: AssetType,
  assetId: string,
  db: AssignmentsDb = defaultDb,
): Promise<(typeof assetAssignments.$inferSelect)[]> {
  return db
    .select()
    .from(assetAssignments)
    .where(
      and(
        eq(assetAssignments.workspace_id, workspaceId),
        eq(assetAssignments.asset_type, assetType),
        eq(assetAssignments.asset_id, assetId),
      ),
    );
}

/**
 * All assignment rows at one (workspace, asset_type, scope, target). Pass
 * `targetId = null` for workspace-scope rows (target_id IS NULL there).
 *
 * Used by routes that render "what assets does this department / project
 * own / override / block?".
 */
export async function listAssignmentsByScope(
  workspaceId: string,
  assetType: AssetType,
  scope: AssignmentScope,
  targetId: string | null,
  db: AssignmentsDb = defaultDb,
): Promise<(typeof assetAssignments.$inferSelect)[]> {
  const where =
    targetId === null
      ? and(
          eq(assetAssignments.workspace_id, workspaceId),
          eq(assetAssignments.asset_type, assetType),
          eq(assetAssignments.scope_kind, scope),
        )
      : and(
          eq(assetAssignments.workspace_id, workspaceId),
          eq(assetAssignments.asset_type, assetType),
          eq(assetAssignments.scope_kind, scope),
          eq(assetAssignments.target_id, targetId),
        );
  return db.select().from(assetAssignments).where(where);
}

/**
 * Hard-delete an assignment row by id, scoped to one workspace. A missing
 * id — or an id belonging to another workspace — is a no-op.
 *
 * The `workspace_id` predicate is mandatory: assignment ids are opaque
 * uuids that routes accept straight from the request path, so an unscoped
 * delete would let any tenant erase another tenant's assignment (IDOR).
 * `workspaceId` comes first to match `listAssignmentsByScope` and the other
 * writers here — both params are `string`, so a stale call site fails to
 * compile instead of silently swapping the arguments.
 */
export async function removeAssignment(
  workspaceId: string,
  id: string,
  db: AssignmentsDb = defaultDb,
): Promise<void> {
  await db
    .delete(assetAssignments)
    .where(
      and(
        eq(assetAssignments.workspace_id, workspaceId),
        eq(assetAssignments.id, id),
      ),
    );
}
