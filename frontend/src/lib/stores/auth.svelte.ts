// src/lib/stores/auth.svelte.ts
import {
  initKeycloak,
  login as keycloakLogin,
  logout as keycloakLogout,
  getToken as getKeycloakToken,
  ensureFreshToken as ensureFreshKeycloakToken,
  getUserInfo,
  isAuthenticated as checkAuth,
  hasRole as checkRole,
  manageAccount as openAccountManagement,
} from '$lib/services/keycloak';
import { apiClient } from '$lib/api/unified-client';
import { listMyDeptRoles, type DeptRole } from '$lib/api/me-roles';
import { getSuperAdminStatus } from '$lib/api/super-admin';
import { authFetch } from '$lib/api/auth-fetch';
import { hasSuperAdmin } from '$lib/utils/auth-guards';
import {
  SESSIONS_KEY as KAG_SESSIONS_KEY,
  ACTIVE_KEY as KAG_ACTIVE_KEY,
  RESEARCH_KEY,
} from '$lib/kag/sessionPersistence';

// Spec 1 §11 — typed role surface.
//   Tenant ("workspace") roles come from the ACTIVE workspace's row in
//   `GET /api/me/workspaces` (pushed in via `setActiveWorkspaceRole`), NOT from
//   the claim. The backend stamps `workspace-admin` there for a `user_roles`
//   grant OR for the Keycloak realm role `tenant_admin` whose raw `tenant_id`
//   claim is that workspace. Authenticated users with no admin role default to
//   `workspace-member`. Anonymous users get `[]`.
//
//   Dept roles come from the backend `department_members` table via
//   `GET /api/me/dept-roles`, which is LIVE
//   (`backend/src/routes/me/dept-roles.ts`, routed in `backend/src/server.ts`).
//
//   ⚠️ CORRECTED — this said the endpoint was "added in Wave 3" and that a
//   404/501 falls back to `{}` because it might be missing. It is not missing,
//   and that fallback hid a real defect: the route answers `{ data: {...} }`,
//   the client returned the envelope verbatim, and so `_deptRoles` was
//   `{ data: … }` and EVERY `hasDeptRole()` lookup returned false. See
//   `$lib/api/me-roles.ts` for the full account.
//
//   A read failure still leaves `_deptRoles = {}` — fail-closed is correct for
//   a permission gate — but `listMyDeptRoles` now throws on 404 instead of
//   absorbing it, so `fetchDeptRoles()` logs rather than manufacturing "this
//   user belongs to no department" out of an outage.
export type TenantRole = 'workspace-admin' | 'workspace-member';
export type { DeptRole };

// Hierarchy: dept-viewer < dept-member < dept-manager < dept-admin.
// The numeric rank lets `hasDeptRole(deptId, min)` answer "≥ min" cheaply.
const DEPT_ROLE_RANK: Record<DeptRole, number> = {
  'dept-viewer': 0,
  'dept-member': 1,
  'dept-manager': 2,
  'dept-admin': 3,
};

// License types
// License state lives in the authoritative `licenseGate` store
// (stores/licenseGate.svelte.ts), fed by the app-scoped `GET /api/license/status`.
// AuthState is identity-only.

// User type

export interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions?: string[];
  tenant_id: string;
  tenant_name: string | null;
  /** GET /api/auth/me — false on an instance without the v4 conveyor wiring. */
  conveyor_configured?: boolean;
}

// ⛔ Agent-session teardown on logout (cross-user leak, 2026-09-30).
//
// The agent session's refresh token lives in localStorage and outlives the
// Keycloak user; `agentSession.revoke()` had NO callers, so the next user of
// the same browser inherited the previous user's agent identity (/threads).
//
// The store is loaded with a DYNAMIC import: `agentSession.svelte.ts` imports
// this module, so a static import back would be a cycle. Dynamic import also
// means logout works on a page that never loaded the agent store — the key is
// still in localStorage from an earlier page, so it is cleared here directly
// as well. Must equal `AGENT_SESSION_STORAGE_KEY` in agentSession.svelte.ts.
const AGENT_SESSION_STORAGE_KEY = 'fr-agent-session-v1';
/** Upper bound on how long logout waits for the best-effort server revoke. */
export const AGENT_SESSION_REVOKE_GUARD_MS = 1_500;

function clearAgentSessionStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(AGENT_SESSION_STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing persisted to clear */
  }
}

// Per-user UI state persisted in localStorage that must not survive into the
// NEXT user of the same browser: the active workspace (it is sent as
// X-Active-Tenant on every request), the per-tenant selected project, the
// command-palette recents, and the KAG discover / research session ids.
const USER_LOCAL_KEYS = [
  'fr.active_tenant',
  'fr.cmdk.recents',
  KAG_SESSIONS_KEY,
  KAG_ACTIVE_KEY,
  RESEARCH_KEY,
] as const;
const USER_LOCAL_PREFIXES = ['fr.selected_project:'] as const;

/** Forget the signed-in user's persisted UI state. Never throws. */
export function clearUserLocalState(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    for (const key of USER_LOCAL_KEYS) localStorage.removeItem(key);
    const prefixed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && USER_LOCAL_PREFIXES.some((p) => k.startsWith(p))) prefixed.push(k);
    }
    for (const k of prefixed) localStorage.removeItem(k);
  } catch {
    /* storage unavailable — nothing persisted to clear */
  }
}

/**
 * Best effort, bounded, never throws: revoke the agent session server-side and
 * forget it locally. A slow or failing revoke must never block logout.
 */
async function endAgentSession(): Promise<void> {
  // NOT cleared up front: if the agent store has not been loaded on this page
  // yet, it reads the session id FROM this entry, and clearing first would
  // leave nothing to revoke server-side. `revoke()` clears it synchronously
  // itself; the `finally` below covers an import that fails or hangs.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const revoke = import('./agentSession.svelte').then(({ agentSession }) => agentSession.revoke());
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, AGENT_SESSION_REVOKE_GUARD_MS);
    });
    await Promise.race([revoke.catch(() => undefined), guard]);
  } catch {
    /* best effort */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    clearAgentSessionStorage();
    clearUserLocalState();
  }
}

// Auth state
export class AuthState {
  isAuthenticated = $state(false);
  user = $state<User | null>(null);
  isLoading = $state(true);
  error = $state<string | null>(null);

  // True from the moment "Log out" is clicked until the end-session document
  // navigation replaces this page. The redirect-to-login guards (root +layout's
  // auth $effect, /login's onMount) MUST bail out while this is set — see the
  // note on `logout()` below.
  isLoggingOut = $state(false);

  // Super-admin network-probe fallback. Sourced from `GET /api/me/super-admin`
  // (populated after sign-in) and dev-bypass. Fail-closed: any error or
  // non-2xx leaves it `false`. The `isSuperAdmin` derived below prefers the
  // `super_admin` realm role and falls back to this probe — the probe still
  // covers super-admins surfaced only by the backend env allowlist during the
  // realm-role migration, plus dev-bypass.
  private _superAdminProbe = $state(false);

  // Typed role surface (Plan 2 follow-up).
  //   `_deptRoles` is the writable backing store; `deptRoles` exposes a
  //   read-only view (typed `Readonly<Record<...>>`). We populate from
  //   `/api/me/dept-roles` on `initialize()` and `refresh()`.
  private _deptRoles = $state<Record<string, DeptRole>>({});

  // Derived state - Roles
  isAdmin = $derived(
    this.user?.roles.includes('admin') ?? false
  );

  isPowerUser = $derived(
    this.user?.roles.includes('power-user') ?? false
  );

  canManageProjects = $derived(
    this.isAdmin || this.isPowerUser
  );

  // Super-admin: the `super_admin` Keycloak realm role (instant, straight from
  // the token) OR the backend probe (`_superAdminProbe`). The role path is the
  // durable signal (survives identity changes); the probe is the migration-era
  // fallback for env-allowlist-only super-admins and dev-bypass. The backend is
  // always the real gate — this only governs UI visibility.
  isSuperAdmin = $derived(
    hasSuperAdmin(this.user) || this._superAdminProbe
  );

  /**
   * The caller's role in the ACTIVE workspace, pushed by the workspaces store
   * from `GET /api/me/workspaces`. Same push pattern as `_deptRoles`.
   */
  _activeWorkspaceRole = $state<string | undefined>(undefined);

  /** Called by the workspaces store on load, switch and reset. */
  setActiveWorkspaceRole(role: string | undefined): void {
    this._activeWorkspaceRole = role;
  }

  // Tenant roles for the ACTIVE workspace.
  //
  // ⚠️ This used to read `realm_access.roles` for `workspace-admin` /
  // `workspace-member`. Those are NOT Keycloak realm roles and never have
  // been: `super-admin.ts` writes them to fr's OWN `user_roles` table and its
  // comment says outright they are "a different axis from the Keycloak realm
  // role provisioning assigns". Verified against the live portal realm — its
  // role set is {tenant_admin, super_admin, member, …} with no
  // `workspace-admin` — and `services/keycloak.ts` populates `user.roles` from
  // `realm_access.roles` only. So the claim check could never match and
  // `hasTenantRole('workspace-admin')` was ALWAYS false for every real user,
  // silently locking the 11 people who hold `workspace-admin` in `user_roles`
  // out of /settings/admin, the Settings admin nav entry, /channels and the
  // llm-provider write path. Only super-admins ever got in.
  //
  // The role now comes from what the BACKEND gates on — a `user_roles` row
  // (`userRolesService.hasRole(user.id, activeTenant, …)`) OR the realm role
  // `tenant_admin` pinned to the raw `tenant_id` claim (`isRealmTenantAdminOf`),
  // both folded into the `/api/me/workspaces` row — scoped to the same active
  // workspace, so the UI predicts the API instead of contradicting it.
  // `super_admin_scope` is deliberately NOT admin here. Since George 2026-10-27
  // the backend no longer sends it to a super-admin: every row it offers them
  // is `workspace-admin` (they are tenant-admin of every workspace they switch
  // into), so a super-admin's tenant gates read this same role.
  tenantRoles = $derived.by((): readonly TenantRole[] => {
    if (!this.isAuthenticated || !this.user) return [];
    const role = this._activeWorkspaceRole;
    // `rolePrecedence` in backend/src/lib/accessible-tenants.ts ranks only
    // 'workspace-admin' (100) and 'workspace-member' (50); migration 104's CHECK
    // forbids a DB 'admin' role, so the API never sends it. The 'admin' arm is
    // frontend-side tolerance only, not a mirror of the backend.
    if (role === 'workspace-admin' || role === 'admin') return ['workspace-admin'];
    return ['workspace-member'];
  });

  // Dept roles map (read-only view of the backing state).
  get deptRoles(): Readonly<Record<string, DeptRole>> {
    return this._deptRoles;
  }

  // Membership helpers ------------------------------------------------------

  hasTenantRole(role: TenantRole): boolean {
    return this.tenantRoles.includes(role);
  }

  hasDeptRole(deptId: string, min: DeptRole): boolean {
    const have = this._deptRoles[deptId];
    if (!have) return false;
    return DEPT_ROLE_RANK[have] >= DEPT_ROLE_RANK[min];
  }

  hasAnyDeptAdminRole(): boolean {
    for (const r of Object.values(this._deptRoles)) {
      if (r === 'dept-admin') return true;
    }
    return false;
  }

  // Deployment posture from GET /api/auth/me `conveyor_configured` (George
  // 2026-10-13): an instance without the v4 conveyor wiring (kag) answers every
  // project-create door 503 `conveyor_not_configured`, so the create UI is
  // hidden there. ONLY an explicit `false` hides it: before /me lands (or if it
  // failed) the UI stays as it was, and the server's 503 is the real enforcer.
  get conveyorCreationDisabled(): boolean {
    return this.user?.conveyor_configured === false;
  }

  // Check if user has a specific permission
  hasPermission = $derived.by(() => (permission: string): boolean => {
    return this.user?.permissions?.includes(permission) ?? false;
  });

  // Idempotent init, and the ONLY thing a `load()` function may await.
  //
  // `initialize()` is started from the root +layout's `onMount`, which SvelteKit
  // runs AFTER every `load`. So a guard that judges `auth.isAuthenticated`
  // inside `load` on a cold page load reads the pre-init `false` and bounces a
  // legitimate user — that is the deep-link bug: paste or refresh any guarded
  // URL and you land somewhere else. Three files carry comments telling you to
  // work around it ("never gate in load(): it races auth.initialize()" —
  // routes/operate/+page.ts, (admin)/admin/(platform)/licenses/+layout.svelte,
  // routes/login/+page.svelte). Awaiting this instead lets the first caller
  // START init and everyone else share the same promise, so gating in `load` is
  // safe and the later `onMount` call is a no-op rather than a second Keycloak
  // handshake.
  private _initPromise: Promise<void> | null = null;

  // Monotonic generation counter guarding `fetchWorkspaceInfo()` against a
  // stale response overwriting a newer identity. `Promise.race` in
  // `switchTenant` (frontend/src/lib/actions/switchTenant.ts) does NOT cancel
  // the losing fetch — a `GET /api/me/workspace` that outlives the 5s race
  // bound keeps running, and used to write `this.user` unconditionally
  // whenever it finally landed. Sequence: switch A→B, B's fetch hangs past the
  // timeout so the race resolves on the timeout branch and `goto` fires
  // anyway; switch B→C starts a fresh fetch; B's fetch THEN resolves and, pre-
  // fix, clobbered `this.user` with B's tenant_id/tenant_name —
  // silently restoring the old workspace identity while the UI/route already show C.
  // Not caller-specific: bumped by both `fetchWorkspaceInfo()` itself (so each
  // call claims a fresh generation before it even sends the request) and by
  // `resetIdentityForSwitch()` (so a fetch already in flight when a NEW switch
  // starts is invalidated even if that switch never starts a fetch of its
  // own, e.g. it fails before reaching step 7). A response is applied only if
  // no later generation has started by the time it resolves.
  private workspaceFetchSeq = 0;

  ensureInitialized(): Promise<void> {
    this._initPromise ??= this.initialize();
    return this._initPromise;
  }

  // Initialize authentication
  async initialize() {
    this.isLoading = true;
    this.error = null;

    try {
      const authenticated = await initKeycloak();

      if (authenticated) {
        this.isAuthenticated = true;
        const baseUser = getUserInfo() as User;
        // Provide safe defaults for workspace fields before the fetch lands.
        this.user = {
          ...baseUser,
          tenant_id: baseUser.tenant_id ?? '',
          tenant_name: baseUser.tenant_name ?? null,
        };

        if (import.meta.env.DEV) console.debug('Auth initialized');

        // Dev-only AUTH_BYPASS — inject a synthetic super-admin claim and
        // skip the IdP-token-dependent fetches. Backend honours
        // AUTH_BYPASS=true symmetrically (backend/src/middleware/auth.ts).
        // The `import.meta.env.DEV` guard makes Vite dead-code-eliminate
        // this branch in production builds (verify: `grep -r
        // VITE_AUTH_BYPASS frontend/build/` after `pnpm build` is empty).
        if (
          import.meta.env.DEV &&
          import.meta.env.VITE_AUTH_BYPASS === 'true'
        ) {
          this.applyDevBypass();
        } else {
          // Fetch additional user details. License state is owned by the
          // licenseGate store (loaded by the root +layout), not here.
          await this.fetchUserDetails();
          await this.fetchDeptRoles();
          await this.fetchSuperAdminStatus();
          await this.fetchWorkspaceInfo();
        }
      } else {
        this.isAuthenticated = false;
        this.user = null;
      }
    } catch (err) {
      console.error('Failed to initialize auth:', err);
      this.error = err instanceof Error ? err.message : 'Authentication failed';
      this.isAuthenticated = false;
      this.user = null;
    } finally {
      this.isLoading = false;
    }
  }

  // Login
  async login() {
    try {
      await keycloakLogin();
    } catch (err) {
      console.error('Login failed:', err);
      this.error = err instanceof Error ? err.message : 'Login failed';
      throw err;
    }
  }

  // Logout. What matters is that NOTHING triggers a competing top-level
  // navigation while the Keycloak end-session redirect is in flight.
  //
  // `isAuthenticated` is $state, and tearing it down here used to schedule two
  // reactions on the very next microtask — while the end-session navigation was
  // still only pending: the root +layout's auth $effect ran `goto('/login')`,
  // and /login's onMount then ran `auth.login()`. That second top-level
  // navigation SUPERSEDED the end-session one, so the Keycloak SSO cookie was
  // never cleared and the authorize request silently re-authenticated the user
  // — landing them back on /login with a fresh `#code=`, still signed in. On
  // the no-license block screen that is a trap: "Log out" is the only exit.
  //
  // So: raise `isLoggingOut` FIRST (it is what those two guards check), and do
  // not touch `isAuthenticated` until the redirect has been handed off. There
  // is no authed-UI flash to worry about — the document is being replaced.
  async logout() {
    this.isLoggingOut = true;
    // Must run BEFORE the end-session redirect: the server-side revoke needs
    // the Keycloak bearer, and the page is gone once the redirect lands.
    await endAgentSession();
    try {
      await keycloakLogout();

      // Reached only once the redirect is under way (or in tests). Safe now:
      // the guards above stay suppressed by `isLoggingOut`.
      this.isAuthenticated = false;
      this.user = null;
      this._deptRoles = {};
      this._superAdminProbe = false;
    } catch (err) {
      // No redirect is happening, so release the guards — otherwise a failed
      // logout permanently disables the app's auth redirects.
      this.isLoggingOut = false;
      console.error('Logout failed:', err);
      this.error = err instanceof Error ? err.message : 'Logout failed';
      throw err;
    }
  }

  // Refresh user info and token. Re-pull dept roles and workspace info too
  // so role grants and operator state taken since sign-in are reflected.
  async refresh() {
    if (checkAuth()) {
      this.isAuthenticated = true;
      const baseUser = getUserInfo() as User;
      // `conveyor_configured` is DEPLOYMENT posture from GET /api/auth/me, not
      // a token claim, so getUserInfo() never carries it and a token refresh
      // cannot change it. Carry it over, or the create UI hidden on an
      // unwired instance reappears after the first refresh.
      const conveyorConfigured = this.user?.conveyor_configured;
      this.user = {
        ...baseUser,
        tenant_id: baseUser.tenant_id ?? '',
        tenant_name: baseUser.tenant_name ?? null,
        ...(conveyorConfigured !== undefined ? { conveyor_configured: conveyorConfigured } : {}),
      };
      await this.fetchDeptRoles();
      await this.fetchWorkspaceInfo();
    } else {
      this.isAuthenticated = false;
      this.user = null;
      this._deptRoles = {};
      this._superAdminProbe = false;
    }
  }

  // Check if user has a specific role
  hasRole(role: string): boolean {
    return checkRole(role);
  }

  // Open account management
  manageAccount() {
    openAccountManagement();
  }

  // Get current token — reads live from keycloak so refreshes are picked up
  // immediately. Caching the token at login time produced JWTExpired bursts.
  getToken(): string | undefined {
    return getKeycloakToken();
  }

  // Refresh the token if it expires within `minValidity` seconds, then return
  // it. For long-lived consumers (the kanban WS reconnect) that cannot rely on
  // an HTTP call having refreshed it recently.
  ensureFreshToken(minValidity = 30): Promise<string | undefined> {
    return ensureFreshKeycloakToken(minValidity);
  }

  // Fetch user details from backend
  async fetchUserDetails() {
    try {
      const userDetails = await apiClient.getCurrentUser() as any;

      // Merge with existing user data
      if (this.user && userDetails) {
        this.user = {
          ...this.user,
          ...(userDetails as Partial<User>),
          permissions: userDetails.permissions || []
        };
      }

      // The user object carries email, roles and tenant ids — never log it in prod.
      if (import.meta.env.DEV) console.log('User details fetched:', this.user);
    } catch (err) {
      console.error('Failed to fetch user details:', err);
      // Non-critical error, don't throw
    }
  }

  // Fetch the typed dept-role map for the signed-in user from the LIVE
  // `GET /api/me/dept-roles`.
  //
  // ⚠️ CORRECTED — this said "the backend endpoint is added in Wave 3; until
  // then `listMyDeptRoles()` swallows 404/501 and returns `{}`". The endpoint
  // shipped, and the swallow is gone: a 404 now throws and lands in the catch
  // below, where it is LOGGED. That matters because the two outcomes are
  // indistinguishable in this store's state — `{}` means both "no memberships"
  // and "we could not read them" — so the log is the only place the difference
  // survives.
  //
  // ⛔ `{}` on failure is DELIBERATE and must stay: `hasDeptRole` is a
  // permission gate, and a gate that opens when its input is unreadable is the
  // fail-open shape. Nothing renders this map as a positive claim ("you belong
  // to no departments"); its only consumers are gates
  // (`$lib/rbac/canEditScheduledTrigger.ts`). If a surface ever DISPLAYS the
  // map, it needs a third state — unknown — because an empty map would then be
  // an absence rendered as a measurement.
  async fetchDeptRoles(): Promise<void> {
    try {
      this._deptRoles = await listMyDeptRoles();
    } catch (err) {
      console.error('Failed to fetch dept roles:', err);
      this._deptRoles = {};
    }
  }

  // Spec 2 Task 6 — best-effort super-admin probe. Fail-closed: any error
  // (network, 401, 403, 5xx) leaves `isSuperAdmin = false`, hiding the UI
  // entry point. The backend is the actual gate.
  async fetchSuperAdminStatus(): Promise<void> {
    try {
      const { is_super_admin } = await getSuperAdminStatus();
      this._superAdminProbe = is_super_admin === true;
    } catch (err) {
      console.warn('Failed to fetch super-admin status:', err);
      this._superAdminProbe = false;
    }
  }

  // Dev-only synthetic state used when VITE_AUTH_BYPASS is on. Mirrors
  // backend/src/middleware/auth.ts: same dev UUID + roles, plus the
  // `workspace-admin` realm role and `isSuperAdmin = true` that the real
  // path would have come from `/api/me/super-admin`. License state is owned
  // by the licenseGate store; with the gate disabled in dev the backend
  // `/api/license/status` reports `state:'active'`, so no stub is needed here.
  private applyDevBypass(): void {
    const DEV_UUID = '00000000-0000-0000-0000-000000000000';
    this.user = {
      id: DEV_UUID,
      email: 'dev@localhost',
      name: 'Dev User',
      roles: ['admin', 'power-user', 'workspace-admin'],
      permissions: [],
      tenant_id: DEV_UUID,
      tenant_name: 'dev',
    };
    this._superAdminProbe = true;
    this._deptRoles = {};
  }

  // Library tenant-scoping Task 2 — fetch workspace identity from
  // `GET /api/me/workspace`. Merges tenant_id / tenant_name onto
  // `this.user`.
  //
  // ⚠️ CALLER CONTRACT — this method is NOT fail-closed by itself. On any
  // error, or a non-ok response, it leaves `this.user` UNCHANGED: it has no
  // way to know what a safe fallback value is, so it does not guess one. That
  // reads as "fail-closed" only for a caller whose `this.user` already holds
  // safe defaults at the moment it calls in — `initialize()` and `refresh()`
  // both do, because they just repopulated `this.user` from `getUserInfo()`
  // immediately before calling this, so "unchanged on error" means "still the
  // safe default". `switchTenant` (frontend/src/lib/actions/switchTenant.ts)
  // is a THIRD caller where `this.user` can already hold the PREVIOUS
  // tenant's `tenant_id`/`tenant_name` — for that one, unchanged-on-error
  // would mean STILL the old tenant's identity, so the caller resets to
  // safe defaults itself first, via `resetIdentityForSwitch()` below.
  //
  // ⚠️ STALE-RESPONSE CONTRACT — this method is also not cancellation-safe by
  // itself: `switchTenant` races it against a timeout, and losing the race
  // does not stop the underlying request. `mine` claims this call's
  // generation before the request is even sent; if `workspaceFetchSeq` has
  // moved on by the time the response lands — because a NEWER
  // `fetchWorkspaceInfo()` call claimed a later generation, or
  // `resetIdentityForSwitch()` bumped it directly — this response belongs to
  // a switch that is no longer current and is dropped silently, leaving
  // whatever the newer generation already wrote in place.
  //
  // ⛔ LATENT HAZARD — do NOT add a concurrent caller without revisiting this.
  // The generation is claimed UNCONDITIONALLY at call start, regardless of how
  // the call later ends. So if two UNRELATED callers overlap, a LATER call
  // that then errors or returns non-ok still invalidates an EARLIER call whose
  // response was good — and that good response is dropped as "stale" while
  // the later one writes nothing, leaving `this.user` holding whatever it held
  // before either call. That is correct for `switchTenant` (the newer switch
  // really is the truth) but WRONG for two independent refreshes of the SAME
  // tenant. It is unreachable today, verified 2026-09-14: `initialize()` is
  // deduped through `_initPromise`, and `refresh()` has NO live callers in
  // frontend/src. The moment `refresh()` is wired up to anything that can run
  // alongside a switch or another refresh, either claim the generation only
  // for switch-initiated fetches, or have a failed newer call not supersede a
  // successful older one.
  async fetchWorkspaceInfo(): Promise<void> {
    const mine = ++this.workspaceFetchSeq;
    try {
      const ws = await authFetch('/api/me/workspace');
      if (ws.ok) {
        const data = await ws.json();
        if (mine !== this.workspaceFetchSeq) return; // stale — see contract above
        if (this.user) {
          this.user = {
            ...this.user,
            tenant_id: typeof data?.tenant_id === 'string' ? data.tenant_id : '',
            tenant_name: typeof data?.tenant_name === 'string' ? data.tenant_name : null,
          };
        }
      }
      // else: non-ok response — `this.user` is left unchanged, see the
      // caller-contract note above.
    } catch {
      // network error / thrown — `this.user` is left unchanged, see the
      // caller-contract note above.
    }
  }

  /**
   * Reset workspace identity to safe defaults for `nextTenantId` —
   * the tenant id being switched TO. Called by `switchTenant`
   * (frontend/src/lib/actions/switchTenant.ts) BEFORE it calls
   * `fetchWorkspaceInfo()` for the new tenant, so that a failed, non-ok, or
   * merely slow refresh all land safe BY CONSTRUCTION: `fetchWorkspaceInfo()`
   * leaves `this.user` unchanged whenever it doesn't get a good response, so
   * whatever is already sitting in `this.user` when it is called is exactly
   * what survives a bad refresh.
   *
   * `tenant_id` moves to
   * `nextTenantId` — the one fact already known, since the switch itself
   * named it — rather than keep asserting the OLD tenant's id. `tenant_name`
   * goes to `null`: the display name for `nextTenantId` isn't known until the
   * fetch lands, and keeping the OLD tenant's name would misrepresent the
   * (now active) new tenant as the one just left.
   *
   * Also bumps `workspaceFetchSeq` — see the stale-response contract on
   * `fetchWorkspaceInfo()`. This switch may be starting a fresh
   * `fetchWorkspaceInfo()` call right after (which bumps again and claims its
   * own generation), but it does not have to: bumping here unconditionally
   * means a PRIOR switch's still-in-flight fetch is invalidated the moment
   * this one begins, even if this switch's own fetch never gets a chance to
   * start.
   */
  resetIdentityForSwitch(nextTenantId: string): void {
    if (!this.user) return;
    this.workspaceFetchSeq++;
    this.user = {
      ...this.user,
      tenant_id: nextTenantId,
      tenant_name: null,
    };
  }
}

// Export singleton instance
export const auth = new AuthState();