/**
 * Repo HEAD-SHA resolution for the dedup key.
 *
 * Wave-3 / T6.
 *
 * Why: today's idempotency key is `(repo, type, client_idempotency_key)`.
 * The frontend mints `client_idempotency_key` from a 5-min time bucket, so
 * "I just pushed a fix, scan it" within 10 minutes is silently deduped to
 * the prior run. Folding the repo HEAD sha into the effective key produces
 * a fresh job whenever the repo has changed.
 *
 * Resolution order (each step falls through on any failure):
 *   1. Ask coding-gateway via /api/repositories/{container}/head — preferred
 *      because the gateway shares a git mirror with the analysis containers.
 *      The endpoint is NOT documented at this revision; if it 404s we move
 *      on. (See plan §T6.1 — coordinate an upstream PR if/when needed.)
 *   2. `git ls-remote <url> HEAD` — works for any reachable git remote.
 *      Bun.spawn is used so we don't depend on a shell builtin.
 *   3. Return null. The adapter then dedups on the bare client key, which
 *      is the existing pre-T6 behavior — never WORSE than today.
 *
 * Cached per `(containerName, url)` for 60 s to avoid hammering the gateway
 * or the remote when the user re-clicks a button within seconds.
 */

import { eq } from 'drizzle-orm';

import { db as defaultDb, repositories } from '../../db/client';
import { http } from './client';

const HEAD_SHA_TTL_MS = 60_000;
const headShaCache = new Map<string, { sha: string; expires: number }>();

/** Hard wall-clock bound on `git ls-remote`. */
const LS_REMOTE_TIMEOUT_MS = 10_000;

/**
 * `git ls-remote <url> HEAD`, bounded. Before this bound the spawn had NO
 * timeout and inherited the terminal-prompt behaviour: a remote that stalls
 * (packet-dropping FORWARD rule, no RST) or one that asks for credentials hung
 * the request — and the caller — indefinitely. Now: GIT_TERMINAL_PROMPT=0 (a
 * credential prompt fails at once instead of waiting on a tty that is not
 * there) and a kill after `timeoutMs`. Any failure is null (fall through).
 */
async function gitLsRemoteHead(
  url: string,
  timeoutMs: number = LS_REMOTE_TIMEOUT_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(['git', 'ls-remote', url, 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    const exitCode = await proc.exited;
    if (timedOut || exitCode !== 0) return null;
    const out = await new Response(proc.stdout).text();
    // Output: "<40-hex-sha>\tHEAD\n"
    const m = out.match(/^([0-9a-f]{40})\b/);
    return m && m[1] ? m[1] : null;
  } catch {
    // Git missing / sandboxed — give up.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultHeadShaFetcher(
  containerName: string,
  url: string,
): Promise<string | null> {
  // (1) Best path — ask the upstream gateway. Treat any failure as
  //     "fall through" — the endpoint may not exist on this gateway
  //     revision.
  try {
    const body = await http().json<{ sha?: string; head?: string; commit?: string }>(
      `/api/repositories/${encodeURIComponent(containerName)}/head`,
      { timeoutMs: 5_000, noRetry: true },
    );
    const sha = body.sha ?? body.head ?? body.commit;
    if (typeof sha === 'string' && sha.length > 0) return sha;
  } catch {
    // Fall through.
  }

  // (2) `git ls-remote <url> HEAD`. Works for public repos and for any
  //     private repo where the runtime has credentials configured at the
  //     OS level (gitconfig / netrc). Failures here are silent.
  if (url && /^https?:\/\//.test(url)) {
    const sha = await gitLsRemoteHead(url);
    if (sha) return sha;
  }

  // (3) Could not resolve. Caller dedups on the bare client key.
  return null;
}

/**
 * Resolve the HEAD commit SHA of a repo.
 *
 * Returns `null` when neither the upstream gateway nor `git ls-remote` can
 * answer; callers MUST then dedup on the bare client key (pre-T6 behavior).
 */
export async function resolveRepoHeadSha(
  containerName: string,
  url: string,
): Promise<string | null> {
  // Skip when the caller didn't provide a usable container_name + url. Both
  // resolution paths require at least one of them; without either we'd just
  // burn a fetch round trip + a git ls-remote attempt to learn the same null.
  if (!containerName || !url) return null;

  const key = `${containerName}\0${url}`;
  const now = Date.now();
  const hit = headShaCache.get(key);
  if (hit && hit.expires > now) return hit.sha;

  const sha = await defaultHeadShaFetcher(containerName, url);
  if (sha) headShaCache.set(key, { sha, expires: now + HEAD_SHA_TTL_MS });
  return sha;
}

// ---------------------------------------------------------------------------
// T7a — repo-id keyed resolver for the AG-UI `coding.trigger_analysis` action.
//
// The action's `idempotencyKey` only sees the parsed input (`repo_id`,
// `type`, `client_idempotency_key`). To fold the repo HEAD sha into the key,
// we need to look up `(container_name, url)` from `repositories` first. This
// helper wraps that lookup + the existing `resolveRepoHeadSha` so the action
// stays a one-liner.
//
// Failures are SILENT and return `null`: an unreachable gateway or missing
// container_name must not break action dispatch. The caller folds the sha
// only when it's non-null, falling back to the bare client key (pre-T7a
// behavior — never WORSE than today). This mirrors the adapter's contract.
// ---------------------------------------------------------------------------

export async function resolveHeadShaForRepoId(
  repoId: string,
  db: typeof defaultDb = defaultDb,
): Promise<string | null> {
  if (!repoId) return null;
  let containerName: string | null = null;
  let url: string | null = null;
  try {
    const [row] = await db
      .select({
        container_name: repositories.container_name,
        url: repositories.url,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    if (!row) return null;
    containerName = row.container_name;
    url = row.url;
  } catch {
    // Schema/connectivity glitch — fall back to the bare client key.
    return null;
  }
  if (!containerName || !url) return null;
  try {
    return await resolveRepoHeadSha(containerName, url);
  } catch {
    return null;
  }
}
