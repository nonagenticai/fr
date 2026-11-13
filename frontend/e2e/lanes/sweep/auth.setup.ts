// e2e/lanes/sweep/auth.setup.ts
//
// Performs ONE real Keycloak authorization-code browser login against
// production and saves the resulting browser session to a Playwright
// `storageState` file, so the 168-route sweep can run as a genuinely
// logged-in user.
//
// WHY A REAL LOGIN AND NOT TOKEN INJECTION
// ----------------------------------------
// `src/lib/services/keycloak.ts` inits keycloak-js with `onLoad:'login-required'`
// and keeps the access token in MEMORY ONLY — there is no token in localStorage
// or a cookie to plant. `VITE_AUTH_BYPASS` is guarded on `import.meta.env.DEV`
// and is dead-code-eliminated from the production bundle. So the only door is
// the front one. What the saved state actually carries is the Keycloak SSO
// cookies on the auth host (KEYCLOAK_IDENTITY / KEYCLOAK_SESSION); on each
// later `page.goto`, keycloak-js redirects, Keycloak recognises those cookies
// and completes the code flow SILENTLY, minting a fresh in-memory token per
// page. That is why cookies are sufficient even though the token never is.
//
// WHAT THIS PROVES
// ----------------
// That a real, server-recognised session exists for FR_SWEEP_USER, and that the
// authenticated fr shell rendered for that user at least once.
//
// WHAT THIS DOES **NOT** PROVE
// ----------------------------
// Nothing about authorisation. It says nothing about whether this user may see
// any particular route: per-route role gates (`super_admin`), workspace/tenant
// scoping (`X-Active-Tenant`) and the license gate are all evaluated per page
// and are entirely unexercised here. A sweep run on this state can legitimately
// record "Not found" / empty surfaces on routes this user simply lacks — those
// are authorisation outcomes, not UI findings, and must be read as such.
//
// FAILURE POSTURE: LOUD, NEVER ANONYMOUS
// --------------------------------------
// Every precondition throws. There is deliberately no fallback path in which
// this file completes without a session — an anonymous sweep would walk 168
// routes, be bounced to Keycloak on every one, and report 168 login redirects
// as if they were findings. A red setup is the correct outcome; a green
// unauthenticated one is the failure we are engineering against.
//
// ⛔ The password is never logged, echoed, embedded in an error message, or
// written to disk. Every message below names only the ENV VAR, never a value.
//
// Plain `@playwright/test`, not ../../support/fixtures: the FailureGate fails on the first console.error, and
// a third-party login page is not ours to keep console-clean.
import { test as setup, expect, type Page, type Locator } from '@playwright/test';

/**
 * Reads every required env var and throws ONCE naming all of the missing ones,
 * so a misconfigured run is fixed in a single pass rather than one var per
 * attempt. Values are never included in the message.
 */
function requireEnv<K extends string>(names: readonly K[]): Record<K, string> {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `[sweep auth] refusing to run: required env var(s) unset or empty: ${missing.join(', ')}. ` +
        'This setup exists so the sweep runs AUTHENTICATED; it will not fall through to an ' +
        'anonymous run, which would report every login redirect as a finding. ' +
        'Set FR_SWEEP_USER, FR_SWEEP_PASS, FR_SWEEP_STATE (output path) and E2E_BASE_URL.',
    );
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]!.trim()])) as Record<K, string>;
}

/** Host of a URL, or a throw naming the var that held an unparseable value. */
function hostOf(url: string, varName: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`[sweep auth] ${varName} is not a parseable absolute URL.`);
  }
}

/**
 * First locator in `candidates` that actually resolves to a visible element,
 * waiting up to `timeoutMs` in total. Returns null rather than throwing so the
 * caller can decide whether the absence is fatal (password field missing) or
 * expected (identity-first flow: password lives on the SECOND page).
 *
 * Self-describing by construction: each candidate is a real selector string, so
 * a failure message can name exactly which ones were tried.
 */
async function firstVisible(
  candidates: readonly Locator[],
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const c of candidates) {
      // .first() — Keycloak's password field is accompanied by a
      // show/hide toggle, and strict mode would otherwise reject the match.
      const el = c.first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return null;
}

// --- Keycloak login-theme markup we target -----------------------------------
// Targeted at the STOCK Keycloak login theme (`base`/`keycloak` login.ftl, and
// its PatternFly successor `keycloak.v2` used from KC 24+). Both render the same
// stable ids inside `form#kc-form-login`:
//
//     <input id="username" name="username" type="text">
//     <input id="password" name="password" type="password">
//     <input id="kc-login"  name="login"   type="submit" value="Sign In">
//
// The ids survived the v2 rewrite; the CSS classes did not, which is why every
// locator below keys on id/name/role and never on a class. `getByLabel` is tried
// FIRST so a localised or lightly re-themed deployment still matches, with the
// id/name selectors as the fallback.
const usernameLocators = (p: Page) => [
  p.getByLabel(/username|e-?mail/i),
  p.locator('#username'),
  p.locator('input[name="username"]'),
];
const passwordLocators = (p: Page) => [
  p.getByLabel(/password/i),
  p.locator('#password'),
  p.locator('input[name="password"]'),
];
const submitLocators = (p: Page) => [
  p.locator('#kc-login'),
  p.locator('input[name="login"]'),
  p.locator('button[name="login"]'),
  p.locator('#kc-form-login button[type="submit"], #kc-form-login input[type="submit"]'),
  p.getByRole('button', { name: /sign in|log ?in|continue|next/i }),
];

// The authenticated fr shell. `header-controls` is the andon + liveness control
// group in $lib/components/Header.svelte, mounted by src/routes/+layout.svelte
// ONLY inside the `{:else if auth.isAuthenticated}` branch — i.e. it cannot
// render for an anonymous or still-loading visitor. Existing testid, not
// invented. (`header-user-name` sits beside it but is `lg:inline-block`, hidden
// below the lg breakpoint, so it is the wrong thing to gate on.)
const AUTH_SHELL_TESTID = 'header-controls';

// The IdP's host, compared as a HOST and never as a substring of a URL.
const KEYCLOAK_HOST = 'auth.nonagentic.ai';

setup('authenticate against production Keycloak and save storageState', async ({ page }) => {
  // A human-speed IdP round trip plus the SPA's own boot; generous but bounded.
  setup.setTimeout(180_000);

  const env = requireEnv(['FR_SWEEP_USER', 'FR_SWEEP_PASS', 'FR_SWEEP_STATE', 'E2E_BASE_URL'] as const);
  const appHost = hostOf(env.E2E_BASE_URL, 'E2E_BASE_URL');

  // 1. Land on the app. The SPA boots, keycloak-js sees no session and issues a
  //    TOP-LEVEL navigation to the IdP.
  await page.goto(env.E2E_BASE_URL, { waitUntil: 'domcontentloaded' });

  // 2. Wait for the IdP. Asserted on the HOST, not on "the URL changed" — a
  //    client-side route change inside the app also changes the URL.
  await page.waitForURL(/^https:\/\/auth\.nonagentic\.ai\//, { timeout: 60_000 });

  // 3. Username. Its absence is fatal and names the selectors tried, because
  //    "login failed" without that list is unactionable at 2am.
  const username = await firstVisible(usernameLocators(page), 30_000);
  if (!username) {
    throw new Error(
      '[sweep auth] no username field on the Keycloak page. Tried: getByLabel(/username|email/i), ' +
        '#username, input[name="username"]. The login theme may have been replaced — re-read the ' +
        'rendered markup before changing these selectors.',
    );
  }
  await username.fill(env.FR_SWEEP_USER);

  // 4. Password. May be on this page (stock single-page form) or behind a
  //    submit in an identity-first flow, so try here, then advance and retry.
  let password = await firstVisible(passwordLocators(page), 2_000);
  if (!password) {
    const advance = await firstVisible(submitLocators(page), 10_000);
    if (!advance) {
      throw new Error(
        '[sweep auth] no password field and no submit control to advance to one. Tried password: ' +
          'getByLabel(/password/i), #password, input[name="password"]; submit: #kc-login, ' +
          'input[name="login"], button[name="login"], #kc-form-login [type=submit].',
      );
    }
    await advance.click();
    password = await firstVisible(passwordLocators(page), 30_000);
    if (!password) {
      throw new Error(
        '[sweep auth] password field never appeared after advancing the identity-first form. ' +
          'Tried: getByLabel(/password/i), #password, input[name="password"].',
      );
    }
  }
  // ⛔ `fill` only. Never interpolate FR_SWEEP_PASS into a log line, an error,
  //    a screenshot annotation, or a URL.
  await password.fill(env.FR_SWEEP_PASS);

  // 5. Submit.
  const submit = await firstVisible(submitLocators(page), 15_000);
  if (!submit) {
    throw new Error(
      '[sweep auth] no submit control on the Keycloak login form. Tried: #kc-login, ' +
        'input[name="login"], button[name="login"], #kc-form-login [type=submit], ' +
        'getByRole(button, /sign in|log in|continue|next/i).',
    );
  }
  await submit.click();

  // 6. Return leg. Wait for the app host specifically — NOT merely "some
  //    navigation happened". A wrong password keeps us on the IdP with an error
  //    banner, and this is the assertion that catches it.
  await page.waitForURL((url) => url.host === appHost, { timeout: 60_000 });

  // 7. POSITIVELY assert the session is real. Two independent claims:
  //    (a) we are NOT on the IdP, and (b) the authenticated shell rendered.
  //    (a) alone is satisfied by any bounce back to the app; (b) alone could in
  //    principle be satisfied mid-redirect. Both together is a session.
  // ⚠️ COMPARE THE HOST, NEVER THE URL STRING. The first version of this line
  //    was `expect(page.url()).not.toContain('auth.nonagentic.ai')`, and it
  //    FAILED on a login that had entirely succeeded: the OIDC response comes
  //    back as a FRAGMENT on the app host —
  //    `https://fr.nonagentic.ai/#state=…&iss=https%3A%2F%2Fauth.nonagentic.ai%2Frealms%2Fportal&code=…`
  //    — so the IdP's name is present in the URL of every successful login.
  //    A substring test over a whole URL cannot tell "I am on the IdP" from
  //    "the IdP told me who it was", and it reported a working session as
  //    rejected credentials.
  expect(
    new URL(page.url()).host,
    'ended on the Keycloak host — credentials rejected or the flow did not complete',
  ).not.toBe(KEYCLOAK_HOST);

  // If this times out and the page shows the license block, the session IS real
  // but this tenant's license is expired/revoked (+layout.svelte renders
  // <LicenseBlocked/> INSTEAD of the shell, so Header never mounts). Fix the
  // license — do not weaken this assertion; a sweep behind a license block
  // measures the block, not the app.
  await expect(
    page.getByTestId(AUTH_SHELL_TESTID),
    `authenticated shell ([data-testid="${AUTH_SHELL_TESTID}"], mounted only in +layout.svelte's ` +
      'auth.isAuthenticated branch) never rendered — the redirect completed but no session took',
  ).toBeVisible({ timeout: 60_000 });

  // 8. Pin the ACTIVE WORKSPACE before capturing state.
  //
  //    fr scopes almost every read to `localStorage('fr.active_tenant')`, which
  //    `$lib/api/auth-fetch.ts` reads live on every request and forwards as
  //    X-Active-Tenant. Left unset, the sweep lands on whatever workspace the
  //    switcher defaults to, and ~70 dynamic routes are then handed ids that
  //    were measured in a DIFFERENT tenant. Those routes 404 — and a 404 caused
  //    by my own tenant mismatch is indistinguishable, in the artifact, from a
  //    genuinely broken detail page. Pinning it is what makes the ids and the
  //    session describe the same world.
  //
  //    ⚠️ Consequence to state in any report: the sweep therefore measures this
  //    workspace, not the operator's own. Super-admin is what makes the switch
  //    legal at all (backend/src/middleware/request-context.ts).
  const sweepTenant = process.env.FR_SWEEP_TENANT;
  if (sweepTenant) {
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      ['fr.active_tenant', sweepTenant] as const,
    );
    expect(
      await page.evaluate(() => window.localStorage.getItem('fr.active_tenant')),
      'active workspace did not persist — the sweep would run against the wrong tenant',
    ).toBe(sweepTenant);
  }

  // 9. Save. Cookies (the Keycloak SSO cookies on the auth host) + per-origin
  //    localStorage. No token is captured because none exists on disk to
  //    capture — see the header note.
  await page.context().storageState({ path: env.FR_SWEEP_STATE });
});
