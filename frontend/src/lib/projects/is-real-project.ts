// src/lib/projects/is-real-project.ts
//
// One shared answer to "is this entry a real `projects` row, or a synthetic
// stream-backed board?".
//
// WHY THIS EXISTS. `GET /api/projects` returns two populations in one list: real
// projects, and (for a super-admin viewing a switched tenant) the tenant's
// continuous-improvement boards, which are `streams` rows shaped like projects.
// Only the first population can be PATCHed, deleted, or opened at
// `/projects/[id]` — the second 404s or worse.
//
// Three components each spelled the split differently, and one of them
// (ProjectSwitcher) discriminated on a `stream:` PREFIX in the id. That prefix
// was removed because it was not a uuid and produced SQLSTATE 22P02 → HTTP 500
// whenever a caller fed a listed id back into a uuid column. A prefix test
// against the new bare-uuid id matches NOTHING, so a prefix-based filter fails
// OPEN — it silently stops filtering. The discriminator is `kind`, which the
// backend has always emitted alongside the id, and it lives here once so a
// future id change cannot quietly re-open the same hole in three places.
//
// Structurally typed on purpose: callers pass either a `Project`
// (`kind?: 'continuous'`) or an `ActiveProjectSummary` (`kind?: string | null`).

export interface HasProjectKind {
  kind?: string | null;
}

/**
 * True for a real `projects` row — i.e. anything that is NOT a synthetic,
 * read-only continuous-improvement (stream-backed) entry.
 */
export function isRealProject(p: HasProjectKind): boolean {
  return p.kind !== 'continuous';
}
