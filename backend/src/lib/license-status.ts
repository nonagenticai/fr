// src/lib/license-status.ts
//
// Rich, app-scoped license STATUS for the SPA (backs `GET /api/license/status`).
//
// The per-request ENFORCEMENT gate (`require-fr-license.ts` /
// `require-kag-license.ts`) is a fast cached boolean and stays untouched. This
// module adds the detail the frontend needs to render an accurate experience:
// distinguish active / expiring-soon / expired / revoked / none and surface the
// expiry date — so an expired tenant gets a clear "renew" block instead of a
// broken shell or raw 403 toasts.
//
// Why the two-call shape: the licenses service `GET /licenses/active` returns
// 200 ONLY for a currently-active license (with `expires_at`); expired, revoked
// and never-had all collapse to 404. So to tell them apart we fall back to the
// subject's license inventory (`/licenses/user/{sub}`) and read the record's
// `status` / `expires_at` / `revoked_at`.
//
// Fail-soft: on any upstream error this returns `state:'unknown'` (NOT a hard
// block) — the per-request 403 (`fr_license_required`) remains the real-time
// enforcer, so a transient licenses blip never hard-blocks an entitled user.
//
// ⚠️ `none` is TERMINAL and USER-HOSTILE: the SPA lists it in BLOCKED_STATES
// (frontend/src/lib/stores/licenseGate.svelte.ts) and renders a full-screen
// block. `unknown` does not. So the two states are NOT interchangeable, and the
// rule this module now enforces is:
//
//     return `none` only on POSITIVE evidence of no entitlement;
//     absence of evidence is `unknown`.
//
// This was live on 2026-08-06: an entitled super-admin on tenant …0099 saw
// `hasLicense:false, state:'none'` while every gated `/api/*` route served them
// 200, and the SPA hard-blocked them until a pod roll. The enforcer was RIGHT
// and this probe was WRONG. The asymmetry is caching, not logic:
// `require-fr-license.ts` answers from a 1h Redis positive cache, whereas this
// module read `/licenses/active` live and un-retried — so one lagging replica,
// one cold cache, or one partial outage converted "I could not see it" into a
// terminal lockout. Two paths did that, both fixed below:
//   1. a missing `subjectId` produced an EMPTY inventory, which read as `none`
//      — a lockout derived from an auth defect, not from any license fact;
//   2. a 404 + empty inventory went straight to `none` with nothing corroborating it.
// Both now yield `unknown`, and (2) additionally consults the enforcer's cached
// verdict: if the enforcer is currently serving this tenant, a contradicting
// `none` is downgraded rather than shown.
//
// This CANNOT open an enforcement hole. `unknown` only relaxes the SPA shell;
// every gated route still calls the fail-closed `requireFrLicense`, and a
// genuinely unlicensed tenant has no positive cache entry, so it still gets the
// terminal `none` and still gets blocked.
//
// ── The INTERNAL-TENANT axis (2026-09-14) ────────────────────────────────────
//
// The 2026-08-06 fix above assumed the probe and the enforcer disagree only
// through CACHING. There is a second, structural way to disagree, and it locked
// a super-admin out of `/approvals` on tenant …0002:
//
//   - `/api/approvals?status=pending` → 200, rows stamped tenant …0002;
//   - `/api/license/status`           → hasLicense:false, state:'none' → wall.
//
// Both surfaces resolve the tenant from the SAME place — `ctx.tenantId` in
// `server.ts` (`:3130` for the gate, `:3034` for this probe), which is the
// header-overridden effective tenant. Tenant resolution is NOT the asymmetry.
//
// The asymmetry is that the ENFORCER's decision runs through
// `packageGateDecision` → `isPackageLicenseExempt` (lib/package-license-gate.ts
// :84), which has TWO exemption axes, and this probe implemented only one of
// them. Axis 2 is `isInternalTenant`: the four reserved `0195f48b-d000-7000-
// 8000-*` workspaces (system + workflow-/prompt-/procedure-improvement) are the
// platform's OWN infrastructure tenants, not licensable fr/kag customers. The
// enforcer therefore SKIPS the entitlement check for them entirely — it never
// calls `tenantHasFrLicense`, so it also never writes the positive cache entry
// that `peekEnforcerVerdict` looks for. That is why the 2026-08-06 downgrade
// could not save this case: the enforcer holds no verdict here because it was
// never asked, and a cold cache is indistinguishable from a denied one.
//
// So the probe asked the licenses service whether an INFRASTRUCTURE tenant holds
// an `fr` licence, got the truthful "no" it will always get, and rendered a
// terminal wall describing a gate that does not exist for this tenant.
//
// ⭐ WHICH SIDE IS AUTHORITATIVE: the ENFORCER, always. `packageGateDecision` is
// what actually admits or denies the request; this module only describes that
// posture to the SPA. `server.ts:3020` already names the invariant — a probe
// that "report[s] a posture the enforcer does not hold" is the defect. So the
// tenant axis is mirrored here from the same `isInternalTenant` predicate the
// enforcer imports (package-license-gate.ts:38), NOT re-derived from a local
// list, so the two sets cannot drift apart.
//
// ⛔ The ROUTE axis (`isRouteExempt`) is deliberately NOT mirrored. This probe
// answers "what posture will the gated routes hold for me", not "is THIS
// endpoint gated" — and `/api/license/status` is itself route-exempt, so
// folding axis 1 in would report `active` to everyone, unconditionally.
//
// This CANNOT open an enforcement hole either. The new branch changes no
// enforcement: `requireFrLicense` is untouched and the gate was ALREADY skipping
// these four tenant ids before this commit. It fires only for a tenant the
// enforcer itself exempts, and `ctx.tenantId` can only BE one of those four via
// `buildRequestContext`'s override, which requires a SIGNED `super_admin` (or
// `aa-orchestrator`) realm role. Every other tenant — including the execution
// tenant …0003, which the same workspace switcher can also select — still walks
// the full licence lookup and still gets a terminal `none` when unlicensed.

import {
  licensesClient,
  type ActiveLicenseDetail,
  type LicenseRecord,
} from '../services/licenses';
import { redis } from '../services/redis';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
// ⛔ The SAME predicate `lib/package-license-gate.ts:38` imports for the
// enforcer's tenant exemption axis. Importing it (rather than re-listing the
// four uuids here) is what makes probe/enforcer agreement structural: adding or
// removing an internal tenant moves both at once.
import { isInternalTenant } from '../middleware/internal-tenant-only';

export type LicenseStatusState =
  | 'active'
  | 'expiring_soon'
  | 'expired'
  | 'revoked'
  | 'none'
  | 'unknown';

export interface LicenseStatusResult {
  state: LicenseStatusState;
  /** Whether the tenant holds a currently-active license for the app. */
  hasLicense: boolean;
  /** ISO expiry of the relevant license, or null (perpetual / unknown). */
  expiresAt: string | null;
  /** Whole days until expiry (negative = days since expiry), or null. */
  daysRemaining: number | null;
  /** Plan code of the relevant license, when known. */
  planCode: string | null;
}

/** Days before expiry at which an active license is flagged expiring-soon. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * The non-blocking "we could not establish entitlement" result.
 *
 * Every path that lacks POSITIVE evidence of no-entitlement returns this rather
 * than `none`. `unknown` is absent from the SPA's BLOCKED_STATES, so it degrades
 * to "let the real enforcer decide per request" instead of locking the shell.
 */
const UNKNOWN: LicenseStatusResult = {
  state: 'unknown',
  hasLicense: false,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};

/**
 * "The package licence gate will not deny this request."
 *
 * NOT a claim that a licence record exists — a claim about the POSTURE the
 * enforcer holds, which is the only thing this probe is for. Two inputs produce
 * it and they are the same statement at different scopes: the deployment-wide
 * gate flag being off, and the per-tenant internal-platform exemption
 * (`isInternalTenant`). Shared so the two branches cannot drift into reporting
 * different things about one posture.
 *
 * `hasLicense: true` is safe here because nothing downstream grants on it — the
 * SPA branches exclusively on `state` (frontend/src/lib/stores/
 * licenseGate.svelte.ts BLOCKED_STATES / isValid), and every gated route still
 * calls the fail-closed enforcer regardless of what this returns.
 */
const GATE_DOES_NOT_APPLY: LicenseStatusResult = {
  state: 'active',
  hasLicense: true,
  expiresAt: null,
  daysRemaining: null,
  planCode: null,
};

function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/** Pure: derive status from an ACTIVE license detail (200 from /licenses/active). */
export function deriveActiveState(
  detail: ActiveLicenseDetail,
  now: Date,
  expiringSoonDays: number = EXPIRING_SOON_DAYS,
): LicenseStatusResult {
  const expiresAt = detail.expires_at ?? null;
  const daysRemaining = expiresAt ? daysUntil(expiresAt, now) : null;
  // Defend against a stale 200 / clock skew: /licenses/active SHOULD only 200 a
  // currently-active license, but if it ever returns one whose expiry is already
  // past, that is `expired`, NOT `expiring_soon` (a negative countdown must hard
  // block, not show a dismissible banner).
  const state: LicenseStatusState =
    daysRemaining === null
      ? 'active'
      : daysRemaining < 0
        ? 'expired'
        : daysRemaining <= expiringSoonDays
          ? 'expiring_soon'
          : 'active';
  return {
    state,
    // An already-expired 200 (clock skew / stale upstream) is NOT a held license.
    hasLicense: state !== 'expired',
    expiresAt,
    daysRemaining,
    planCode: detail.plan?.code ?? null,
  };
}

/**
 * Pure: derive status when there is NO active license (404), by inspecting the
 * subject's license inventory for the app. Precedence: revoked > expired > none
 * (pending / not-yet-started licenses count as `none` — there is no active
 * entitlement yet).
 */
export function deriveInactiveState(
  records: LicenseRecord[],
  appKey: string,
  now: Date,
): LicenseStatusResult {
  const appRecords = records.filter((r) => r.app?.key === appKey);
  const NONE: LicenseStatusResult = {
    state: 'none',
    hasLicense: false,
    expiresAt: null,
    daysRemaining: null,
    planCode: null,
  };
  if (appRecords.length === 0) return NONE;

  const revoked = appRecords.find(
    (r) => r.status === 'revoked' || r.revoked_at != null,
  );
  if (revoked) {
    return {
      state: 'revoked',
      hasLicense: false,
      expiresAt: revoked.expires_at ?? null,
      daysRemaining: revoked.expires_at ? daysUntil(revoked.expires_at, now) : null,
      planCode: revoked.plan?.code ?? null,
    };
  }

  const expired = appRecords
    .filter(
      (r) =>
        r.status === 'expired' ||
        (r.expires_at != null && new Date(r.expires_at).getTime() <= now.getTime()),
    )
    .sort((a, b) => {
      const ax = a.expires_at ? new Date(a.expires_at).getTime() : 0;
      const bx = b.expires_at ? new Date(b.expires_at).getTime() : 0;
      return bx - ax; // most-recently-expired first
    })[0];
  if (expired) {
    return {
      state: 'expired',
      hasLicense: false,
      expiresAt: expired.expires_at ?? null,
      daysRemaining: expired.expires_at ? daysUntil(expired.expires_at, now) : null,
      planCode: expired.plan?.code ?? null,
    };
  }

  // A record exists but it's neither active (we got a 404) nor expired/revoked
  // — e.g. pending / future-dated. No active entitlement → treat as none.
  return NONE;
}

/**
 * Peek the ENFORCER's cached entitlement verdict for this tenant+app.
 * `true`/`false` = a cached verdict exists; `null` = no cached verdict.
 *
 * Deliberately a CACHE READ, not a live call: the live call is the one that
 * just failed us. Reading the enforcer's cache is what makes this a genuine
 * second opinion — it is the same value `requireFrLicense` is currently
 * admitting the user on, so a disagreement is real and actionable. Key shape
 * matches `require-fr-license.ts:32` / `require-kag-license.ts:28`.
 */
function peekEnforcerVerdict(tenantId: string, appKey: string): Promise<boolean | null> {
  // Best-effort: a Redis fault must never turn into a lockout, so it degrades
  // to "no second opinion" rather than propagating. That direction is right
  // and is NOT what changed here.
  //
  // ⚠️ What was missing: `null` already means "the enforcer holds no cached
  // verdict", which is a real and actionable signal. A Redis fault produced
  // the SAME null, so "we asked and there is nothing" and "we could not ask"
  // were one value — in the one function whose stated purpose is to be a
  // "genuine second opinion" where "a disagreement is real and actionable".
  // The degrade stays; it is now recorded, so a silent second opinion is
  // visible instead of looking like agreement.
  return redis.get<boolean>(`${appKey}-license:tenant:${tenantId}`).catch((err) => {
    reportSwallowedFailure(err, {
      service: 'redis',
      path: `${appKey}-license:tenant:${tenantId}`,
      degradedTo: 'peekEnforcerVerdict=null (no second opinion, NOT "no cached verdict")',
    });
    return null;
  });
}

/**
 * Resolve the rich license status for the current request's tenant + subject.
 *
 * - gate disabled ⇒ everyone is entitled (`state:'active'`).
 * - no tenant ⇒ `none` (unauthenticated requests are handled by the route's
 *   own auth gate; this is only the status hint).
 * - upstream error ⇒ `unknown` (non-blocking; the 403 gate is the real
 *   enforcer).
 */
export async function getLicenseStatus(args: {
  appKey: string;
  tenantId: string | null | undefined;
  subjectId: string | null | undefined;
  gateEnabled: boolean;
}): Promise<LicenseStatusResult> {
  const { appKey, tenantId, subjectId, gateEnabled } = args;

  if (!gateEnabled) {
    return GATE_DOES_NOT_APPLY;
  }
  if (!tenantId) {
    return {
      state: 'none',
      hasLicense: false,
      expiresAt: null,
      daysRemaining: null,
      planCode: null,
    };
  }

  // ⭐ The enforcer's TENANT exemption axis, mirrored. `packageGateDecision`
  // returns 'skip' for these four ids on EVERY route, so no gated route can
  // 403 this tenant for a licence — reporting anything blocking here would
  // describe a gate that does not exist, which is precisely the "posture the
  // enforcer does not hold" that server.ts:3020 forbids. It is also the ONLY
  // branch that can rescue this case: the enforcer never runs for these
  // tenants, so it never writes the cache entry `peekEnforcerVerdict` reads,
  // and the 2026-08-06 disagreement downgrade below is structurally unreachable.
  //
  // Checked BEFORE any upstream call: these workspaces are not licensable
  // customers, so asking `/licenses/active` about them is a question with only
  // one possible answer and no licences-service outage should be able to
  // change what we report about them.
  if (isInternalTenant(tenantId)) {
    return GATE_DOES_NOT_APPLY;
  }

  try {
    const detail = await licensesClient.getActiveLicenseDetail(tenantId, appKey);
    if (detail && 'conflict' in detail) {
      // Multiple active licenses (data conflict) — entitled, expiry unknown.
      return {
        state: 'active',
        hasLicense: true,
        expiresAt: null,
        daysRemaining: null,
        planCode: null,
      };
    }
    if (detail) {
      return deriveActiveState(detail, new Date());
    }

    // No active license (404). Refine to expired / revoked / none from the
    // subject's inventory — but ONLY when we actually know who they are.
    //
    // Without a subjectId we cannot read the inventory at all. The old code
    // passed `[]` here, which `deriveInactiveState` cannot distinguish from
    // "this subject genuinely holds nothing" and so returned a TERMINAL `none`.
    // That converted a missing-subject auth defect into a full-screen license
    // block. We have no evidence either way ⇒ `unknown`.
    if (!subjectId) {
      console.warn(
        `[license-status] no subjectId for tenant=${tenantId} app=${appKey}; ` +
          `cannot read the license inventory, reporting state:'unknown' rather than a terminal 'none'`,
      );
      return UNKNOWN;
    }

    const records = await licensesClient.listLicensesForSubject(subjectId, { tenantId });
    const derived = deriveInactiveState(records, appKey, new Date());

    // `expired` / `revoked` rest on a record we actually found — positive
    // evidence, terminal, left alone. `none` is the "we found nothing" verdict,
    // and nothing has corroborated it yet. Ask the enforcer: if it is currently
    // admitting this tenant, then this probe disagrees with the component that
    // actually decides access, and the probe is the one that loses.
    if (derived.state === 'none') {
      const enforcerSaysEntitled = await peekEnforcerVerdict(tenantId, appKey)
        .catch((err) => {
          // Justified degrade — a Redis fault must NEVER become a lockout, so
          // this stays best-effort. Recorded because the consequence is not
          // cosmetic: with no second opinion the disagreement branch below can
          // never fire, so the tenant is reported terminal 'none' while the
          // enforcer may still be admitting them. Silently, and for as long as
          // Redis is unwell.
          reportSwallowedFailure(err, {
            service: 'redis',
            degradedTo: "no enforcer second opinion; state stays terminal 'none'",
          });
          return null;
        });
      if (enforcerSaysEntitled === true) {
        console.warn(
          `[license-status] DISAGREEMENT for tenant=${tenantId} app=${appKey}: ` +
            `/licenses/active returned no active license and the subject inventory is empty, ` +
            `but the enforcer's cached verdict is ENTITLED and it is serving this tenant. ` +
            `Reporting state:'unknown' (non-blocking) instead of a terminal 'none'. ` +
            `Enforcement is unchanged — every gated route still calls the fail-closed gate.`,
        );
        return UNKNOWN;
      }
    }

    return derived;
  } catch (err) {
    console.error(
      `[license-status] lookup failed for tenant=${tenantId} app=${appKey}; reporting state:'unknown'`,
      err,
    );
    return UNKNOWN;
  }
}
