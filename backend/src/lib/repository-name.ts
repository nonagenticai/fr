// src/lib/repository-name.ts
//
// ONE resolver for `repositories.name`. Every insert into `repositories` routes through
// `resolveRepositoryName()` so a blank name cannot be constructed by ANY caller:
// four insert paths existed (routes/repositories.ts, routes/projects.ts ×2,
// routes/project-repositories.ts) and three of them wrote `?? null`.
//
// ⚠️ WHAT THIS COLUMN ACTUALLY HOLDS — MEASURED, and it is NOT the repo's name.
// The operator's premise for this work was "repository name can ALWAYS be resolved
// from the repo url". True of a REPOSITORY's name; this column is not that. Measured
// on prod 2026-09-25: all **43 of 43** rows have a name containing NO `/`, and they
// are work-item titles, e.g.
//   `fr: retire the dead seed-it-procedures script`  <=  github.com/nonagenticai/fr
//   `IT Flow1 — bump structlog to 26.1.0`            <=  github.com/nonagenticai/coding-github
// ⇒ The derivation below is a FALLBACK that makes a blank name impossible, never a
// canonical value. ⛔ Do NOT "fix" `resolveRepositoryName` to prefer the derived
// `owner/repo` over a caller-supplied name: that would overwrite the only meaningful
// label these rows carry with a restatement of the url. A caller-supplied name wins,
// always. A derived name is visually unlike all 43 existing rows by design — that
// difference is the signal that nobody supplied one.
//
// ⭐ WHY A DERIVATION AND NOT A REQUIRED WIRE FIELD. Requiring `name` on the wire
// would 422 callers that legitimately omit a value the server can compute, and
// it would have to be required in FOUR schemas plus the frontend mirror
// (`frontend/src/lib/types/api.ts`) — the two-emitter divergence this repo keeps
// hitting. A derivation is required in exactly one place. The HARD guarantee is
// the DB: migration 133 makes the column `NOT NULL` + `CHECK (btrim(name) <> '')`,
// so even a path that forgets this helper fails loudly instead of storing blank.
//
// ⚠️ HOST-AGNOSTIC ON PURPOSE. `services/repo-access.ts :: parseGithubRepo` is
// the right parser for the GitHub API hop — it validates GitHub's own owner/repo
// grammar and returns null for every non-github host, which is correct THERE and
// wrong HERE: rejecting a gitlab / bitbucket / self-hosted URL would refuse a
// repository fr can legitimately store. This function answers a different
// question ("what is this repo called?"), so it is deliberately a second,
// looser reader of the same string rather than a call into that one.

import { BadRequestError } from '../utils/errors';

/** Segments that are never a legal owner or repo name. */
const ILLEGAL_SEGMENTS = new Set(['.', '..']);

/** Matches `repositories.name`'s column budget and the zod `.max(255)`. */
const MAX_NAME_LENGTH = 255;

/**
 * Derive the `owner/repo` name from a repository URL.
 *
 * Accepts, at minimum:
 *   · `https://github.com/owner/repo`
 *   · `https://github.com/owner/repo.git`
 *   · `https://github.com/owner/repo/`      (and deeper: `/tree/main`, …)
 *   · `git@github.com:owner/repo.git`
 * plus the same shapes on any other host, and a schemeless
 * `github.com/owner/repo`.
 *
 * Returns `null` when the string carries no owner/repo pair — the caller turns
 * that into a 4xx. It NEVER invents a placeholder: a made-up name is worse than
 * a refusal, because it looks like data.
 */
export function deriveRepositoryNameFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  let path: string;
  // scp-style `git@host:owner/repo.git` is not a URL — `new URL()` parses it as
  // the `git@host:` scheme with an opaque body, so it has to be split by hand.
  const scp = /^[^\s/@]+@[^\s/:]+:(.+)$/.exec(raw);
  if (scp) {
    path = scp[1] ?? '';
  } else {
    const parsed = parseUrlLoosely(raw);
    if (!parsed) return null;
    path = parsed.pathname;
  }

  const segments = path.split('/').filter((s) => s.length > 0);
  // The name is the FIRST two path segments, not the last two: for
  // `…/owner/repo/tree/main` the owner/repo pair is at the front.
  const owner = segments[0];
  let repo = segments[1];
  if (!owner || !repo) return null;
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!repo) return null;
  if (ILLEGAL_SEGMENTS.has(owner) || ILLEGAL_SEGMENTS.has(repo)) return null;

  const name = `${owner}/${repo}`;
  return name.length <= MAX_NAME_LENGTH ? name : null;
}

/**
 * `new URL()`, retried with an `https://` prefix so a schemeless
 * `github.com/owner/repo` still resolves. Returns null for anything that is not
 * a URL either way.
 */
function parseUrlLoosely(raw: string): URL | null {
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      return new URL(candidate);
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * The value that goes into `repositories.name`. Never null, never blank.
 *
 *   1. a caller-supplied name wins, trimmed;
 *   2. otherwise the `owner/repo` derived from the URL;
 *   3. otherwise a 400 naming the field — NOT a null, and NOT a placeholder.
 *
 * `field` lets a caller point the error at the body key it actually read
 * (`repo.additional[0].name` and `name` are different fields to a form).
 */
export function resolveRepositoryName(
  providedName: string | null | undefined,
  url: string | null | undefined,
  field = 'name',
): string {
  const provided = typeof providedName === 'string' ? providedName.trim() : '';
  if (provided) return provided.slice(0, MAX_NAME_LENGTH);

  const derived = deriveRepositoryNameFromUrl(url);
  if (derived) return derived;

  throw new BadRequestError(
    `${field} is required: no owner/repo could be derived from the repository url`,
    { field, url: typeof url === 'string' ? url : null },
  ).withCode('repository_name_underivable');
}
