// src/lib/projects/repo-view.ts
//
// ONE reader for "which repositories is this project attached to?", shared by
// the three surfaces that ask it: the `/projects` cards,
// `/projects/[id]/settings`, and `/admin/assets/projects`.
//
// WHY THIS EXISTS. `projects.repository_url` / `.branch` are the DENORMALISED
// PRIMARY — a cache of whichever `project_repositories` row is flagged
// `is_primary` (migration 072). All three surfaces printed that one string and
// nothing else, so a project with three attached repositories rendered
// byte-identically to a project with one: no ellipsis, no count, no affordance.
// That makes it a false claim rather than an incomplete view (unit F2).
//
// The fix needs the SAME three-state reading in all three places, and it was
// first written three times over, because `$lib` was held by another author
// while the unit was in flight. Three copies of one predicate are free to
// drift, and the drift is invisible: each page goes on looking locally correct.
// Hence this module.
//
// ⛔ THREE STATES, AND THE THIRD IS THE ONE THAT BITES. `repositories` is a NEW
// field; a bundle can be served against a backend that does not send it.
//   listed   a usable array arrived      → render the rows, the primary marked
//   none     an EMPTY array arrived and nothing contradicts it → truly nothing
//            attached, and "No repositories attached" is a TRUE answer
//   unknown  no usable array arrived, or an empty one beside a positive
//            `repo_count` → THE SERVER DID NOT SAY. Show the denormalised
//            primary and claim nothing about the rest. Rendering "no
//            repositories" here is this codebase's standing defect class — an
//            absence rendered as a result (fr#1259) — one field down.
//
// ⭐ WHY SHARING IS CORRECT HERE, AND WHEN IT IS NOT. This codebase carries a
// scar from a shared normaliser: one function answered an importer's "may I
// skip this PUT?" AND a drift check's "do these two differ?" — two OPPOSITE
// questions — so a strip that was right for the first silently suppressed the
// second. That is NOT this case. All three callers ask the SAME question of the
// SAME payload shape and differ only in how they PRESENT the answer. Do not
// generalise in either direction from this file: the test for sharing is
// whether the callers share the QUESTION, not whether they share the data.

/** One `project_repositories` row, as far as a client can trust it. */
export interface ProjectRepoRow {
  repo_id: string;
  url: string;
  branch: string | null;
  name: string | null;
  is_primary: boolean;
}

/**
 * Why the repository set is unknown. Both are unknown to a reader — neither may
 * ever render as "none" — but they are not the same fact, and one surface can
 * honestly act on the difference:
 *
 *   `unreported`    no usable `repositories` array arrived at all. A
 *                   `repo_count` may still have been declared beside it
 *                   (`declaredCount`), which is a total WITHOUT the rows.
 *   `contradiction` the response disagrees with itself — an empty array beside
 *                   a positive `repo_count`, or an array whose every entry was
 *                   unreadable. Here even the declared number is not
 *                   trustworthy.
 */
export type RepoViewUnknownReason = 'unreported' | 'contradiction';

/** The three-state reading. See the file header before collapsing any two. */
export type RepoView =
  | {
      kind: 'listed';
      /**
       * Ordered primary-first. `is_primary` is the authority; the payload's
       * primary-first ORDERING is only a convention, and trusting it as if it
       * were the flag is how the old single-value render named the wrong
       * repository.
       */
      rows: ProjectRepoRow[];
      /**
       * The row that CLAIMS `is_primary`, or `null` when no row does. ⛔ Never a
       * guess: 0..N rows with EXACTLY ONE primary is the backend's invariant, so
       * no flag anywhere means the invariant is broken or the field was dropped,
       * and marking `rows[0]` anyway would invent the answer.
       */
      primary: ProjectRepoRow | null;
      /** `rows` after the first — i.e. everything a caller shows below the head row. */
      others: ProjectRepoRow[];
      /**
       * How many are attached. Never LESS than the rows we were handed: a stale
       * `repo_count` must not be allowed to hide a row.
       */
      total: number;
      /**
       * `true` when `total` outran `rows` — the response counts more than it
       * named. Surface it; a list that silently stops short reads as complete.
       */
      countOutrunsRows: boolean;
    }
  | { kind: 'none' }
  | {
      kind: 'unknown';
      reason: RepoViewUnknownReason;
      /** `repo_count` as sent, or `null` when it was absent or unusable. */
      declaredCount: number | null;
    };

/** `repo_count`, or `null` for absent / non-finite — never coerced to 0. */
function readDeclaredCount(project: unknown): number | null {
  const declared = (project as { repo_count?: unknown } | null | undefined)?.repo_count;
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : null;
}

/**
 * Entries we can actually address. An entry with neither `repo_id` nor `url` has
 * no identity, so it cannot be keyed in an `{#each}` or linked to — it is
 * dropped here and accounted for by `total` / `countOutrunsRows` instead of
 * being silently forgotten.
 */
function parseRows(raw: unknown[]): ProjectRepoRow[] {
  const rows: ProjectRepoRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : '';
    const id = typeof o.repo_id === 'string' && o.repo_id ? o.repo_id : url;
    if (!id) continue;
    rows.push({
      repo_id: id,
      url,
      branch: typeof o.branch === 'string' ? o.branch : null,
      name: typeof o.name === 'string' ? o.name : null,
      is_primary: o.is_primary === true,
    });
  }
  return rows;
}

/**
 * Read a project payload's repository set into the three-state view.
 *
 * Takes `unknown` on purpose: the callers hold a `Project`, an `AdminProject`
 * (`Record<string, unknown>`), or `null` while a read is in flight, and
 * `repositories` / `repo_count` are newer than the shared `Project` type. A
 * structural read here keeps this module independent of that type's owner.
 */
export function readProjectRepoView(project: unknown): RepoView {
  const raw = (project as { repositories?: unknown } | null | undefined)?.repositories;
  const counted = readDeclaredCount(project);

  // The key is absent, `null`, or not an array. A count may still have arrived.
  if (!Array.isArray(raw)) {
    return { kind: 'unknown', reason: 'unreported', declaredCount: counted };
  }

  const rows = parseRows(raw);

  if (rows.length === 0) {
    // An empty array beside a positive count is a CONTRADICTION, not a zero.
    if (counted !== null && counted > 0) {
      return { kind: 'unknown', reason: 'contradiction', declaredCount: counted };
    }
    // And so is an array that HAD entries, none of them readable: the server
    // sent rows and we failed to understand them. "None attached" there would
    // publish our parse failure as the server's answer.
    if (raw.length > 0) {
      return { kind: 'unknown', reason: 'contradiction', declaredCount: counted };
    }
    return { kind: 'none' };
  }

  // Stable sort, so the non-primary rows keep the order the payload sent them in.
  const ordered = [...rows].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const primary = ordered[0].is_primary ? ordered[0] : null;
  // `raw.length` counts the entries we could not parse too — dropping a row must
  // shrink what we NAME, never what we claim is attached.
  const total = Math.max(counted ?? 0, raw.length, ordered.length);

  return {
    kind: 'listed',
    rows: ordered,
    primary,
    others: ordered.slice(1),
    total,
    countOutrunsRows: total > ordered.length,
  };
}

/**
 * The label a repository row should DISPLAY: `owner/repo` derived from its URL.
 *
 * UI review 2026-10-07: shared `repositories` rows were historically NAMED after
 * whichever project first attached them, so a project's repo strip read as
 * another project's name. The URL is the identity; the stored name is only a
 * fallback when the URL is not a recognisable git remote, and the raw URL is the
 * last resort. Callers put the full URL in `title`.
 *
 * Handles `https://host/o/r`, `https://host/o/r.git`, trailing slashes,
 * `ssh://git@host/o/r.git` and scp-style `git@host:o/r.git`. Pure.
 */
export function repoLabelFromUrl(
  url: string | null | undefined,
  storedName?: string | null,
): string {
  const raw = (url ?? '').trim();
  const fromUrl = ownerRepoFromUrl(raw);
  if (fromUrl) return fromUrl;
  const name = (storedName ?? '').trim();
  if (name) return name;
  return raw;
}

function ownerRepoFromUrl(raw: string): string | null {
  if (!raw) return null;
  let path: string | null = null;
  // scp-like: git@github.com:owner/repo.git
  const scp = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(raw);
  if (scp) {
    path = scp[1];
  } else {
    try {
      const u = new URL(raw);
      if (!u.hostname) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const segs = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const owner = segs[segs.length - 2];
  const repo = segs[segs.length - 1];
  return `${owner}/${repo}`;
}
