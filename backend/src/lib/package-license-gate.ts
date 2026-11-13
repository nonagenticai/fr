/**
 * Package-license gate decision logic (pure, side-effect-free).
 *
 * fr-backend's one image serves BOTH products, and each DEPLOYMENT enables only
 * its own gate flag (`fr/fr` sets FR_LICENSE_GATE_ENABLED=true; `kag-frontend/kag`
 * sets KAG_LICENSE_GATE_ENABLED=true). On every `/api/*` request, `server.ts`
 * calls `enforcePackageLicense`, which uses the predicates here to decide whether
 * the per-tenant entitlement check (`requireFrLicense` / `requireKagLicense`)
 * should run at all.
 *
 * ⚠️ The product is chosen from the DEPLOYMENT (`servingAppKey`), not from the
 * request. The public VirtualServices do `set` (overwrite) `X-App-Key`, but the
 * mesh-internal host `fr-backend.example.com` does not and ext_authz does not strip
 * it — so a client-supplied header used to be able to select the sibling product
 * whose gate is disabled here, skipping the licence check entirely. The rule
 * that closes it (`resolveAppKey`) is CONFIRM-ONLY: the header may agree with
 * the serving key or be ignored, and can never change the product.
 *
 * There are TWO orthogonal exemption axes — a request is exempt if EITHER holds:
 *
 *  1. ROUTE is platform-global or SPA bootstrap (`isRouteExempt`) — identity
 *     bootstrap, the user's own profile/licenses, webhooks, internal SA routes,
 *     and platform-wide pricing admin (global billing config, super-admin-gated).
 *
 *  2. TENANT is an internal platform tenant (`isInternalTenant`) — the `system`
 *     + improvement-loop workspaces are NOT licensable fr/kag customers; they are
 *     the platform's own infrastructure tenants. Only a super-admin (via the
 *     X-Active-Tenant switch gate in middleware/request-context.ts) or an internal
 *     service account ever resolves `ctx.tenantId` to one of these, and every
 *     route keeps its own authz. Without this axis a super-admin operating the
 *     system/improvement workspaces gets `fr_license_required` on the global app
 *     shell (andon, kanban liveness, cards, …).
 *
 * Keeping this logic in one tested module (rather than inline in the 2k-line
 * server.ts) is what makes both axes regression-safe.
 */

import { isInternalTenant } from '../middleware/internal-tenant-only';

// Route prefixes exempt from the package-license gate. The gate keys on the
// end-user's tenant; these are either (a) needed to bootstrap the SPA enough to
// render the "no license" state, or (b) machine / SA-authed callers that are not
// an end user using the package (those carry no user tenant, so the gate skips
// them anyway — listing them is belt-and-suspenders + makes the intent explicit),
// or (c) platform-global config that is not a per-tenant package feature.
export const FR_LICENSE_EXEMPT_PREFIXES = [
  '/api/auth/', // identity bootstrap (/api/auth/me)
  '/api/me/', // the user's own profile / licenses / usage — needed for the no-license screen
  '/api/webhooks/', // n8n / signal / telegram / teams / email — own auth
  '/api/internal/', // internal / SA-authed service routes
  // Platform-wide pricing management (billing provider_pricing / markup_rules).
  // Global billing config, not a per-tenant package feature; handlers gate on
  // requireSuperAdmin. Scoped to /pricing/ only — other /api/admin/* routes
  // (departments, assets) are legitimately tenant-scoped + fr-gated.
  '/api/admin/pricing/',
  // Early-access signup v2: two service-account doors (intake, Telegram decision — a service
  // account has no fr tenant to licence) and the super_admin onboarding queue (platform-global,
  // every handler re-gates). Off unless FR_SIGNUP_ENABLED=true.
  '/api/signup-approvals/',
] as const;

export const FR_LICENSE_EXEMPT_EXACT = new Set<string>([
  '/api/license/status', // the gate's own status probe (handled pre-match in server.ts)
  '/api/project-requests', // CP→fr bridge intake (SA-authed, machine-to-machine)
  '/api/signup-approvals', // early-access queue list (super_admin; see the prefix above)
  // Frontend error sink. Unauthenticated by design: the errors worth the most
  // are the ones during login/boot, when there is no token and therefore no
  // tenant. The gate already no-ops without a user tenant; this entry makes the
  // intent explicit so a future change to that default cannot silently 403 the
  // only channel through which client-side bugs are visible at all.
  '/api/client-errors',
]);

/** True when the ROUTE is exempt from the package-license gate (axis 1). */
export function isRouteExempt(pathname: string): boolean {
  if (FR_LICENSE_EXEMPT_EXACT.has(pathname)) return true;
  return FR_LICENSE_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * True when the package-license gate should NOT run for this request — either
 * the route is exempt (axis 1) or the tenant is an internal platform tenant
 * (axis 2). App-agnostic: the same exemptions apply to fr and kag.
 */
export function isPackageLicenseExempt(
  pathname: string,
  tenantId: string | null | undefined,
): boolean {
  return isRouteExempt(pathname) || isInternalTenant(tenantId ?? undefined);
}

export type AppKey = 'fr' | 'kag';

/** Which package gates are ENABLED on this deployment (from config). */
export interface PackageGateFlags {
  readonly fr: boolean;
  readonly kag: boolean;
}

/**
 * Which product THIS deployment serves — derived ONLY from the gate flags.
 *
 * Exactly-one-enabled names that product. Both-off (dev, CI, the prod-boot-shape
 * test) and both-on fall back to `'fr'` — the historical default — so the
 * derivation never throws and never changes behaviour for a deployment that
 * gates nothing.
 *
 * ⛔ There is deliberately NO env override. `PACKAGE_APP_KEY` used to win here
 * unconditionally, with no cross-check against the flags: setting it to `kag` on
 * the fr Deployment (`FR_LICENSE_GATE_ENABLED=true`) made every request resolve
 * to `kag`, whose flag is off there, so `packageGateDecision` returned `'skip'`
 * for every tenant on every route — a silent, fleet-wide gate kill-switch, with
 * no boot log and no 403. It was set nowhere in gitops and the derivation
 * already covers both prod shapes, so it was deleted outright. If a future
 * deployment genuinely needs to pin an identity independently of the flags,
 * re-add it WITH a cross-check (refuse a key whose own gate is off while a
 * sibling's is on) and a loud boot log — never as a bare override.
 *
 * ⚠️ Both-on is a misconfiguration, not a supported shape: this returns `'fr'`,
 * and because `resolveAppKey` is confirm-only, such a deployment serves fr to
 * everyone — kag-entitled callers are DENIED, never silently let through. One
 * deployment serves one product; a second product needs a second deployment.
 */
export function servingAppKey(gates: PackageGateFlags): AppKey {
  if (gates.kag && !gates.fr) return 'kag';
  return 'fr';
}

/**
 * Render an attacker-controlled header value for a log line: JSON-quoted (so
 * newlines, quotes and control characters are escaped rather than injecting
 * fake log records) and hard-truncated.
 *
 * `resolveAppKey` runs on an UNAUTHENTICATED path, so without this an anonymous
 * caller could write ~8 KB of arbitrary text — including forged log lines — into
 * stdout → Loki on every request. The sanitising happens HERE, not at the log
 * site, so the raw value never escapes this module and no caller can get it
 * wrong.
 */
export function sanitizeHeaderForLog(raw: string): string {
  return JSON.stringify(raw).slice(0, 40);
}

/**
 * Resolve the request's app key.
 *
 * ⛔ The `X-App-Key` header is NOT trustworthy. On the public hosts the
 * VirtualService `set`s (overwrites) it, but the mesh-internal host
 * (`fr-backend.example.com`) does not, and the header is not in the ext_authz
 * strip list — so any in-mesh caller can supply it.
 *
 * Rule: CONFIRM-ONLY. The header may only AGREE with the key this deployment
 * serves; it can never change the product. Anything else — unknown value,
 * absent header, or a key naming the sibling product — resolves to the serving
 * key, and the rejected value is returned (never thrown) so the caller can log
 * it exactly once.
 *
 * ⛔ Do NOT "allow a key whose gate is ENABLED". That was the first attempt and
 * it is a hole of its own: `gates.kag === true` is evidence that SOMEONE is
 * entitled to kag, never that THIS caller is. With both flags on, `X-App-Key:
 * kag` would yield `require-kag` only — so a tenant holding kag but not fr (a
 * real, named population: the kag-frontend-only users) would walk into every fr
 * route. Multi-flag-on is also the prescribed future shape for a shared
 * deployment, which would make that the default posture, not an edge case.
 *
 * Nothing legitimate is lost: on the kag deployment `X-App-Key: kag` still
 * matches via `requested === serving`.
 */
export function resolveAppKey(
  req: Request,
  serving: AppKey,
): { appKey: AppKey; rejectedHeaderForLog?: string } {
  const raw = req.headers.get('x-app-key');
  // `.trim()` is NOT redundant with WHATWG Headers' own normalisation: that
  // strips only HTTP whitespace (SP/TAB/CR/LF). U+00A0 and friends survive it
  // and reach here, and without the trim a merely padded but legitimate
  // `X-App-Key` would be "rejected" — writing a warn line per request on an
  // unauthenticated path. Pinned in package-license-gate.test.ts.
  if (raw === null || raw.trim() === '') return { appKey: serving };
  const requested = raw.trim().toLowerCase();
  if (requested === serving) return { appKey: serving };
  return { appKey: serving, rejectedHeaderForLog: sanitizeHeaderForLog(raw) };
}

/**
 * The ONE derivation of `(appKey, gateEnabled)` for a request — shared by the
 * enforcing gate and by the `/api/license/status` probe.
 *
 * These two MUST agree. The status probe is what the post-merge live proof
 * drives, so a divergence would let that probe report a fix that is not in the
 * enforcer. Deriving both from this single function is what makes the agreement
 * structural rather than a convention; `packageRequestView`'s contract test
 * pins `gateEnabled === (packageGateDecision(...) !== 'skip')` on every
 * non-exempt request.
 */
export interface PackageRequestView {
  readonly appKey: AppKey;
  readonly gateEnabled: boolean;
  /** Already sanitised for logging — see `sanitizeHeaderForLog`. */
  readonly rejectedHeaderForLog?: string;
}

export function packageRequestView(
  req: Request,
  gates: PackageGateFlags,
  serving: AppKey,
): PackageRequestView {
  const { appKey, rejectedHeaderForLog } = resolveAppKey(req, serving);
  return {
    appKey,
    gateEnabled: appKey === 'kag' ? gates.kag : gates.fr,
    ...(rejectedHeaderForLog !== undefined ? { rejectedHeaderForLog } : {}),
  };
}

/**
 * The single decision seam for the package-license gate: given the resolved app
 * key, the route, the tenant and this deployment's gate flags, say whether the
 * side-effecting entitlement check should run and which one.
 *
 * With BOTH flags off this returns `'skip'` for every input — that is what keeps
 * the blast radius of the app-key hardening at zero for dev and CI. A disabled flag is a rollout lever, never a DENY.
 */
export function packageGateDecision(
  appKey: AppKey,
  pathname: string,
  tenantId: string | null | undefined,
  gates: PackageGateFlags,
): 'skip' | 'require-fr' | 'require-kag' {
  if (isPackageLicenseExempt(pathname, tenantId)) return 'skip'; // app-agnostic
  if (appKey === 'kag') return gates.kag ? 'require-kag' : 'skip';
  return gates.fr ? 'require-fr' : 'skip';
}
