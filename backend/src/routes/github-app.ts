// routes/github-app.ts
//
// Public GitHub App (`nonagenticai`, id 5029921) — tenant-bound installs.
// Plan: ~/.claude/plans/public-github-app-usable.md ("fr install flow",
// "fr internal lookup").
//
//   POST   /api/github-app/install-url          workspace-admin | super-admin → { url }
//   GET    /api/github-app/callback             NO auth (signed state) → 302 ?claim=<handle> (never binds)
//   POST   /api/github-app/claims/:handle/confirm  workspace-admin | super-admin, SAME user+tenant as the state → { data }
//   GET    /api/github-app/installations        auth, tenant  → { items: [...] }
//   DELETE /api/github-app/installations/:id    workspace-admin | super-admin → { data }
//   GET    /api/internal/github-app/binding     X-Internal-Token == FR_GITHUB_BINDING_TOKEN
//
// ── WHY THE CALLBACK TRUSTS WHAT IT TRUSTS ──────────────────────────────────
//
// fr auth is bearer-only, and a browser redirect from github.com carries no
// bearer. So the callback's identity is ONLY the signed, single-use `state`
// minted by install-url for (user, tenant). GitHub's `installation_id` query
// param is attacker-controllable, so it is never trusted on its own: the
// callback exchanges the OAuth `code` for the INSTALLER's user token and
// requires `GET /user/installations` (with that token) to list the id. An
// installation already bound to a DIFFERENT tenant is refused, never rebound.
//
// Seeing an installation is not authority over it: `/user/installations` also
// lists installations the user can merely READ (an outside collaborator). So
// the installer must be an ACTIVE org ADMIN (`/user/memberships/orgs/{org}`,
// App permission "Members: read") for an Organization, or BE the account for
// a User install.
//
// The state proves who STARTED the install, not who is at the browser that
// came back (login CSRF / state fixation: an attacker mints a state in their
// tenant and sends the link to an admin of org X). So the callback NEVER
// binds: it parks a verified claim in Redis and redirects `?claim=<handle>`;
// the logged-in SPA POSTs confirm, which binds only when the confirming user
// AND active tenant equal the state's. A mismatch consumes the claim → 403.
//
// ⛔ The code and the user token never appear in a redirect, a response body,
// or a log line. Every failure is a fixed `?github_error=<code>`.
//
// The feature is INERT until configured: install-url and callback answer 503
// `github_app_not_configured` while client id / secret / state key are unset.

import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { AppError, BadRequestError, NotFoundError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { timingSafeEquals } from '../utils/secret-compare';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { userRolesService } from '../services/user-roles';
import {
  frPublicUrl,
  githubAppSlug,
  githubBindingToken,
  missingInstallFlowEnv,
} from '../services/github-app-config';
import {
  consumeGithubAppState,
  createPendingClaim,
  GithubAppStateError,
  mintGithubAppState,
  takePendingClaim,
} from '../services/github-app-state';
import {
  exchangeCodeForUserToken,
  getAuthenticatedLogin,
  getOrgMembership,
  listUserInstallations,
  revokeUserToken,
} from '../services/github-app-oauth';
import {
  bindInstallation,
  findActiveBinding,
  listTenantInstallations,
  revokeTenantInstallation,
} from '../services/github-app-installations';
import type { GithubAppInstallation } from '../db/schema';


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// GitHub account login: alnum + hyphen, 1–39 chars.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

type CallbackErrorCode =
  | 'invalid_state'
  | 'invalid_installation'
  | 'missing_code'
  | 'oauth_failed'
  | 'github_unavailable'
  | 'not_your_installation'
  | 'not_org_admin'
  | 'not_account_owner'
  | 'bound_to_other_tenant'
  | 'internal_error';

function notConfigured(): Response {
  return jsonResponse(
    { error: 'GitHub App install flow is not configured', code: 'github_app_not_configured' },
    503,
  );
}

// The SPA hands its own URL to Keycloak as redirect_uri when it has to (re)authenticate,
// and Keycloak refuses any redirect_uri whose query carries an OAuth response parameter
// (measured on auth.nonagentic.ai: `code`, `state`, `error` → 400 "Invalid parameter:
// redirect_uri"; `claim`, `pending`, `github_error` → accepted). So the settings page must
// never be reached with one of those names, or the user lands on a Keycloak error page.
const OAUTH_RESERVED_QUERY_PARAMS = new Set(['code', 'state', 'error', 'error_description', 'session_state', 'iss']);

function redirectToSettings(params: Record<string, string>): Response {
  for (const k of Object.keys(params)) {
    if (OAUTH_RESERVED_QUERY_PARAMS.has(k)) throw new Error(`redirectToSettings: reserved OAuth query param '${k}'`);
  }
  const url = new URL(`${frPublicUrl()}/settings/github`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      // The inbound URL carried an OAuth code: never cache, never leak it as a referrer.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function fail(code: CallbackErrorCode): Response {
  return redirectToSettings({ github_error: code });
}

function serialize(row: GithubAppInstallation) {
  const iso = (d: Date | string | null) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));
  return {
    id: row.id,
    installation_id: row.installation_id,
    account_login: row.account_login,
    account_type: row.account_type,
    github_user_login: row.github_user_login,
    installed_by_user_id: row.installed_by_user_id,
    created_at: iso(row.created_at),
    last_verified_at: iso(row.last_verified_at),
    revoked_at: iso(row.revoked_at),
    revoked: row.revoked_at != null,
  };
}

/**
 * The one admin gate for every mutating GitHub App route (install-url, claim
 * confirm, revoke): workspace-admin of the ACTIVE tenant, or super-admin.
 */
async function requireGithubAppAdmin(user: Awaited<ReturnType<typeof validateAuth>>, tenantId: string): Promise<void> {
  const admin =
    isSuperAdmin(user) ||
    (await userRolesService.isWorkspaceAdminVia(user, tenantId, userRolesService.hasRole));
  if (!admin) throw new AppError(403, 'workspace-admin role required').withCode('workspace_admin_required');
}

/** POST /api/github-app/install-url — a GitHub install URL carrying a signed state for (me, my tenant). */
export async function handleCreateGithubAppInstallUrl(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  await requireGithubAppAdmin(user, tenantId);
  if (missingInstallFlowEnv().length > 0) return notConfigured();
  const { state } = await mintGithubAppState({ userId: user.id, tenantId });
  const url = `https://github.com/apps/${encodeURIComponent(githubAppSlug())}/installations/new?state=${encodeURIComponent(state)}`;
  return jsonResponse({ url });
}

/** GET /api/github-app/callback — GitHub's post-install redirect. Unauthenticated by design. */
export async function handleGithubAppCallback(req: Request): Promise<Response> {
  if (missingInstallFlowEnv().length > 0) return notConfigured();
  const q = new URL(req.url).searchParams;

  // 1. The state is the identity. Verify + consume before anything else.
  let state;
  try {
    state = await consumeGithubAppState(q.get('state'));
  } catch (e) {
    if (e instanceof GithubAppStateError) return fail('invalid_state');
    throw e;
  }

  // `request`: an org owner must still approve — nothing is installed, nothing
  // is bound. `install` AND `update` both bind (GitHub sends `update` when the
  // app was already installed or an owner-approved request is completed), and
  // both go through the same /user/installations membership check below.
  if (q.get('setup_action') === 'request') return redirectToSettings({ pending: '1' });

  const rawId = q.get('installation_id') ?? '';
  const installationId = /^[1-9][0-9]{0,15}$/.test(rawId) ? Number(rawId) : NaN;
  if (!Number.isSafeInteger(installationId)) return fail('invalid_installation');

  const code = q.get('code');
  if (!code) return fail('missing_code');

  // 2. code → the installer's user token.
  let userToken: string;
  try {
    userToken = await exchangeCodeForUserToken(code);
  } catch (e) {
    reportSwallowedFailure(e, { service: 'github', method: 'POST', path: '/login/oauth/access_token', degradedTo: 'redirect github_error=oauth_failed' });
    return fail('oauth_failed');
  }

  // 3. GitHub must confirm THIS user can see THIS installation AND administers
  // its account (org admin, or the personal account itself). The user token
  // is used for nothing after this block, so it is revoked on EVERY exit from
  // it (match, no match, GitHub error) — best-effort: a failed revoke is
  // logged (GithubOAuthError messages are token-free) and never changes the
  // redirect.
  let match: { id: number; account_login: string; account_type: string } | undefined;
  let githubLogin: string;
  try {
    const installs = await listUserInstallations(userToken);
    match = installs.find((i) => i.id === installationId);
    if (!match) return fail('not_your_installation');
    githubLogin = await getAuthenticatedLogin(userToken);
    if (match.account_type === 'Organization') {
      const m = await getOrgMembership(userToken, match.account_login);
      if (!m || m.state !== 'active' || m.role !== 'admin') return fail('not_org_admin');
    } else if (match.account_type === 'User') {
      if (githubLogin.toLowerCase() !== match.account_login.toLowerCase()) return fail('not_account_owner');
    } else {
      // Enterprise / unknown account types: no ownership proof we can check.
      return fail('not_account_owner');
    }
  } catch (e) {
    reportSwallowedFailure(e, { service: 'github', method: 'GET', path: '/user/installations', degradedTo: 'redirect github_error=github_unavailable' });
    return fail('github_unavailable');
  } finally {
    try {
      await revokeUserToken(userToken);
    } catch (e) {
      // Logged by NAME and upstream status only — never the message, so no
      // error (whatever its type) can carry the token into the log.
      const status = (e as { status?: unknown } | null)?.status;
      const safe = new Error(
        `revoke token threw ${e instanceof Error ? e.name : typeof e}` +
          (typeof status === 'number' ? ` (HTTP ${status})` : ''),
      );
      reportSwallowedFailure(safe, { service: 'github', method: 'DELETE', path: '/applications/{client_id}/token', degradedTo: 'user token left to expire' });
    }
  }

  // 4. Do NOT bind here. Park a verified claim for the authenticated confirm.
  try {
    const handle = await createPendingClaim({
      user_id: state.user_id,
      tenant_id: state.tenant_id,
      installation_id: installationId,
      account_login: match.account_login,
      account_type: match.account_type,
      github_user_login: githubLogin,
      verified_admin: true,
    });
    return redirectToSettings({ claim: handle });
  } catch (e) {
    reportSwallowedFailure(e, { service: 'redis', method: 'SET', path: 'github-app:claim:*', degradedTo: 'redirect github_error=internal_error' });
    return fail('internal_error');
  }
}

/**
 * POST /api/github-app/claims/:handle/confirm — bind a parked claim.
 * The claim is consumed (GETDEL) on every attempt that reaches it; it binds
 * ONLY for the user AND tenant that minted the install state.
 */
export async function handleConfirmGithubAppClaim(req: Request, handle: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  await requireGithubAppAdmin(user, tenantId);
  const claim = await takePendingClaim(handle);
  if (!claim) {
    throw new NotFoundError('GitHub App claim not found, expired, or already used').withCode('claim_not_found');
  }
  if (claim.user_id !== user.id || claim.tenant_id !== tenantId) {
    throw new AppError(403, 'This GitHub installation was started by a different user or workspace').withCode('claim_not_yours');
  }
  const result = await bindInstallation({
    tenantId: claim.tenant_id,
    installationId: claim.installation_id,
    accountLogin: claim.account_login,
    accountType: claim.account_type,
    installedByUserId: claim.user_id,
    githubUserLogin: claim.github_user_login,
  });
  if (result.outcome === 'bound_to_other_tenant') {
    throw new AppError(409, 'That GitHub installation is already connected to a different workspace').withCode('bound_to_other_tenant');
  }
  return jsonResponse({ data: serialize(result.row) });
}

/** GET /api/github-app/installations[?include_revoked=true] — this tenant's bindings. */
export async function handleListGithubAppInstallations(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  const includeRevoked = new URL(req.url).searchParams.get('include_revoked') === 'true';
  const rows = await listTenantInstallations(tenantId, { includeRevoked });
  return jsonResponse({ items: rows.map(serialize) });
}

/** DELETE /api/github-app/installations/:id — unbind (sets revoked_at). Workspace admin or super-admin. */
export async function handleRevokeGithubAppInstallation(req: Request, id: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  await requireGithubAppAdmin(user, tenantId);
  if (!UUID_RE.test(id)) throw new NotFoundError('GitHub App installation not found');
  const row = await revokeTenantInstallation(tenantId, id);
  if (!row) throw new NotFoundError('GitHub App installation not found');
  return jsonResponse({ data: serialize(row) });
}

/**
 * GET /api/internal/github-app/binding?tenant_id=&owner= — coding-github's lookup.
 * Auth: `X-Internal-Token` == FR_GITHUB_BINDING_TOKEN, constant-time. Unset env
 * → 401 for everyone (fail closed). Revoked bindings are never returned.
 */
export async function handleGetGithubAppBinding(req: Request): Promise<Response> {
  const expected = githubBindingToken();
  const presented = req.headers.get('X-Internal-Token') ?? '';
  if (!expected || !presented || !timingSafeEquals(presented, expected)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const q = new URL(req.url).searchParams;
  const tenantId = (q.get('tenant_id') ?? '').trim();
  const owner = (q.get('owner') ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new BadRequestError('tenant_id must be a uuid');
  if (!OWNER_RE.test(owner)) throw new BadRequestError('owner must be a GitHub account login');
  const binding = await findActiveBinding(tenantId, owner);
  return jsonResponse({
    installation_id: binding?.installation_id ?? null,
    account_login: binding?.account_login ?? null,
  });
}
