// services/repository-pins.ts
//
// A repository PIN is the exact version of a repository a project takes as input
// (George 2026-11-07: "for the source repo the pr or commit sha should be able to be
// pinned … to make sure that the exact version of a repo is taken as input").
//
//   * a full 40-hex commit SHA  → used as-is (lowercased);
//   * a GitHub PR (`123`, `#123`, a PR URL) → RESOLVED here, at create, to the PR's
//     `head.sha`. RM's `ProjectRepository.sha` stays a 40-hex commit, so every
//     existing consumer (the four rewrite flows read `repositories[].sha`) is
//     unchanged, and the project is pinned to a commit — not to a moving branch.
//
// Two shapes of pin are refused before any network call:
//   * a row carrying BOTH `pin` and `sha` (422 repository_pin_conflict) — two
//     answers to one question;
//   * a pin that is neither a 40-hex sha nor a PR reference — the zod schema in
//     types/api.ts already refuses it (422), this is the same predicate.
//
// The GitHub read reuses coding-github's `pr-read` clone-token mint (the same
// instrument `routes/project-constraint-check.ts` uses): a clone-scoped token is 403
// on the pulls API, and coding-github resolves visibility even when it refuses to
// mint, so a PUBLIC repo is still readable anonymously. The token is discarded.
//
// ⛔ No test double: the decisions that need no network (`parseRepoPin`, the
// sha/pin conflict, a malformed pin) are unit tested; the GitHub round-trip is
// verified live, per the owner ruling of 2026-10-29.

import {
  PIN_PR_NUMBER_RE,
  PIN_PR_URL_RE,
  PIN_SHA_RE,
} from '../types/api';
import { AppError } from '../utils/errors';
import {
  CodingGithubError,
  CodingGithubNotConfiguredError,
  requestCloneToken,
  type CloneTokenResult,
} from '../integrations/coding-github/client';
import { parseGithubRepo } from './repo-access';

const GITHUB_API_BASE = 'https://api.github.com';
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

/** A parsed pin: the commit itself, or a PR to resolve against a repository. */
export type RepoPin =
  | { kind: 'sha'; sha: string }
  | { kind: 'pr'; number: number; owner: string | null; repo: string | null };

/**
 * The pin's meaning, from the string alone. `null` = not a pin shape. A PR URL
 * carries its own owner/repo; a bare `123`/`#123` is resolved against the row's
 * repository URL (so those two fields are null here).
 */
export function parseRepoPin(pin: string): RepoPin | null {
  const value = pin.trim();
  if (PIN_SHA_RE.test(value)) return { kind: 'sha', sha: value.toLowerCase() };
  if (PIN_PR_NUMBER_RE.test(value)) {
    return { kind: 'pr', number: Number(value.replace(/^#/, '')), owner: null, repo: null };
  }
  const url = PIN_PR_URL_RE.exec(value);
  if (url) {
    const repo = parseGithubRepo(value);
    const number = /\/pull\/(\d{1,10})\/?$/i.exec(value)?.[1];
    if (repo && number) return { kind: 'pr', number: Number(number), owner: repo.owner, repo: repo.repo };
  }
  return null;
}

/** A GitHub read that did not produce a `head.sha` (status, timeout, shape). */
export class PrHeadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrHeadUnavailableError';
  }
}

/**
 * `GET /repos/{owner}/{repo}/pulls/{n}` → `head.sha`. Throws
 * {@link PrHeadUnavailableError} on any non-200, timeout or malformed body. Shared
 * with `routes/project-constraint-check.ts`, which wraps it in its own upstream error.
 */
export async function fetchPrHeadSha(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | null,
): Promise<string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fr-repository-pins',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Name only: a fetch error message could echo request headers.
    throw new PrHeadUnavailableError(
      `GitHub pull API unreachable (${err instanceof Error ? err.name : typeof err})`,
    );
  }
  if (res.status !== 200) {
    throw new PrHeadUnavailableError(
      `GitHub pull API returned HTTP ${res.status} for ${owner}/${repo}#${prNumber}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PrHeadUnavailableError('GitHub pull API returned an unreadable body');
  }
  const sha = (body as { head?: { sha?: unknown } } | null)?.head?.sha;
  if (typeof sha !== 'string' || !HEAD_SHA_RE.test(sha)) {
    throw new PrHeadUnavailableError('GitHub pull API returned no valid head.sha');
  }
  return sha;
}

/** Mint a `pr-read` token for the repo; null is fine for a PUBLIC repo. */
async function prReadToken(url: string, tenantId: string): Promise<string | null> {
  let t: CloneTokenResult;
  try {
    t = await requestCloneToken(url, { scope: 'pr-read', tenantId });
  } catch (err) {
    if (err instanceof CodingGithubNotConfiguredError) {
      // Nothing to mint with. A public repo still resolves anonymously; a private one
      // cannot, and the caller's message says so.
      return null;
    }
    if (err instanceof CodingGithubError) {
      throw new AppError(502, `GitHub access could not be checked for ${url}`).withCode(
        'repository_pin_lookup_failed',
      );
    }
    throw err;
  }
  if (t.token) return t.token;
  if (t.visibility === 'public') return null;
  throw new AppError(
    422,
    `${url} is not readable by this workspace, so its pull request cannot be pinned` +
      (t.reason ? ` (${t.reason})` : ''),
  ).withCode('repository_pin_unresolvable');
}

/**
 * The GitHub repository a PR pin is resolved against: the ROW's repository, always.
 * A PR URL naming another repository is refused — `sha` is stored on this row, and a
 * commit from a different repository would pin nothing.
 */
function prTarget(
  pin: Extract<RepoPin, { kind: 'pr' }>,
  rowUrl: string,
): { owner: string; repo: string } {
  const row = parseGithubRepo(rowUrl);
  if (!row) {
    throw new AppError(
      422,
      `repository ${rowUrl} is not a GitHub repository, so PR #${pin.number} cannot be resolved; ` +
        'pin the full 40-character commit instead',
    ).withCode('repository_pin_unresolvable');
  }
  if (
    pin.owner &&
    pin.repo &&
    (pin.owner.toLowerCase() !== row.owner.toLowerCase() ||
      pin.repo.toLowerCase() !== row.repo.toLowerCase())
  ) {
    throw new AppError(
      422,
      `PR ${pin.owner}/${pin.repo}#${pin.number} is not a pull request of ${rowUrl}`,
    ).withCode('repository_pin_unresolvable');
  }
  return row;
}

/** One row's pin → a 40-hex commit. */
export async function resolvePin(
  pin: string,
  rowUrl: string,
  tenantId: string,
): Promise<string> {
  const parsed = parseRepoPin(pin);
  if (!parsed) {
    throw new AppError(422, `repository pin "${pin}" is not a commit SHA or a pull request`).withCode(
      'repository_pin_invalid',
    );
  }
  if (parsed.kind === 'sha') return parsed.sha;
  const { owner, repo } = prTarget(parsed, rowUrl);
  const token = await prReadToken(rowUrl, tenantId);
  try {
    return await fetchPrHeadSha(owner, repo, parsed.number, token);
  } catch (err) {
    if (err instanceof PrHeadUnavailableError) {
      throw new AppError(
        422,
        `PR ${owner}/${repo}#${parsed.number} could not be pinned (${err.message})`,
      ).withCode('repository_pin_unresolvable');
    }
    throw err;
  }
}

interface PinnableRow {
  url: string;
  branch?: string;
  path?: string;
  name?: string;
  role?: 'source' | 'target';
  sha?: string;
  pin?: string;
}

/** The create body's `repo` shape, structurally (a body with `repo` always has a primary). */
interface RepoInput {
  primary: PinnableRow;
  additional?: PinnableRow[];
}

/** The row without its `pin` (the raw input never reaches RM or fr's DB). */
function withoutPin(row: PinnableRow): PinnableRow {
  const rest: PinnableRow = { ...row };
  delete rest.pin;
  return rest;
}

async function one(row: PinnableRow, tenantId: string): Promise<PinnableRow> {
  if (row.pin === undefined) return row;
  if (row.sha !== undefined) {
    throw new AppError(
      422,
      `repository ${row.url} carries both sha and pin; send exactly one`,
    ).withCode('repository_pin_conflict');
  }
  return { ...withoutPin(row), sha: await resolvePin(row.pin, row.url, tenantId) };
}

/**
 * Every repository row's `pin` replaced by its resolved `sha`, in one copy of the
 * body. Each pin costs one GitHub read ONLY when it is a PR; a 40-hex pin costs
 * nothing. Runs before the fr insert / the RM intake, so `rmRepositoriesOf` forwards
 * the resolved commit and `pin` never reaches RM (its schema forbids unknown keys).
 */
export async function resolveRepositoryPins(
  repo: RepoInput | undefined,
  opts: { tenantId: string },
): Promise<RepoInput | undefined> {
  if (!repo) return repo;
  return {
    primary: await one(repo.primary, opts.tenantId),
    ...(repo.additional
      ? { additional: await Promise.all(repo.additional.map((r) => one(r, opts.tenantId))) }
      : {}),
  };
}
