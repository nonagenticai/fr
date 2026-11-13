// src/services/project-repositories.ts
//
// THE service-layer loader for a project's repositories — all N of them.
//
// Why this module exists (the measured defect it closes): before it, nothing
// under `src/services/` touched the `project_repositories` join table at all.
// Every service-layer consumer read the denormalised scalar
// `projects.repository_url` and was therefore structurally blind to repos
// 2..N. The only correct multi-repo query in the codebase lived inside a route
// (`routes/project-repositories.ts :: listProjectRepoRows`). This module lifts
// that query into the service layer so the several consumers that need the
// full set share ONE definition instead of each re-inventing a collapse to a
// single row.
//
// Ordering is `is_primary DESC, position ASC, added_at ASC` — primary first,
// then the caller-controlled `position` (migration 143), with `added_at` as the
// stable tiebreaker so two rows sharing a position never swap between reads.
//
// ⛔ INVARIANT — DO NOT ADD A SINGLE-ROW PATH TO THIS MODULE.
//    No `.limit(1)`. No `[0]`-only return. No `{ primaryOnly: true }` option,
//    and no `loadPrimaryRepository()` helper that queries on its own. The
//    whole point is that a caller CANNOT accidentally obtain one repository
//    and believe it has the project's repositories. `primary` below is derived
//    from the already-loaded full set, never fetched separately.
//    Re-adding a `.limit(1)` here is the mutation that must turn every
//    consumer's test red at once — if you make that edit and the suite stays
//    green, the consumers' tests are the thing that is broken.

import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, projectRepositories, repositories } from '../db/client';

export type ProjectRepositoriesDb = typeof defaultDb;

/**
 * One repository attached to a project — the shared row shape.
 *
 * Exported so every consumer (routes/projects, the project-request lifecycle
 * + repo gate, the project cockpit) types against this instead of
 * redeclaring its own near-copy.
 *
 * Column provenance: `repo_id/url/branch/name/path` come from `repositories`,
 * `is_primary/position` from the `project_repositories` join row. `name` is
 * NOT NULL + non-blank since migration 133, hence `string` not `string | null`.
 */
export interface ProjectRepositoryRow {
  repo_id: string;
  url: string;
  branch: string | null;
  name: string;
  path: string | null;
  is_primary: boolean;
  position: number;
}

/**
 * The full attachment set for one project, plus the derived values callers
 * asked for. `repositories` is the authoritative list; `count` and `primary`
 * are computed from it, so they can never disagree with it.
 */
export interface ProjectRepositorySet {
  /** Every attached repository, primary first. Empty when none are attached. */
  repositories: ProjectRepositoryRow[];
  /** `repositories.length` — the repo count callers branch on (0 / 1 / N). */
  count: number;
  /**
   * The `is_primary` row, or null. A project can legitimately have rows but
   * no primary: the partial unique index enforces AT MOST one, not exactly
   * one. Derived from the loaded set — never a separate query.
   */
  primary: ProjectRepositoryRow | null;
}

/**
 * Load ALL repositories attached to `projectId`, primary first.
 *
 * ⚠️ This function performs NO access control. It is a data loader. Callers
 * are responsible for having already passed the project through
 * `lib/project-access.ts` (`loadTenantScopedProject` for write lanes,
 * `loadProjectForRead` for read lanes) — same division of labour as the
 * route-level list handler this was extracted from.
 *
 * Returns an empty set (`count: 0`, `primary: null`) for a project with no
 * attachments and for a project id that does not exist; distinguishing those
 * two is the caller's project gate, not this query's job.
 *
 * `db` is the last parameter and defaults to the shared handle, so a
 * transaction handle (`tx`) can be threaded through — matching
 * `services/workspaces.ts`, `services/departments.ts` and
 * `services/user-tenant.ts`.
 */
export async function loadProjectRepositories(
  projectId: string,
  db: ProjectRepositoriesDb = defaultDb,
): Promise<ProjectRepositorySet> {
  const rows: ProjectRepositoryRow[] = await db
    .select({
      repo_id: repositories.id,
      url: repositories.url,
      branch: repositories.branch,
      name: repositories.name,
      path: repositories.path,
      is_primary: projectRepositories.is_primary,
      position: projectRepositories.position,
    })
    .from(projectRepositories)
    .innerJoin(repositories, eq(projectRepositories.repo_id, repositories.id))
    .where(eq(projectRepositories.project_id, projectId))
    // ⛔ No `.limit(...)` on this chain. See the invariant at the top of the file.
    .orderBy(
      desc(projectRepositories.is_primary),
      asc(projectRepositories.position),
      asc(projectRepositories.added_at),
    );

  return {
    repositories: rows,
    count: rows.length,
    // `.find` rather than `rows[0]`: the ORDER BY puts the primary first IF
    // one exists, and reading index 0 unconditionally would silently promote
    // a non-primary row for a project that has no primary.
    primary: rows.find((r) => r.is_primary) ?? null,
  };
}

/**
 * Convenience accessor for the primary row of an ALREADY-LOADED set.
 *
 * Takes the set, not a project id, precisely so that obtaining the primary
 * always requires having loaded every repository first. There is deliberately
 * no `getPrimaryProjectRepository(projectId)` — that signature is the defect
 * this module exists to remove.
 */
export function primaryRepository(set: ProjectRepositorySet): ProjectRepositoryRow | null {
  return set.primary;
}

/** Repo count for an already-loaded set. `> 1` is the multi-repo case. */
export function repositoryCount(set: ProjectRepositorySet): number {
  return set.count;
}

/**
 * `loadProjectRepositories` for MANY projects in one query — the Projects list.
 * Same rows, same order per project. A project with no attached repository maps
 * to an EMPTY set (a real zero), so the list can always report `repo_count`.
 * (UI review 2026-10-07: the list sent no repositories, so every card said "how
 * many others are attached was not reported".)
 */
export async function loadRepositoriesForProjects(
  projectIds: string[],
  db: ProjectRepositoriesDb = defaultDb,
): Promise<Map<string, ProjectRepositorySet>> {
  const out = new Map<string, ProjectRepositorySet>();
  for (const id of projectIds) out.set(id, { repositories: [], count: 0, primary: null });
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      project_id: projectRepositories.project_id,
      repo_id: repositories.id,
      url: repositories.url,
      branch: repositories.branch,
      name: repositories.name,
      path: repositories.path,
      is_primary: projectRepositories.is_primary,
      position: projectRepositories.position,
    })
    .from(projectRepositories)
    .innerJoin(repositories, eq(projectRepositories.repo_id, repositories.id))
    .where(inArray(projectRepositories.project_id, projectIds))
    .orderBy(
      desc(projectRepositories.is_primary),
      asc(projectRepositories.position),
      asc(projectRepositories.added_at),
    );
  const grouped = new Map<string, ProjectRepositoryRow[]>();
  for (const { project_id, ...row } of rows) {
    const list = grouped.get(project_id) ?? [];
    list.push(row);
    grouped.set(project_id, list);
  }
  for (const [id, list] of grouped) {
    out.set(id, {
      repositories: list,
      count: list.length,
      primary: list.find((r) => r.is_primary) ?? null,
    });
  }
  return out;
}
