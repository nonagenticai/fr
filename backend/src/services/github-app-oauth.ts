// services/github-app-oauth.ts
//
// The two GitHub calls the install callback makes to learn WHO installed and
// WHICH installations that person can see:
//
//   1. POST https://github.com/login/oauth/access_token   (code → user token)
//   2. GET  https://api.github.com/user/installations      (paginated, user token)
//   3. GET  https://api.github.com/user                     (the GitHub login)
//   3b. GET https://api.github.com/user/memberships/orgs/{org}
//                                                           (is the installer an ACTIVE org ADMIN?)
//   4. DELETE https://api.github.com/applications/{client_id}/token
//                                                           (revoke the user token)
//
// ⛔ Neither the code nor the user token ever appears in an error message, a
// log line, or a return value beyond `exchangeCodeForUserToken`'s result. The
// errors below carry only a status and a fixed description; GitHub's
// `error_description` is not echoed (it can quote the request).

import { githubAppClientId, githubAppClientSecret } from './github-app-config';

const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
/** 50 × 100 = 5,000 installations visible to one user. Past that we stop, loudly. */
const MAX_PAGES = 50;

export class GithubOAuthError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'GithubOAuthError';
    this.status = status;
  }
}

export interface UserInstallation {
  id: number;
  account_login: string;
  account_type: string;
}

async function call(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new GithubOAuthError(`${what}: GitHub did not answer within ${timeoutMs} ms`, null);
    }
    // Only the error NAME — a message could echo the request.
    throw new GithubOAuthError(`${what}: could not reach GitHub (${e instanceof Error ? e.name : typeof e})`, null);
  } finally {
    clearTimeout(timer);
  }
}

function apiHeaders(userToken: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fr-github-app-install',
    authorization: `Bearer ${userToken}`,
  };
}

/** Exchange the callback `code` for a user-to-server token. */
export async function exchangeCodeForUserToken(code: string): Promise<string> {
  const clientId = githubAppClientId();
  const clientSecret = githubAppClientSecret();
  if (!clientId || !clientSecret) {
    throw new GithubOAuthError('code exchange: GitHub App client id/secret not configured', null);
  }
  const res = await call(
    OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'fr-github-app-install' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    },
    'code exchange',
  );
  if (res.status !== 200) throw new GithubOAuthError(`code exchange failed (HTTP ${res.status})`, res.status);
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
  // GitHub reports a bad/expired code as 200 + `{ error: 'bad_verification_code' }`.
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    const code = typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'no_access_token';
    throw new GithubOAuthError(`code exchange refused (${code})`, 200);
  }
  return body.access_token;
}

/** Every installation of THIS app the user can access, across all pages. */
export async function listUserInstallations(userToken: string): Promise<UserInstallation[]> {
  const out: UserInstallation[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await call(
      `${GITHUB_API}/user/installations?per_page=${PER_PAGE}&page=${page}`,
      { method: 'GET', headers: apiHeaders(userToken) },
      'list installations',
    );
    if (res.status !== 200) throw new GithubOAuthError(`list installations failed (HTTP ${res.status})`, res.status);
    const body = (await res.json().catch(() => null)) as
      | { total_count?: unknown; installations?: unknown }
      | null;
    if (!body || !Array.isArray(body.installations)) {
      throw new GithubOAuthError('list installations: response did not match the contract', 200);
    }
    for (const raw of body.installations as Array<Record<string, unknown>>) {
      const id = raw?.id;
      const account = raw?.account as Record<string, unknown> | undefined;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) continue;
      const login = typeof account?.login === 'string' ? account.login : '';
      if (!login) continue;
      out.push({ id, account_login: login, account_type: typeof account?.type === 'string' ? account.type : 'Unknown' });
    }
    const total = typeof body.total_count === 'number' ? body.total_count : null;
    if (body.installations.length < PER_PAGE) return out;
    if (total !== null && out.length >= total) return out;
  }
  throw new GithubOAuthError(`list installations: more than ${MAX_PAGES * PER_PAGE} installations; refusing to guess`, 200);
}

/** The installing person's GitHub login. */
export async function getAuthenticatedLogin(userToken: string): Promise<string> {
  const res = await call(`${GITHUB_API}/user`, { method: 'GET', headers: apiHeaders(userToken) }, 'get user');
  if (res.status !== 200) throw new GithubOAuthError(`get user failed (HTTP ${res.status})`, res.status);
  const body = (await res.json().catch(() => null)) as { login?: unknown } | null;
  if (!body || typeof body.login !== 'string' || !body.login) {
    throw new GithubOAuthError('get user: response did not match the contract', 200);
  }
  return body.login;
}

export interface OrgMembership {
  state: string;
  role: string;
}

/**
 * The installer's membership in `org`, read with THEIR token
 * (`GET /user/memberships/orgs/{org}`; needs the App's Organization
 * permission "Members: read"). `/user/installations` also lists
 * installations a user can merely READ (an outside collaborator on one repo),
 * so seeing an installation is not authority over it — the callback requires
 * `{ state: 'active', role: 'admin' }` from this call.
 *
 * null on 403/404 (not a member, or the membership is not visible to this
 * token) — the caller treats null as "not an admin". Any other status throws.
 */
export async function getOrgMembership(
  userToken: string,
  org: string,
): Promise<OrgMembership | null> {
  const res = await call(
    `${GITHUB_API}/user/memberships/orgs/${encodeURIComponent(org)}`,
    { method: 'GET', headers: apiHeaders(userToken) },
    'get org membership',
  );
  if (res.status === 403 || res.status === 404) return null;
  if (res.status !== 200) throw new GithubOAuthError(`get org membership failed (HTTP ${res.status})`, res.status);
  const body = (await res.json().catch(() => null)) as { state?: unknown; role?: unknown } | null;
  if (!body || typeof body.state !== 'string' || typeof body.role !== 'string') {
    throw new GithubOAuthError('get org membership: response did not match the contract', 200);
  }
  return { state: body.state, role: body.role };
}

/**
 * Revoke the installer's user-to-server token once the callback is done with
 * it: fr never needs it again, so it must not outlive the request (it would
 * otherwise stay valid for up to 8 h, or indefinitely with expiry disabled).
 * GitHub: `DELETE /applications/{client_id}/token`, Basic client_id:client_secret,
 * JSON `{ access_token }`, 204 on success.
 *
 * Throws GithubOAuthError (token-free message) on any failure; the caller
 * treats revocation as best-effort.
 */
export async function revokeUserToken(userToken: string): Promise<void> {
  const clientId = githubAppClientId();
  const clientSecret = githubAppClientSecret();
  if (!clientId || !clientSecret) {
    throw new GithubOAuthError('revoke token: GitHub App client id/secret not configured', null);
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await call(
    `${GITHUB_API}/applications/${encodeURIComponent(clientId)}/token`,
    {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fr-github-app-install',
        'content-type': 'application/json',
        authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({ access_token: userToken }),
    },
    'revoke token',
  );
  if (res.status !== 204) throw new GithubOAuthError(`revoke token failed (HTTP ${res.status})`, res.status);
}
