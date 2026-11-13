// integrations/coding-github/client.ts
//
// fr -> coding-github `POST /api/internal/github/clone-token`
// (nonagenticai/coding-github `src/routers/github_internal.py`, mounted under
// `/api/internal` in `src/main.py`).
//
// ── WHY NOT THE SHARED HttpClient ───────────────────────────────────────────
//
// `_lib/http-client.ts` stamps the AMBIENT request tenant into `X-Tenant-Id`
// (and X-User-Id etc.) on every call. This endpoint is guarded ONLY by the
// `X-Internal-Token` shared secret and must NEVER receive `X-Tenant-Id` — a
// tenant header can 403 it. The helper has no option to suppress that, and it
// calls the global `fetch` with its own headers. Hence a
// small explicit fetch with exactly the headers we mean.
//
// ── THE TOKEN IS A SECRET, BOTH OF THEM ─────────────────────────────────────
//
// `FR_CODING_GITHUB_TOKEN` (what we present) and the minted `token` (what we
// get back — a live contents:read credential) never appear in an error
// message or a log line. Callers that only need the verdict must drop the
// minted token immediately.

import { CODING_SERVICE_TOKEN_ENV, serviceCredential } from '../_lib/service-credential';

export const CODING_GITHUB_URL_ENV = 'FR_CODING_GITHUB_URL';
export const CODING_GITHUB_TOKEN_ENV = 'FR_CODING_GITHUB_TOKEN';
const CLONE_TOKEN_PATH = '/api/internal/github/clone-token';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CloneTokenResult {
  token: string | null;
  expires_at: string | null;
  visibility: 'public' | 'private';
  source: 'app' | 'none';
  reason: string | null;
}

/** Either env var is unset/blank — no request was attempted. */
export class CodingGithubNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`coding-github client not configured: ${missing.join(', ')} unset`);
    this.name = 'CodingGithubNotConfiguredError';
  }
}

/**
 * coding-github could not be reached, answered non-200, or returned a body
 * that does not match the contract. `status` is the HTTP status, or `null`
 * when no response arrived (network failure / timeout / unreadable body on
 * a 200 is reported with status 200).
 */
export class CodingGithubError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'CodingGithubError';
    this.status = status;
  }
}

export interface RequestCloneTokenDeps {
  /**
   * Token scope coding-github mints. `clone` = contents:read (the default).
   * `pr-read` adds pull_requests:read, which GitHub's `GET /pulls/{n}/files`
   * requires — measured live 2026-09-22: a clone-scoped token gets 403
   * "Resource not accessible by integration" there.
   */
  scope?: 'clone' | 'pr-read';
  /**
   * The requesting fr tenant, sent as body `tenant_id`. coding-github REQUIRES
   * it for a non-internal owner (the public GitHub App only mints for an
   * installation bound to that tenant) and answers `reason: tenant_required`
   * without it.
   *
   * ⚠️ CORRECTED — this said "Internal (nonagenticai) owners ignore it". That
   * is FALSE, and the direction matters: internal owners are exactly where the
   * field became load-bearing. A platform-owned (`nonagenticai`) repo goes
   * through coding-github's platform-repo tenant gate
   * (`src/services/tenant_binding.py check_platform_repo_tenant`), which reads
   * THIS field and treats an absent tenant as STRICTLY non-platform. While
   * `CODING_GITHUB_PLATFORM_TENANT_ENFORCE` is off the gate only logs
   * `platform_repo_tenant_gate decision=would_refuse`; once it is on, omitting
   * the tenant on the internal-owner branch is a refusal
   * (`reason: platform_repo_forbidden`). So send it on EVERY branch.
   *
   * Body, never a header: `X-Tenant-Id` must not reach this endpoint (see file
   * header).
   */
  tenantId?: string | null;
}

function parseResult(body: unknown): CloneTokenResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const visibility = b.visibility;
  const source = b.source;
  if (visibility !== 'public' && visibility !== 'private') return null;
  if (source !== 'app' && source !== 'none') return null;
  const token = typeof b.token === 'string' ? b.token : null;
  const expires_at = typeof b.expires_at === 'string' ? b.expires_at : null;
  // `reason` is optional on the wire (older coding-github omits it); absent is
  // null, never inferred.
  const reason = typeof b.reason === 'string' ? b.reason : null;
  return { token, expires_at, visibility, source, reason };
}

export async function requestCloneToken(
  repoUrl: string,
  deps: RequestCloneTokenDeps = {},
): Promise<CloneTokenResult> {
  const base = serviceCredential(CODING_GITHUB_URL_ENV);
  const internalToken = serviceCredential(CODING_GITHUB_TOKEN_ENV);
  const missing: string[] = [];
  if (!base) missing.push(CODING_GITHUB_URL_ENV);
  if (!internalToken) missing.push(CODING_GITHUB_TOKEN_ENV);
  // coding-github's auth middleware ALSO demands the caller's licence
  // (Authorization: Bearer), exactly like coding-containers sends. fr's licence
  // for the coding-* family is CODING_SERVICE_TOKEN. Measured live 2026-09-22:
  // without it every call is 401 "Authentication required", even with the
  // correct X-Internal-Token.
  const licence = serviceCredential(CODING_SERVICE_TOKEN_ENV);
  if (!licence) missing.push(CODING_SERVICE_TOKEN_ENV);
  if (!base || !internalToken || !licence) throw new CodingGithubNotConfiguredError(missing);

  const url = `${base.replace(/\/+$/, '')}${CLONE_TOKEN_PATH}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      // Exactly these headers. NEVER X-Tenant-Id (see file header).
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Internal-Token': internalToken,
        authorization: `Bearer ${licence}`,
      },
      body: JSON.stringify({
        repo_url: repoUrl,
        scope: deps.scope ?? 'clone',
        ...(deps.tenantId?.trim() ? { tenant_id: deps.tenantId.trim() } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new CodingGithubError(`coding-github did not answer within ${DEFAULT_TIMEOUT_MS} ms`, null);
    }
    // Only the error's NAME: a fetch implementation's message could echo the
    // request (and with it the header). Nothing from the request goes out.
    const kind = e instanceof Error ? e.name : typeof e;
    throw new CodingGithubError(`could not reach coding-github (${kind})`, null);
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) {
    // Body deliberately NOT echoed: a non-contract upstream (proxy, misroute)
    // could reflect request headers back.
    const what =
      res.status === 400
        ? 'rejected the repository URL'
        : res.status === 403
          ? 'refused fr\'s internal token'
          : res.status === 502
            ? 'could not resolve repository visibility'
            : 'failed';
    throw new CodingGithubError(`coding-github ${what} (HTTP ${res.status})`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CodingGithubError('coding-github returned an unreadable response', 200);
  }
  const parsed = parseResult(body);
  if (!parsed) {
    throw new CodingGithubError('coding-github response did not match the clone-token contract', 200);
  }
  return parsed;
}
