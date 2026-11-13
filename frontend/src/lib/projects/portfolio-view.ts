// The tenant home project portfolio's pure view logic: the client-side search
// over the already-fetched list, and the order the owner can pick.
//
// Why client-side: `GET /api/projects` returns the whole list (no page/limit),
// so a search box is a filter, not a request. The route's own default still
// withholds archived rows; the controls only narrow what the caller already
// received.
//
// Everything here is unit-tested; no fetching, no Svelte.

import type { Project } from '$lib/types/api';
import { formatLocalDateTime } from './brief-diff';

export type PortfolioSort =
  | 'created_desc'
  | 'created_asc'
  | 'updated_desc'
  | 'updated_asc';

/** The order choices, in the order the select shows them. */
export const PORTFOLIO_SORT_OPTIONS: ReadonlyArray<{
  value: PortfolioSort;
  label: string;
}> = [
  { value: 'created_desc', label: 'Created — newest first' },
  { value: 'created_asc', label: 'Created — oldest first' },
  { value: 'updated_desc', label: 'Updated — newest first' },
  { value: 'updated_asc', label: 'Updated — oldest first' },
];

/** The portfolio's historical order, kept as the default. */
export const DEFAULT_PORTFOLIO_SORT: PortfolioSort = 'created_desc';

/** ms since epoch; an unparsable value reads as 0 rather than poisoning the sort. */
function timeOf(v: string | Date): number {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Case-insensitive match over the fields a person would search by: the name,
 * the description, the denormalised primary repository URL, and — only when the
 * response actually carried the repository set — each repo's name/url.
 *
 * ⚠️ `repositories` absent or `null` means "the server did not report them"
 * (three distinct answers — see the field's doc in `$lib/types/api`). It is
 * never read as "no repositories": we simply do not search it then.
 */
function matchesQuery(project: Project, query: string): boolean {
  if (
    [project.name, project.description, project.repository_url].some(
      (v) => typeof v === 'string' && v.toLowerCase().includes(query),
    )
  ) {
    return true;
  }
  if (Array.isArray(project.repositories)) {
    return project.repositories.some((r) =>
      `${r.name} ${r.url}`.toLowerCase().includes(query),
    );
  }
  return false;
}

/** Projects matching `query`; a blank query returns everything (unfiltered). */
export function filterProjects(
  projects: readonly Project[],
  query: string,
): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => matchesQuery(p, q));
}

/** A copy ordered by the chosen timestamp; equal values keep their input order. */
export function sortProjects(
  projects: readonly Project[],
  sort: PortfolioSort,
): Project[] {
  const key = sort.startsWith('created') ? 'created_at' : 'updated_at';
  const dir = sort.endsWith('desc') ? -1 : 1;
  return [...projects].sort((a, b) => (timeOf(a[key]) - timeOf(b[key])) * dir);
}

/**
 * The timestamp a card prints: local `YYYY-MM-DD HH:mm` (date AND time, which is
 * what the owner asked for on both columns). Delegates to the one formatter the
 * brief pages already use; `Project` types its timestamps `string | Date`.
 */
export function projectTimestamp(value: string | Date): string {
  return formatLocalDateTime(value);
}
