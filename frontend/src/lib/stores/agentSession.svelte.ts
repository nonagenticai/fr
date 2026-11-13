/**
 * Plan 3 — agent session token store.
 *
 * Lifecycle (per E-13 spec, archived in
 * `docs/archive/completed_specs/2026-04-25-e13-agent-session-token-refresh.md`):
 *   - `POST /api/agui/session/issue` — Keycloak-authed; one-time refreshToken
 *     handed out, sessionId returned. We persist (sessionId, refreshToken).
 *   - `POST /api/agui/session/refresh` — exchange refreshToken for a new
 *     access token + rotated refreshToken. The OLD refreshToken becomes
 *     unusable; reusing it is a replay (backend revokes the whole chain).
 *   - `POST /api/agui/session/:id/revoke` — cleanup on logout.
 *
 * Concurrency rule: only one refresh in flight at a time. Concurrent
 * `getAccessToken()` callers share the same in-flight promise so a burst of
 * tool-call requests doesn't spawn N parallel refresh attempts (each of
 * which would invalidate the others' refreshToken).
 *
 * Persistence: sessionId + refreshToken live in `localStorage`. The access
 * token does NOT — we re-mint it from refreshToken on every page load.
 *
 * ⛔ OWNER BINDING (cross-user leak, 2026-09-30). localStorage outlives the
 * Keycloak user: the stored session used to carry nothing tying it to the user
 * it was issued for, and logout never cleared it, so the NEXT user signing in
 * on the same browser silently inherited the previous user's agent identity —
 * observed as a first-time user seeing someone else's /threads. The stored
 * entry now records `ownerSub` (the Keycloak user id at issue time) and is
 * only ever used when it equals the CURRENT user; a mismatch, a legacy entry
 * with no owner, or an unknown current user discards it. The refresh request
 * also carries the Keycloak bearer so the backend can refuse a mismatch
 * independently (`session_user_mismatch`).
 */

import { auth } from './auth.svelte';
import { fetchWithBudget, BudgetExceededError } from '$lib/net/fetchWithBudget';

// ⚠️ `auth.svelte.ts` duplicates this literal for its logout fallback (it
// cannot import this module statically — this module imports it). Change both.
export const AGENT_SESSION_STORAGE_KEY = 'fr-agent-session-v1';
const STORAGE_KEY = AGENT_SESSION_STORAGE_KEY;
const REFRESH_LEEWAY_SEC = 30; // refresh this many seconds before expiry

// A refresh token is SINGLE-USE. It must never be sent twice — not even after
// a timeout.
//
// This used to retry the same token up to 3 times "so a flaky connection does
// not lock the user out". It did the opposite: `fetch` cannot tell "the server
// never saw it" from "the server processed it and the response was lost". When
// the first attempt HAD reached the server and rotated the token, the retry
// presented an already-rotated one — which the backend correctly treats as a
// REPLAY and responds to by revoking the entire session chain. So one slow
// response destroyed the session the retry existed to protect.
//
// Observed live 2026-08-07 while sweeping the app: a spontaneous
// `POST /api/agui/session/refresh -> 401 {"error":"refresh_token_replayed"}`
// on /threads during ordinary navigation.
//
// It also poisons a security signal: replay detection exists to flag a STOLEN
// token, and routine retries made that alarm fire in normal operation.
//
// Resilience is preserved without reuse — a transient failure now abandons the
// session and mints a brand-new one, which cannot replay by construction.
const REFRESH_BUDGET_MS = 20_000;

// ⭐ WORKSPACE BINDING (George 2026-10-27: "I just need to be able to work as a
// tenant-admin in every tenant I open"). The backend mints the agent session for
// the workspace named by `X-Active-Tenant` on `POST /api/agui/session/issue` when
// the caller is a super-admin switched into it (routes/agui-session.ts), and the
// Copilot's threads and tools then act there. A session therefore belongs to ONE
// workspace: it records the active workspace it was issued under (`tenantKey`,
// '' for "no switch") and is discarded — and a new one issued — as soon as the
// active workspace differs. Same key `auth-fetch.ts` reads for every REST call,
// so the Copilot and the page always name the same workspace.
const ACTIVE_TENANT_STORAGE_KEY = 'fr.active_tenant';

/** The stored active workspace id ('' when none) — read live, like authFetch. */
export function currentActiveTenantKey(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

interface PersistedSession {
  sessionId: string;
  refreshToken: string;
  /** Keycloak user id (`sub`) the session was issued for. */
  ownerSub: string;
  /** The active workspace (`fr.active_tenant`, '' = none) it was issued under. */
  tenantKey: string;
}

interface ActiveAccessToken {
  accessToken: string;
  expiresAtMs: number; // epoch ms
  /** Keycloak user id the token belongs to — never served to anyone else. */
  ownerSub: string;
  /** The active workspace the session was issued under — see WORKSPACE BINDING. */
  tenantKey: string;
}

/** The CURRENT Keycloak user id, or null while unknown (pre-init / signed out). */
function currentSub(): string | null {
  const id = auth.user?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function isTransientFetchError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // raw network failure
  if (err && typeof err === 'object' && 'name' in err) {
    return (err as { name: unknown }).name === 'BudgetExceededError';
  }
  return false;
}

function loadPersisted(): PersistedSession | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.ownerSub !== 'string' ||
      parsed.ownerSub.length === 0
    ) {
      // Malformed, or a LEGACY entry written before owner binding: we cannot
      // tell whose it is, so it is never used — drop it outright.
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      refreshToken: parsed.refreshToken,
      ownerSub: parsed.ownerSub,
      // An entry written before workspace binding was issued for the home
      // workspace (no header was sent), i.e. ''.
      tenantKey: typeof parsed.tenantKey === 'string' ? parsed.tenantKey : '',
    };
  } catch {
    return null;
  }
}

function savePersisted(p: PersistedSession | null): void {
  if (typeof localStorage === 'undefined') return;
  if (p === null) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

class AgentSessionState {
  persisted = $state<PersistedSession | null>(loadPersisted());
  active = $state<ActiveAccessToken | null>(null);
  /** Last error surfaced from issue/refresh/revoke (e.g. budget timeout). */
  error = $state<string | null>(null);
  /** Promise-in-flight for issue+refresh. Coalesces concurrent callers. */
  pending: Promise<string> | null = null;
  /**
   * True while recovering from a refresh with an unknown outcome. Bounds that
   * recovery to ONE attempt — a genuinely dead network would otherwise recurse
   * issue -> refresh -> issue forever. Not `$state`: purely internal control
   * flow, nothing renders from it.
   */
  private recovering = false;
  /**
   * Bumped whenever the session is revoked or discarded. An issue/refresh that
   * started under an older epoch must not persist its result — otherwise an
   * acquire in flight at logout would write the old user's session back.
   */
  private epoch = 0;
  /** Owner of the in-flight `pending` acquire; a different user never shares it. */
  private pendingOwner: string | null = null;

  /**
   * Get a usable access token. Issues a new session on first call; refreshes
   * automatically when the active token is near expiry. Throws if the user
   * is not Keycloak-authed (we can't issue an agent session without it).
   *
   * ⛔ Nothing stored is used until the current Keycloak user is known, and
   * only if it belongs to that user — see OWNER BINDING above.
   */
  async getAccessToken(): Promise<string> {
    const sub = currentSub();
    if (!sub) {
      throw new Error('Current user unknown — cannot use an agent session');
    }
    this.discardIfNotOwnedBy(sub);
    this.discardIfOtherWorkspace(currentActiveTenantKey());
    if (this.active && this.active.expiresAtMs > Date.now() + REFRESH_LEEWAY_SEC * 1000) {
      return this.active.accessToken;
    }
    if (this.pending && this.pendingOwner === sub) return this.pending;
    this.pendingOwner = sub;
    const p = this.acquire(sub).finally(() => {
      if (this.pending === p) {
        this.pending = null;
        this.pendingOwner = null;
      }
    });
    this.pending = p;
    return p;
  }

  /**
   * Drop any stored or in-memory session that does not belong to `sub`.
   * A legacy (owner-less) entry never reaches here — `loadPersisted` drops it.
   * The foreign session is NOT revoked server-side: revoke is owner-scoped, so
   * the current user's bearer would only earn a 404.
   */
  private discardIfNotOwnedBy(sub: string): void {
    const foreignPersisted = this.persisted !== null && this.persisted.ownerSub !== sub;
    const foreignActive = this.active !== null && this.active.ownerSub !== sub;
    const foreignPending = this.pending !== null && this.pendingOwner !== sub;
    if (!foreignPersisted && !foreignActive && !foreignPending) return;
    this.epoch += 1;
    this.persisted = null;
    this.active = null;
    this.pending = null;
    this.pendingOwner = null;
    savePersisted(null);
  }

  /**
   * WORKSPACE BINDING: drop a stored or in-memory session issued under another
   * active workspace, revoking it server-side best-effort (it is the current
   * user's own, so the owner-scoped revoke applies). The next `getAccessToken`
   * issues a session for `tenantKey`.
   */
  private discardIfOtherWorkspace(tenantKey: string): void {
    const otherPersisted = this.persisted !== null && this.persisted.tenantKey !== tenantKey;
    const otherActive = this.active !== null && this.active.tenantKey !== tenantKey;
    if (!otherPersisted && !otherActive) return;
    void this.revoke();
  }

  /**
   * The active workspace changed (`switchTenant`): forget the session issued for
   * the previous one now, rather than on the next agent call.
   */
  onWorkspaceSwitch(): void {
    this.discardIfOtherWorkspace(currentActiveTenantKey());
  }

  /** Forget the current session locally and revoke it server-side (logout). */
  async revoke(): Promise<void> {
    const sid = this.persisted?.sessionId;
    this.epoch += 1;
    this.persisted = null;
    this.active = null;
    this.pending = null;
    this.pendingOwner = null;
    savePersisted(null);
    if (sid) {
      try {
        await fetchWithBudget(
          `/api/agui/session/${encodeURIComponent(sid)}/revoke`,
          {
            method: 'POST',
            headers: this.keycloakHeaders(),
          },
          { fetchImpl: fetch },
        );
      } catch {
        /* best-effort */
      }
    }
  }

  // ---------- internals ----------

  /**
   * `sub` is the owner this acquire is FOR. Every await below re-checks that the
   * epoch has not moved (logout / user switch) before persisting anything.
   */
  private async acquire(sub: string): Promise<string> {
    const epoch = this.epoch;
    if (!this.persisted) {
      await this.issue(sub, epoch);
    }
    return this.refresh(sub, epoch);
  }

  /** Throw if the session was revoked/discarded since `epoch` was captured. */
  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) {
      throw new Error('agent session was revoked or changed owner during acquire');
    }
  }

  private keycloakHeaders(): HeadersInit {
    const tok = auth.getToken?.();
    if (!tok) throw new Error('Not authenticated to Keycloak — cannot issue agent session');
    return { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  }

  /**
   * Issue headers: the Keycloak bearer plus — WORKSPACE BINDING — the active
   * workspace as `X-Active-Tenant`, exactly as `authFetch` sends it, so a
   * switched super-admin's session acts in the workspace the UI shows. The
   * backend ignores it for anyone else, and refuses a super-admin's
   * non-permitted target with 403 `active_tenant_not_permitted`.
   */
  private issueHeaders(tenantKey: string): HeadersInit {
    const headers: Record<string, string> = { ...(this.keycloakHeaders() as Record<string, string>) };
    if (tenantKey) headers['X-Active-Tenant'] = tenantKey;
    return headers;
  }

  /**
   * Refresh headers. The refresh token stays the credential, but the Keycloak
   * bearer rides along when we have one, so the backend can refuse a session
   * that belongs to a different user (`session_user_mismatch`, a 401 that the
   * ordinary re-issue path below absorbs).
   */
  private refreshHeaders(): HeadersInit {
    const tok = auth.getToken?.();
    return tok
      ? { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  private async issue(sub: string, epoch: number): Promise<void> {
    const tenantKey = currentActiveTenantKey();
    let res: Response;
    try {
      res = await fetchWithBudget(
        '/api/agui/session/issue',
        {
          method: 'POST',
          headers: this.issueHeaders(tenantKey),
        },
        { fetchImpl: fetch },
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.error = 'Agent session issue timed out — check connection.';
      }
      throw err;
    }
    if (!res.ok) {
      throw new Error(`agent session issue failed: ${res.status}`);
    }
    const body = (await res.json()) as { sessionId: string; refreshToken: string };
    this.assertEpoch(epoch);
    this.persisted = { sessionId: body.sessionId, refreshToken: body.refreshToken, ownerSub: sub, tenantKey };
    savePersisted(this.persisted);
  }

  /**
   * Exchange the persisted refreshToken for an access token.
   *
   * `allowReissue` bounds the 401 recovery path to a SINGLE re-issue per
   * acquire cycle. A 401 here is the normal stale-token case — the persisted
   * token is single-use and was already rotated (commonly on first load, which
   * is why `POST /api/agui/session/refresh -> 401` is expected console noise) —
   * so we drop it, mint a new session and refresh THAT. But if the token we
   * just minted is itself rejected, the condition is not staleness and
   * re-issuing again cannot help: without this bound, refresh -> issue ->
   * refresh recursed without limit, hammering the auth endpoint under exactly
   * the failure the path exists to handle. The recursive call therefore passes
   * `false` and the second 401 fails cleanly.
   *
   * This is the 401 sibling of `recovering`, which bounds the transient-network
   * path the same way. They are separate flags on purpose: one 401 recovery and
   * one unknown-outcome recovery are each legitimate, and neither may chain.
   */
  private async refresh(sub: string, epoch: number, allowReissue = true): Promise<string> {
    this.assertEpoch(epoch);
    if (!this.persisted) throw new Error('No persisted agent session to refresh');
    if (this.persisted.ownerSub !== sub) {
      // Defensive: getAccessToken already discarded a foreign session.
      throw new Error('agent session belongs to a different user');
    }
    const presented = this.persisted;

    let res: Response;
    try {
      res = await fetchWithBudget(
        '/api/agui/session/refresh',
        {
          method: 'POST',
          headers: this.refreshHeaders(),
          body: JSON.stringify({ refreshToken: presented.refreshToken }),
        },
        { fetchImpl: fetch, hardTimeoutMs: REFRESH_BUDGET_MS },
      );
    } catch (err) {
      // Transient failure = UNKNOWN outcome. The rotation may already have
      // happened server-side, so this token can never be safely presented
      // again. Abandon it and mint a fresh session instead of replaying.
      // `recovering` bounds this to a single attempt so a genuinely dead
      // network cannot recurse.
      if (isTransientFetchError(err) && !this.recovering) {
        this.assertEpoch(epoch);
        return this.reissueAfterUnknownOutcome(err, sub, epoch);
      }
      throw err;
    }
    this.assertEpoch(epoch);

    if (res.status === 401) {
      // Either the token was already rotated (the ordinary first-load case),
      // reused (replay detected) or revoked — force re-issue. ONCE.
      if (!allowReissue) {
        // A session we minted moments ago was rejected on its first use. Another
        // issue would be rejected the same way, so stop here instead of looping.
        this.error = 'Agent session rejected immediately after issue — re-authenticate.';
        throw new Error('agent session refresh failed: 401 after re-issue');
      }
      this.persisted = null;
      savePersisted(null);
      this.active = null;
      await this.issue(sub, epoch);
      return this.refresh(sub, epoch, false);
    }
    if (!res.ok) {
      throw new Error(`agent session refresh failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      accessToken: string;
      expiresIn: number;
      refreshToken: string;
    };
    this.assertEpoch(epoch);
    this.persisted = {
      sessionId: presented.sessionId,
      refreshToken: body.refreshToken,
      ownerSub: sub,
      tenantKey: presented.tenantKey,
    };
    savePersisted(this.persisted);
    this.active = {
      accessToken: body.accessToken,
      expiresAtMs: Date.now() + body.expiresIn * 1000,
      ownerSub: sub,
      tenantKey: presented.tenantKey,
    };
    this.error = null;
    return body.accessToken;
  }

  /**
   * Recover from a refresh whose outcome we cannot determine. Drops the
   * possibly-rotated token, issues a new session, and refreshes that. Never
   * re-sends the old token, so it cannot trigger replay revocation.
   */
  private async reissueAfterUnknownOutcome(
    cause: unknown,
    sub: string,
    epoch: number,
  ): Promise<string> {
    this.recovering = true;
    try {
      this.persisted = null;
      savePersisted(null);
      this.active = null;
      await this.issue(sub, epoch);
      // `false`: this session was minted a moment ago, so a 401 on it is not
      // the stale-token case and a further re-issue cannot help.
      return await this.refresh(sub, epoch, false);
    } catch (err) {
      this.error =
        (cause as { name?: unknown })?.name === 'BudgetExceededError'
          ? 'Agent session refresh timed out — check connection.'
          : 'Agent session refresh failed — check connection.';
      throw err;
    } finally {
      this.recovering = false;
    }
  }
}

export const agentSession = new AgentSessionState();
