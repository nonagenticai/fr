// src/lib/services/keycloak.ts
import Keycloak from 'keycloak-js';
import { isKagHost, KAG_KEYCLOAK_CLIENT_ID } from '$lib/product';

// One fr-frontend image serves two products (fr + kag) off different hosts.
// `url` + `realm` are identical for both (auth.nonagentic.ai / portal); only
// the Keycloak CLIENT differs per host. The client is baked at build time via
// VITE_KEYCLOAK_CLIENT_ID (fr's client) — but keycloak-js only initialises
// client-side, so we can resolve the kag client from the host at runtime and
// no rebuild / Keycloak admin change is needed (both clients already trust
// their own host). See $lib/product.
export function resolveClientId(): string {
  if (typeof window !== 'undefined' && isKagHost(window.location.hostname)) {
    return KAG_KEYCLOAK_CLIENT_ID;
  }
  return import.meta.env.VITE_KEYCLOAK_CLIENT_ID;
}

// Keycloak configuration from environment variables (clientId host-resolved).
const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL,
  realm: import.meta.env.VITE_KEYCLOAK_REALM,
  clientId: resolveClientId(),
};

// Create Keycloak instance
export const keycloak = new Keycloak(keycloakConfig);

// Single-flight init promise. SvelteKit `+page.ts:load()` runs BEFORE
// the layout's onMount calls `auth.initialize()`, so any client-side
// fetch fired during a page load (e.g. /workflows' Promise.all over
// listWorkflows + listTags) would observe `keycloak.authenticated ===
// false` and drop the Bearer header → backend returns 401. Capturing
// the init promise here lets `ensureFreshToken` await it instead of
// returning undefined prematurely.
let initPromise: Promise<boolean> | undefined;

// Single-flight guard for the login redirect. Declared here (rather than beside
// `startLogin`) because `initKeycloak` arms it. See `startLogin` for the why.
let loginRedirectStarted = false;

// Initialize Keycloak
export async function initKeycloak(): Promise<boolean> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dev mode: bypass Keycloak entirely. Gated on DEV so the bypass branch
    // is dead-code-eliminated from production builds — without the DEV guard,
    // any prod build with VITE_AUTH_BYPASS=true at build time would auto-auth
    // as admin (same shape as w2v_frontend#32).
    if (import.meta.env.DEV && import.meta.env.VITE_AUTH_BYPASS === 'true') {
      // Trilogy-demo / dev seeder support: VITE_AUTH_BYPASS_USER_ID +
      // VITE_AUTH_BYPASS_TENANT_ID let the bypass user inhabit a non-
      // default tenant. Must match the backend's AUTH_BYPASS_USER_ID /
      // AUTH_BYPASS_TENANT_ID env so frontend tenant_id and backend
      // tenantId agree on every request.
      const bypassUserId =
        import.meta.env.VITE_AUTH_BYPASS_USER_ID ??
        '00000000-0000-0000-0000-000000000000';
      const bypassTenantId =
        import.meta.env.VITE_AUTH_BYPASS_TENANT_ID ??
        '00000000-0000-0000-0000-000000000000';
      console.warn('[AUTH BYPASS] Keycloak disabled — using mock dev user');
      (keycloak as any).authenticated = true;
      (keycloak as any).token = 'dev-bypass-token';
      (keycloak as any).tokenParsed = {
        sub: bypassUserId,
        email: 'dev@localhost',
        name: 'Dev User',
        preferred_username: 'dev',
        tenant_id: bypassTenantId,
        // Mirrors backend/src/middleware/auth.ts `bypassUser()`. The two MUST
        // agree: the frontend gates the Administration rail on `super_admin`
        // while the backend gates the routes behind it, so a mismatch renders a
        // sidebar whose every link 403s. Gated on `import.meta.env.DEV`, so this
        // branch is dead-code-eliminated from any production build.
        realm_access: {
          roles: ['admin', 'power-user', 'super_admin', 'workspace-admin'],
        },
      };
      return true;
    }

    try {
      // `onLoad: 'login-required'` means "redirect to Keycloak NOW if there is
      // no session", and that redirect is issued by the SDK itself rather than
      // through `startLogin()`. Arm the single-flight flag across the call so a
      // racing `login()` cannot supersede it and overwrite `redirect_uri` with
      // a later URL; if a session DOES exist, init resolves normally and the
      // flag is released below. See the comment on `loginRedirectStarted`.
      loginRedirectStarted = true;
      const authenticated = await keycloak.init({
        onLoad: 'login-required',
        pkceMethod: 'S256',
        checkLoginIframe: false,
        silentCheckSsoFallback: false,
      });
      // Reached only when init did NOT navigate away.
      loginRedirectStarted = false;

      // Strip the OAuth fragment params (`#state=…&session_state=…&iss=…&code=…`)
      // that Keycloak leaves on the URL after a successful redirect-flow init.
      // keycloak-js *usually* clears the hash itself, but on a hot SPA
      // navigation that races with onLoad the fragment can stick around and
      // pollute the visible URL bar (observed on /workflows post-login).
      if (typeof window !== 'undefined' && window.location.hash.includes('state=')) {
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + window.location.search,
        );
      }

      if (authenticated) {
        console.log('User is authenticated');
      } else {
        console.log('User is not authenticated');
      }

      return authenticated;
    } catch (error) {
      // init THREW, so it did not navigate away either. Release the guard or a
      // failed init (Keycloak unreachable, clock skew, bad config) would wedge
      // login permanently: every later `login()` would no-op and the user would
      // sit on a blank page with no way to authenticate and nothing in the UI
      // to say why. Failing to reach the IdP must stay retryable.
      loginRedirectStarted = false;
      console.error('Failed to initialize Keycloak:', error);
      throw error;
    }
  })();

  return initPromise;
}

// Refresh the access token if it expires within `minValidity` seconds, then
// return the live token. Callers should invoke this on every outbound request
// so the attached Bearer is always current — caching the value at login time
// produced JWTExpired bursts ~5min after sign-in.
export async function ensureFreshToken(minValidity = 30): Promise<string | undefined> {
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_BYPASS === 'true') {
    return keycloak.token;
  }
  // Wait out any in-flight Keycloak init. If the layout hasn't called
  // initKeycloak yet (early `+page.ts:load` racing onMount), kick it
  // off — `onLoad: 'login-required'` will redirect to Keycloak when
  // there's no session.
  if (initPromise) {
    await initPromise;
  } else {
    await initKeycloak();
  }
  if (!keycloak.authenticated) {
    return undefined;
  }
  try {
    await keycloak.updateToken(minValidity);
  } catch {
    startLogin();
    return undefined;
  }
  return keycloak.token;
}

// Refresh UNCONDITIONALLY — ignoring how much validity this client believes is
// left — and return the new token.
//
// `ensureFreshToken` is the normal path and is not sufficient on its own: it
// refreshes only when the token expires inside `minValidity`, and "still valid
// for another 40 seconds" is a claim made by THIS clock. A browser clock ahead
// of Keycloak's, a laptop resuming from sleep, or a token the server has
// already stopped accepting all produce a token the client keeps believing in
// and the server keeps rejecting with
// `JWTExpired: "exp" claim timestamp check failed`.
//
// Measured on prod 2026-09-10 (pod fr-859f796c55-kcv5j): 118 of 187
// `GET /api/cards/<id>` requests in ONE hour answered 401 with exactly that
// error, on a portal token whose `exp - iat` is 300 (a 5-minute access token),
// unbroken to the last line of the log. A caller that only ever asks its own
// clock "is this still valid?" can never leave that state. The only exit is to
// refresh in response to the SERVER's verdict — which is what this exists for,
// and why `authFetch` calls it on a 401 (see auth-fetch.ts).
//
// `updateToken(-1)` is keycloak-js's documented force: a negative minValidity
// refreshes regardless of remaining lifetime.
export async function forceRefreshToken(): Promise<string | undefined> {
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_BYPASS === 'true') {
    return keycloak.token;
  }
  if (initPromise) {
    await initPromise;
  } else {
    await initKeycloak();
  }
  if (!keycloak.authenticated) {
    return undefined;
  }
  try {
    await keycloak.updateToken(-1);
  } catch {
    // The refresh token is gone too (SSO session ended, refresh expired,
    // Keycloak unreachable). Same handling as `ensureFreshToken`: start the
    // login redirect once, and report "no token" so the caller stops rather
    // than retrying into a wall.
    startLogin();
    return undefined;
  }
  return keycloak.token;
}

// A Keycloak login is a TOP-LEVEL navigation, and keycloak-js computes
// `redirect_uri` from `window.location.href` at the moment it is called. The
// SPA keeps running while that navigation is pending, so a second `login()`
// from any other in-flight path issues its own navigation, ABORTS the first,
// and wins with whatever URL the router has settled on by then.
//
// Measured live 2026-08-27: a cold `/admin/andon` produced two auth requests —
// `redirect_uri=/admin/andon` (correct, `net::ERR_ABORTED`) followed by
// `redirect_uri=/admin/home`. Every `/admin/*` deep link therefore landed on
// Overview after sign-in, which read as "the deep-link fix didn't work" even
// though the guard and `?next` were both doing their job.
//
// First call wins: it is the one that still knows where the user was going.
// Mirrors the `isLoggingOut` guard in routes/login/+page.svelte, which already
// stops a login from superseding an in-flight end-session navigation.
function startLogin(): Promise<void> | undefined {
  if (loginRedirectStarted) return undefined;
  loginRedirectStarted = true;
  return keycloak.login();
}

// Login
export function login() {
  return startLogin();
}

// Logout via Keycloak end-session. Passing redirectUri ensures the
// post-logout return URL is honored AND the SDK appends id_token_hint when a
// token is present, so the SSO session is cleanly invalidated. Without it,
// some browsers retained the upstream cookie.
export function logout(redirectUri?: string) {
  const target = redirectUri ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  return keycloak.logout(target ? { redirectUri: target } : undefined);
}

// Get access token
export function getToken(): string | undefined {
  return keycloak.token;
}

// Check if user is authenticated
export function isAuthenticated(): boolean {
  return keycloak.authenticated ?? false;
}

// Get user info
export function getUserInfo() {
  return {
    id: keycloak.tokenParsed?.sub,
    email: keycloak.tokenParsed?.email,
    name: keycloak.tokenParsed?.name || keycloak.tokenParsed?.preferred_username,
    roles: keycloak.tokenParsed?.realm_access?.roles || [],
  };
}

// Check if user has a specific role
export function hasRole(role: string): boolean {
  const roles = keycloak.tokenParsed?.realm_access?.roles || [];
  return roles.includes(role);
}

// Account management
export function manageAccount() {
  return keycloak.accountManagement();
}