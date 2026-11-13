// src/services/agent-session.ts
//
// E-13 — Agent session token refresh.
//
// Issues a long-lived (30d) refresh token at agent-chat start and exchanges
// it for a short-lived (15m) FR access token (HS256 JWT, aud=`fr-agent`).
// Refresh tokens are stored only as sha256 hex of the raw 256-bit random
// value — the raw value is returned to the caller exactly once. Each refresh
// rotates the token (insert new row, mark old row revoked + replaced_by). A
// presented token whose row is already `replaced_by` something is treated as
// a replay: the entire forward chain rooted at that row is revoked and a 401
// is returned.
//
// See docs/superpowers/specs/completed/2026-04-25-e13-agent-session-token-refresh.md.

import { randomBytes, createHash } from 'node:crypto';
import { SignJWT } from 'jose';

import { keycloak } from './keycloak';
import { AppError } from '../utils/errors';
import { AGENT_TOKEN_AUDIENCE, SUPER_ADMIN_SWITCH_CLAIM, agentTokenSecret } from '../lib/agent-token';
import { hasSuperAdminRole } from '../lib/super-admin-gate';
import { isSuperAdminSwitchTarget } from '../lib/super-admin-switch-target';
import postgres from 'postgres';

// Lazy postgres client. Built on first use so tests can patch DATABASE_URL
// before importing this module without racing the eager `db/client.ts`
// queryClient construction.
let sqlClient: postgres.Sql | null = null;

/**
 * ⛔ NO DEFAULT DSN. This used to fall back to `postgres:postgres@localhost:5432/fr`
 * — a host Postgres that no longer exists (George ruling 2026-10-21: no service or
 * test defaults to a host :5432). An unset DATABASE_URL now refuses on first use
 * with this message instead of dialling a machine-local database. The fr
 * Deployment sets DATABASE_URL on the fr-backend container.
 */
export const AGENT_SESSION_DATABASE_URL_UNSET_MESSAGE =
  'DATABASE_URL is not set: agent sessions have no default database and refuse to fall back to ' +
  'a machine-local one. Set DATABASE_URL=postgresql://<user>:<pw>@<host>:<port>/<db>.';

function getSql(): postgres.Sql {
  if (!sqlClient) {
    const url = (process.env.DATABASE_URL ?? '').trim();
    if (url === '') {
      throw new Error(AGENT_SESSION_DATABASE_URL_UNSET_MESSAGE);
    }
    sqlClient = postgres(url, { onnotice: () => {} });
  }
  return sqlClient;
}

/** Default refresh-token lifetime (30 days). */
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Access-token lifetime (15 minutes). */
const ACCESS_TTL_SECONDS = 15 * 60;

/** JWT audience marker so `validateAuth` can distinguish FR-issued agent
 *  tokens from Keycloak tokens at verify time. */
// Re-exported from `lib/agent-token`, the single owner. Existing importers
// (routes/agui-threads.ts, tests) keep working unchanged. Imported as well as
// re-exported because this module SIGNS with it below — a bare `export {} from`
// does not bring the name into local scope.
export { AGENT_TOKEN_AUDIENCE };

export class ReplayDetectedError extends Error {
  constructor(message = 'refresh_token_replayed') {
    super(message);
    this.name = 'ReplayDetectedError';
  }
}

export class ExpiredError extends Error {
  constructor(message = 'refresh_token_expired') {
    super(message);
    this.name = 'ExpiredError';
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor(message = 'refresh_token_invalid') {
    super(message);
    this.name = 'InvalidRefreshTokenError';
  }
}

/**
 * The session's Keycloak user no longer exists or is disabled. The presented
 * row has been revoked; the route answers 401. Without this a deleted or
 * disabled user's 30-day refresh chain kept minting access tokens, because
 * nothing on the refresh leg ever asked whether the user was still there.
 */
export class SessionUserInactiveError extends AppError {
  constructor(message = 'session_user_inactive') {
    super(401, message);
    // Re-set AFTER super(): AppError's constructor sets name to 'AppError'.
    this.name = 'SessionUserInactiveError';
  }
}

/**
 * Keycloak could not say whether the session's user still exists. Nothing was
 * rotated or revoked (the transaction rolled back), so the caller can retry
 * with the SAME refresh token once the directory is reachable; the route
 * answers 503. Fails closed: no access token is minted for an unverified user.
 */
export class SessionUserUnverifiableError extends AppError {
  constructor(message = 'session_user_unverifiable') {
    super(503, message);
    // Re-set AFTER super(): AppError's constructor sets name to 'AppError'.
    this.name = 'SessionUserUnverifiableError';
  }
}

/**
 * fr-agui P1-TEAM-a: the session's tenant is no longer the user's Keycloak HOME
 * tenant (the user was re-homed to another tenant, or removed from it). Since
 * P1-TEAM every member of a tenant acts on EVERY project of that tenant, so a
 * session frozen on the old tenant would keep tenant-wide agent access to it
 * for the life of the 30-day sliding refresh chain. The presented row is
 * revoked (no successor is minted); the route answers 401
 * `session_tenant_changed`, and the client re-issues a session — which takes
 * the tenant from the user's CURRENT Keycloak token.
 */
export class SessionTenantChangedError extends AppError {
  constructor(message = 'session_tenant_changed') {
    super(401, message);
    // Re-set AFTER super(): AppError's constructor sets name to 'AppError'.
    this.name = 'SessionTenantChangedError';
  }
}

/** sha256 hex of the raw token. Fast, unsalted — the raw token is a 256-bit
 *  random value with no human-derivable structure. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 256-bit random refresh token (hex). */
function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

// The MINTING side of the same secret the verifying side uses. It was a second
// copy of the resolution above; one owner now, so they cannot drift apart.
const getJwtSecret = agentTokenSecret;

interface UserAccountState {
  status: 'active' | 'disabled' | 'not_found';
  /** The Keycloak home tenant (`tenant_id` attribute, else the user's id); null iff not_found. */
  homeTenantId: string | null;
}

/**
 * Under AUTH_BYPASS there is no real identity provider to ask: the caller is a
 * synthetic dev user and KEYCLOAK_URL is deliberately unroutable (e.g.
 * `auth.invalid`). Asking anyway turns every refresh into a 503.
 * Safe because `validateProductionConfig` (config.ts) refuses to START a
 * production deployment with AUTH_BYPASS=true, so this branch cannot run there.
 */
export function resolveUserAccountStatus(
  userId: string,
  lookup: (id: string) => Promise<'active' | 'disabled' | 'not_found'>,
): Promise<'active' | 'disabled' | 'not_found'> {
  if (process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production') {
    return Promise.resolve('active');
  }
  return lookup(userId);
}

/**
 * `resolveUserAccountStatus` for the status + home tenant pair. Under
 * AUTH_BYPASS (never in production — same guard) there is no directory, so the
 * session's own tenant is taken as current: the bypass identity is synthetic and
 * cannot be re-homed.
 */
function resolveUserAccountState(
  userId: string,
  sessionTenantId: string | null,
  lookup: (id: string) => Promise<UserAccountState>,
): Promise<UserAccountState> {
  if (process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production') {
    return Promise.resolve({ status: 'active', homeTenantId: sessionTenantId });
  }
  return lookup(userId);
}

async function signAccessToken(
  userId: string,
  tenantId?: string | null,
  tenantRoles?: readonly string[],
  superAdminSwitch = false,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // `tenant_id` is what makes tenant-scoped AG-UI actions work on the invoke
  // path, which has no Keycloak token to read the claim from. Omitted (not
  // null) when unknown, so `verifyAgentToken` can tell "pre-097 session" from
  // "explicitly tenant-less" and fall back to `getUserTenant`.
  //
  // `tenant_roles` is the same story for AUTHORIZATION, and it was missing.
  // `verifyAgentToken` reads `claims.tenant_roles` and falls back to `[]`; the
  // claim was never minted, so every agent token carried zero roles. Since
  // `agui/rbac.ts` denies a `tenant-role` rule on `!roles.includes(...)` — and
  // `defaultRule()` synthesizes `tenant-role: 'user'` for any action that
  // declares no rbac and has no projectId — that made every role-gated action
  // unreachable on /api/agui/invoke for EVERY user, super-admins included.
  // Measured on prod 2026-08-26: 5 of 107 read actions denied, one of which
  // asks only for role 'user'.
  //
  // Omitted when empty rather than sent as `[]`, matching the `tenant_id`
  // convention above: absent means "this session predates the claim", and a
  // future fallback can tell that apart from "resolved, genuinely no roles".
  const claims: Record<string, unknown> = {};
  if (tenantId) claims.tenant_id = tenantId;
  if (tenantRoles && tenantRoles.length > 0) claims.tenant_roles = [...tenantRoles];
  // George 2026-10-27: marks a session minted from a super-admin WORKSPACE
  // SWITCH, so every agent-token route re-checks it with
  // `userMaySuperAdminSwitchInto` rather than `userHomedIn` (the tenant is the
  // active workspace, not the home). Omitted otherwise.
  if (superAdminSwitch && tenantId) claims[SUPER_ADMIN_SWITCH_CLAIM] = true;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience(AGENT_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .sign(getJwtSecret());
}

interface AgentSessionRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  refresh_token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

/**
 * Mint a fresh agent session for the user. Returns the raw refresh token
 * exactly once — the caller is responsible for storing it.
 *
 * `tenantId` is the tenant the session ACTS in: the user's home, or — for a
 * super-admin whose request carried an ACCEPTED `X-Active-Tenant` switch
 * (routes/agui-session.ts) — the active workspace. A session whose tenant is
 * not the user's home is a super-admin switch session by definition, and every
 * refresh re-proves it (`refreshAgentSession`).
 */
export async function issueAgentSession(
  userId: string,
  tenantId?: string | null,
): Promise<{ sessionId: string; refreshToken: string }> {
  const rawToken = generateRawToken();
  const hash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

  const [row] = await getSql()<AgentSessionRow[]>`
    INSERT INTO agent_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
    VALUES (${userId}, ${tenantId ?? null}, ${hash}, ${expiresAt})
    RETURNING id, user_id, tenant_id, refresh_token_hash, created_at, expires_at, revoked_at, replaced_by
  `;

  if (!row) {
    throw new Error('agent_sessions insert returned no row');
  }
  return { sessionId: row.id, refreshToken: rawToken };
}

/**
 * Walk forward through `replaced_by` from the given root and revoke every
 * row in the chain (including the root). Caller must run this inside the
 * same transaction that detected the replay.
 */
async function revokeChain(
  tx: postgres.ISql,
  rootId: string,
): Promise<void> {
  // Collect the entire forward chain.
  const ids: string[] = [rootId];
  let cursor: string | null = rootId;
  while (cursor) {
    const next = (await (tx as any)`
      SELECT replaced_by FROM agent_sessions WHERE id = ${cursor}
    `) as { replaced_by: string | null }[];
    const nextId = next[0]?.replaced_by ?? null;
    if (!nextId) break;
    ids.push(nextId);
    cursor = nextId;
  }

  for (const id of ids) {
    await (tx as any)`
      UPDATE agent_sessions
         SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = ${id}
    `;
  }
}

/**
 * Exchange a raw refresh token for a short-lived FR access token. Rotates
 * the refresh token: returns the new raw refresh token in the response. If
 * the presented token has already been rotated, treat as replay — revoke
 * the full forward chain and throw ReplayDetectedError.
 */
export async function refreshAgentSession(
  refreshToken: string,
): Promise<{
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  // The identity the VERIFIED refresh token resolved to. Returned (not just
  // used to sign) so the route can attribute the request for metering — the
  // refresh leg has no bearer token, so nothing upstream of here knows who
  // the caller is. Additive; existing fields unchanged.
  userId: string;
  tenantId: string | null;
}> {
  const presentedHash = hashToken(refreshToken);

  // Replay handling is intentionally a two-step process: we DETECT replay
  // inside a tx (so the FOR UPDATE lock is held until we know what we
  // have), then COMMIT and run the chain-revoke in a second transaction.
  // If we revoked inside the same tx and threw, postgres-js would roll
  // back the revoke along with the rest.
  let replayedRootId: string | null = null;
  // Set when the session's Keycloak user is gone/disabled. Like the replay
  // path, the revoke must COMMIT before we throw, so the throw happens after
  // the transaction returns.
  let inactiveUser = false;
  // Set when the session's tenant is no longer the user's Keycloak home tenant
  // (P1-TEAM-a). Same commit-then-throw shape as `inactiveUser`.
  let tenantChanged = false;

  // The user must still exist and be enabled BEFORE a successor is minted —
  // and that Keycloak call happens BEFORE any transaction opens. It used to run
  // inside the `SELECT ... FOR UPDATE` transaction below, so a HANGING Keycloak
  // (not a refusing one) pinned a pooled connection, a pgbouncer server slot and
  // the row lock for as long as the hang lasted; ten concurrent refreshes
  // exhausted the pool and stalled issue/peek/revoke too (fr#1314 is the same
  // class: an advisory lock held across an HTTP call).
  //
  // The pre-read is a plain, lock-free SELECT. Only a row that could rotate is
  // checked — an unknown/replayed/revoked/expired token is decided by the
  // transaction exactly as before, with no directory call. The transaction then
  // re-reads the row under FOR UPDATE and refuses to rotate a row that changed
  // under it (a different row, or a different user) since the check.
  //   - deleted/disabled → the row is revoked (committed), no token issued;
  //   - Keycloak outage → throws here, no transaction was ever opened, and the
  //     presented token stays valid for a retry.
  //
  // ⛔ P1-TEAM-a: the same read also returns the user's CURRENT home tenant, and
  // a session whose tenant is no longer it is revoked (`session_tenant_changed`).
  // A Keycloak outage refuses the refresh (fail closed) exactly as above.
  const pre = (await getSql()<Pick<AgentSessionRow, 'id' | 'user_id' | 'tenant_id' | 'expires_at' | 'revoked_at' | 'replaced_by'>[]>`
    SELECT id, user_id, tenant_id, expires_at, revoked_at, replaced_by
      FROM agent_sessions
     WHERE refresh_token_hash = ${presentedHash}
  `)[0];
  let checked: {
    rowId: string;
    userId: string;
    state: UserAccountState;
    /** The row's tenant is not the home, and the user may still switch into it. */
    switchAllowed: boolean;
  } | null = null;
  if (pre && !pre.replaced_by && !pre.revoked_at && pre.expires_at.getTime() > Date.now()) {
    try {
      const state = await resolveUserAccountState(pre.user_id, pre.tenant_id ?? null, (id) => keycloak.getUserAccountState(id));
      // George 2026-10-27: a session whose tenant is not the user's home is a
      // SUPER-ADMIN WORKSPACE-SWITCH session (routes/agui-session.ts). It may
      // rotate iff the user is active, STILL holds `super_admin` (effective
      // roles, asked fresh — a refresh is rare) and the tenant is STILL a switch
      // target (`isSuperAdminSwitchTarget`, the REST gate's own predicate).
      // Anyone else — an ordinary user re-homed away from it — is revoked
      // below exactly as before (`session_tenant_changed`). The roles read
      // THROWS on an outage ⇒ SessionUserUnverifiableError, nothing rotated.
      const offHome =
        state.status === 'active' &&
        typeof pre.tenant_id === 'string' &&
        pre.tenant_id !== state.homeTenantId;
      const switchAllowed =
        offHome &&
        // session 'fr': a switch session can only have been ISSUED through the REST
        // gate for an fr super-admin session (routes/agui-session.ts).
        (await isSuperAdminSwitchTarget(pre.tenant_id as string, state.homeTenantId ?? undefined, { session: 'fr' })) &&
        hasSuperAdminRole(await keycloak.getUserEffectiveRealmRoles(pre.user_id));
      checked = { rowId: pre.id, userId: pre.user_id, state, switchAllowed };
    } catch (err) {
      console.warn('[agent-session] user status lookup failed; refresh refused', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new SessionUserUnverifiableError();
    }
  }

  // Look up + rotate atomically. The transaction holds an UPDATE row lock
  // on the presented row, so two concurrent rotations of the same token
  // serialize and the loser sees the already-revoked row on its next
  // attempt (handled as replay above).
  const result = await getSql().begin(async (tx) => {
    const rows = (await tx<AgentSessionRow[]>`
      SELECT id, user_id, tenant_id, refresh_token_hash, created_at, expires_at, revoked_at, replaced_by
        FROM agent_sessions
       WHERE refresh_token_hash = ${presentedHash}
       FOR UPDATE
    `) as AgentSessionRow[];

    const row = rows[0];
    if (!row) {
      throw new InvalidRefreshTokenError();
    }

    // Replay: this token has already been used to mint a successor.
    // Defer the chain-revoke to a second transaction (see comment above).
    if (row.replaced_by) {
      replayedRootId = row.id;
      return null;
    }

    if (row.revoked_at) {
      throw new InvalidRefreshTokenError();
    }

    if (row.expires_at.getTime() <= Date.now()) {
      throw new ExpiredError();
    }

    // The status was checked OUTSIDE this transaction (see above). Rotate only
    // the exact row/user that check was for; anything else fails closed — no
    // token is minted against a status nobody asked Keycloak about.
    if (!checked || checked.rowId !== row.id || checked.userId !== row.user_id) {
      throw new SessionUserUnverifiableError();
    }
    if (checked.state.status !== 'active') {
      await tx`
        UPDATE agent_sessions
           SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = ${row.id}
      `;
      inactiveUser = true;
      return null;
    }

    // ⛔ P1-TEAM-a: the tenant is re-derived from Keycloak on EVERY refresh. A
    // session issued for tenant A whose user now lives in B (or a pre-097 row
    // with no tenant of its own) is revoked rather than rotated: the chain ends
    // at this row, and the client must re-issue.
    const superAdminSwitch =
      checked.switchAllowed && row.tenant_id !== null && row.tenant_id !== checked.state.homeTenantId;
    if ((row.tenant_id ?? null) !== checked.state.homeTenantId && !superAdminSwitch) {
      await tx`
        UPDATE agent_sessions
           SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = ${row.id}
      `;
      tenantChanged = true;
      return null;
    }

    // Rotate: insert successor, mark current as revoked + replaced_by.
    const newRaw = generateRawToken();
    const newHash = hashToken(newRaw);
    const newExpires = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

    const inserted = (await tx<AgentSessionRow[]>`
      INSERT INTO agent_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
      VALUES (${row.user_id}, ${row.tenant_id}, ${newHash}, ${newExpires})
      RETURNING id, user_id, tenant_id, refresh_token_hash, created_at, expires_at, revoked_at, replaced_by
    `) as AgentSessionRow[];
    const newRow = inserted[0];
    if (!newRow) {
      throw new Error('agent_sessions rotate insert returned no row');
    }

    await tx`
      UPDATE agent_sessions
         SET revoked_at = now(),
             replaced_by = ${newRow.id}
       WHERE id = ${row.id}
    `;

    return { userId: row.user_id, tenantId: row.tenant_id, refreshToken: newRaw, superAdminSwitch };
  });

  if (replayedRootId !== null) {
    await getSql().begin(async (tx) => {
      await revokeChain(tx, replayedRootId as string);
    });
    throw new ReplayDetectedError();
  }

  if (inactiveUser) {
    throw new SessionUserInactiveError();
  }

  if (tenantChanged) {
    throw new SessionTenantChangedError();
  }

  if (!result) {
    // Defensive — the only `return null` path is the replay one above.
    throw new InvalidRefreshTokenError();
  }

  // Resolve realm roles at refresh rather than freezing them at session issue.
  //
  // Roles are a PRIVILEGE and they get revoked. (So is the tenant: since
  // P1-TEAM-a it is the tenant-wide project-access decision, and it was checked
  // against Keycloak above — a session whose user was re-homed never reaches
  // this line.) Re-resolving here bounds the staleness of a revoked role to one access-token
  // lifetime (ACCESS_TTL_SECONDS) instead of the whole refresh chain, and costs
  // one admin-API call per refresh rather than one per invoke.
  //
  // This needs no Keycloak *user* token — `getUserRealmRoles` is an admin-API
  // lookup keyed by user id, which is exactly why it can run on the refresh leg
  // where no Keycloak token exists. That is also why no `agent_sessions` column
  // (and no migration) is required: the row already carries `user_id`.
  //
  // `getUserRealmRoles` is non-throwing and yields `[]` when Keycloak is
  // unreachable, which fails CLOSED to precisely today's behaviour — so a
  // Keycloak blip can only reproduce the current denial, never widen access.
  const tenantRoles = await keycloak.getUserRealmRoles(result.userId);
  const accessToken = await signAccessToken(
    result.userId,
    result.tenantId,
    tenantRoles,
    result.superAdminSwitch,
  );
  return {
    accessToken,
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken: result.refreshToken,
    userId: result.userId,
    tenantId: result.tenantId,
  };
}

/**
 * Read-only: the user id owning the row for this raw refresh token, or null
 * when no row matches. Never rotates, revokes or locks — the route uses it to
 * refuse a cross-user refresh BEFORE `refreshAgentSession` mutates anything.
 * Deliberately ignores revoked/replaced/expired state: ownership of a row does
 * not change, and `refreshAgentSession` still owns every validity decision.
 */
export async function peekAgentSessionOwner(refreshToken: string): Promise<string | null> {
  const rows = (await getSql()<{ user_id: string }[]>`
    SELECT user_id FROM agent_sessions WHERE refresh_token_hash = ${hashToken(refreshToken)}
  `) as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}

/**
 * Revoke a single session by id, scoped to its owner. Does NOT walk
 * `replaced_by` (use the replay path for that). Returns true iff a row owned
 * by `userId` was revoked — callers 404 on false so one user cannot revoke
 * (or probe the existence of) another user's session by id.
 */
export async function revokeAgentSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await getSql()`
    UPDATE agent_sessions
       SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = ${sessionId} AND user_id = ${userId}
    RETURNING id
  `;
  return rows.length > 0;
}
