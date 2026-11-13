// src/routes/admin/licenses-admin.ts
//
// Super-admin licensing console — HTTP surface.
//
// WHY THIS EXISTS
// ---------------
// The licenses service has had a complete admin API for a long time (apps,
// plans, regions, tenants, licenses, revoke, offerings, BYO mode). Nothing
// ever rendered it. The only license-minting path in fr was the provision-user
// form, which hardcoded a single app (`fr-frontend`), so there was no way to
// grant a license for any other app in the cluster — 28 app_keys are enforced
// at the edge by license-authz, and none of them were reachable from a UI.
// These routes back `/admin/licenses` and close that gap.
//
// This is a THIN PROXY on purpose. The licenses service owns the model and the
// invariants; duplicating any of them here would create a second source of
// truth that drifts (fr already re-implements provisioning in TypeScript
// instead of calling the provisioning service — that lesson is why these
// handlers add gating and shape-validation and nothing else).
//
// AUTHORIZATION — two independent layers, both required
// -----------------------------------------------------
//   1. HERE: `validateAuth` + `isSuperAdmin` (the `super_admin` Keycloak realm
//      role). Every route, no exceptions — including the reads, because the
//      catalog and tenant list are platform-wide.
//   2. UPSTREAM: `require_role("license-admin")` on the writes. We reach that
//      through `getSecureAppsAuthenticator()` (see `services/licenses.ts`
//      `_adminRequest`) — the secure-apps `fr-backend` SA carries
//      `license-admin`; the default portal client does NOT and would 403.
//
// The layers are not redundant. Layer 2 authenticates fr-the-service to the
// licenses service; layer 1 authorizes THE HUMAN. Without layer 1 any
// logged-in fr user would inherit fr's `license-admin` rights — the classic
// confused-deputy: our service account is far more privileged than our users.
//
// ROUTE NAMING: unversioned `/api/admin/licenses/...` (repo hard rule: never
// `/api/v1/`). Paths mirror upstream so the mapping stays greppable.

import { z } from 'zod';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { AppError, BadRequestError, ForbiddenError } from '../../utils/errors';
import { isFrIssuable, notIssuableDetail } from '../../lib/fr-issuable-apps';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { keycloak } from '../../services/keycloak';
import { getBudgetStatus, resetTenantBudgets } from '../../services/metering-admin';
import { TOPUP_PACKAGES, findPackage as findTopupPackage } from '../../services/billing/topup';
import {
  runTopUp,
  isBudgetTopupEnabled,
  listedTopupPackages,
  topupUnavailableResponse,
} from '../me/budget-topup';
import { TopupBody } from '../me/budget-topup-schemas';
import {
  isIntegrationError,
  integrationErrorResponse,
} from '../../integrations/_lib/errors';
import {
  adminListApps,
  adminGetApp,
  adminCreateApp,
  adminDeleteApp,
  adminListAppLicenses,
  adminListPlans,
  adminListAppPlans,
  adminCreatePlan,
  adminUpdatePlan,
  adminDeletePlan,
  adminListRegions,
  adminCreateRegion,
  adminListAllLicenses,
  adminListSubjectLicenses,
  adminMintToken,
  adminRevoke,
  adminListTenants,
  adminGetTenant,
  adminSetLicenseBudget,
  adminListTenantOfferings,
  adminTenantSeatCount,
  adminCreateTenant,
  adminRenameTenant,
  adminSetTenantArchived,
  adminGetByoMode,
  adminSetTenantByoMode,
  adminSetTenantAppByoMode,
  adminClearTenantAppByoMode,
  adminListOfferings,
  adminGetOffering,
  adminCreateOffering,
  adminDeleteOffering,
  adminProvisionTenantOffering,
  adminUnprovisionTenantOffering,
  licencesRefusalCode,
  licensesClient,
} from '../../services/licenses';
import {
  grantLicense,
  licenseRevokeIdempotencyKey,
  resyncPlanQuota,
  revokeLicenseById,
  revokeSubjectLicenses,
} from '../../services/provisioning';
import {
  CreateAppBody,
  CreatePlanBody,
  UpdatePlanBody,
  CreateRegionBody,
  CreateLicenseBody,
  CreateTenantBody,
  RenameTenantBody,
  ArchiveTenantBody,
  ByoModeBody,
  RevokeBody,
  MintTokenBody,
  CreateOfferingBody,
  ResetTenantBudgetBody,
  LicenseBudgetBody,
} from './licenses-admin-schemas';

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * Run `fn` behind the super-admin gate, mapping failures onto the wire.
 *
 * Every handler in this file is `gated(req, () => …)`. Centralising it means a
 * new route cannot forget the check — the gate is not something you remember to
 * add, it is the only way to write a handler here.
 */
async function gated<T>(
  req: Request,
  fn: () => Promise<T>,
  okStatus = 200,
): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status =
      (e as { statusCode?: number }).statusCode ??
      (e as { status?: number }).status ??
      401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  if (!isSuperAdmin(user)) {
    return jsonResponse({ error: 'super-admin only' }, 403);
  }

  try {
    const result = await fn();
    // 204-shaped upstreams (DELETEs) resolve to `{}`; don't ship a body.
    if (okStatus === 204) return new Response(null, { status: 204 });
    return jsonResponse(result, okStatus);
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'invalid request body', details: e.errors }, 422);
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    if (e instanceof AppError) {
      return jsonResponse(
        { error: e.message, ...(e.code ? { code: e.code } : {}) },
        e.statusCode,
      );
    }
    throw e;
  }
}

/** Parse+validate a JSON body. Throws ZodError/SyntaxError for `gated` to map. */
async function body<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  return schema.parse(await req.json()) as z.infer<S>;
}

// Path params arrive POSITIONALLY — `utils/router.ts` compiles `:name` to an
// anonymous `([^/]+)` capture and calls `handler(req, ...match.params)`. There
// is no `req.params`; reaching for one yields `undefined` and silently builds
// upstream URLs with empty segments. Handler signatures below name them in
// pattern order, which is the only thing binding them to the route.

const query = (req: Request, name: string): string | undefined =>
  new URL(req.url).searchParams.get(name) ?? undefined;

/**
 * Tenant scope for a license operation, from the `X-Target-Tenant-Id` header.
 *
 * NOT `X-Tenant-Id`: fr's own auth middleware and the licenses edge both
 * already ascribe meaning to that name (and w2v_common expects it to carry
 * `Bearer <token>`), so reusing it here would collide with the caller's own
 * tenant. A super-admin acts ACROSS tenants, so the target is stated
 * explicitly and separately, and `services/licenses.ts` maps it onto the
 * upstream `X-Tenant-Id` at the boundary.
 */
const targetTenant = (req: Request): string | undefined =>
  req.headers.get('X-Target-Tenant-Id') ?? undefined;

// The body schemas (`.strict()` so a typo'd field is a 422, not a silent no-op)
// live in ./licenses-admin-schemas.ts, shared with the capability declarations
// (fr-agui P4c part 3, capabilities/admin/licensing.ts).

// ---------------------------------------------------------------------------
// Handlers — catalog: apps
// ---------------------------------------------------------------------------

/**
 * The app catalog.
 *
 * `?include_test=true` opts INTO the test/demo residue. The default excludes
 * it: integration tests wrote 242 junk apps (`inttest-*`, `demo-app-*`, …)
 * straight into the prod licenses DB, which made any app picker a 278-entry
 * mess. The licenses repo's `scripts/purge_test_apps.py` cleans the data; this
 * filter is defence-in-depth so the picker degrades gracefully if the residue
 * ever comes back (the root cause — a test config pointed at prod — is not
 * fixed yet).
 */
export const TEST_APP_KEY_RE =
  /^(?:inttest-|demo-app(?:-|$)|test-|dbg\d*-|debug-|probe-|app-)/;

export const handleListApps = (req: Request): Promise<Response> =>
  gated(req, async () => {
    // Only fr's own platform context is in fr's catalogue: the members of the fr
    // licences bundles (FR_TENANT_APPS, an allowlist — George, 2026-10-14 /
    // 2026-10-21). Every other platform's app (CommonPractice, w2v, agent,
    // care-bus, …) and any unknown future key is dropped. Every super-admin
    // picker reads this list, so filtering here keeps each one honest.
    // `include_test` (cleanup work) additionally brings test residue back — never
    // another platform's app.
    const includeTest = query(req, 'include_test') === 'true';
    return (await adminListApps()).filter(
      (a) => isFrIssuable(a.key) || (includeTest && TEST_APP_KEY_RE.test(a.key)),
    );
  });

/** Refuse an app outside fr's bundle (FR_TENANT_APPS), before any upstream write. */
function refuseAppOutsideFrBundle(appKey: string): void {
  if (isFrIssuable(appKey)) return;
  throw new ForbiddenError(notIssuableDetail([appKey])).withCode('app_not_issuable_by_fr');
}

export const handleGetApp = (req: Request, appId: string): Promise<Response> =>
  gated(req, () => adminGetApp(appId));

export const handleCreateApp = (req: Request): Promise<Response> =>
  gated(req, async () => adminCreateApp(await body(req, CreateAppBody)), 201);

/** One license whose billing quota outlived it, and why. */
export interface RetainedQuota {
  license_id: string;
  tenant_id: string;
  subject_id: string;
  /** What actually went wrong — never a generic "failed". */
  reason: string;
}

/**
 * What an app delete really did. Deliberately NOT a 204: the cascade can leave
 * billing quota behind, and a bodyless response cannot say so.
 */
export interface AppDeleteReport {
  app_id: string;
  /** The app row itself is gone (this handler throws rather than report false). */
  deleted: boolean;
  /** Licenses the app had at enumeration time — the denominator for the rest. */
  licenses_found: number;
  /** Quota configs provisioning confirms it removed. */
  quotas_deregistered: number;
  /** DERIVED from `retained_quota_licenses`, never assumed from a lack of throws. */
  billing_quota_retained: boolean;
  retained_quota_licenses: RetainedQuota[];
}

/**
 * How many revokes run at once during an app-delete cascade. App deletion is rare
 * and destructive, so this is deliberately modest — correctness and a legible
 * provisioning audit trail beat wall-clock. It only exists so an app with dozens
 * of licenses does not serialise into a timeout.
 */
export const APP_DELETE_REVOKE_CONCURRENCY = 4;

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving INPUT order in
 * the result. Order matters: the retained-quota list an operator reads must not
 * reshuffle with the weather.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * Delete an app — and deregister its licenses' billing quota on the way out.
 *
 * `DELETE /apps/{id}` upstream is a hard cascade: the app's plans, licenses AND
 * tokens all go, with no "still referenced" guard (unlike DELETE /plans, which
 * 409s). What it does NOT do is touch billing. A quota config is a durable row
 * keyed by license_id; it survives the license, and billing's 6h re-seeder keeps
 * it (and its `quota:limit:*` redis keys) alive forever. So every app delete used
 * to permanently orphan one row per license — the last leak of the class #733
 * closed for grant/revoke and #735 for provision-user.
 *
 * So: enumerate first, revoke each license THROUGH PROVISIONING (that is what
 * deregisters the quota), then destroy the app. The ordering is load-bearing —
 * once the app is gone the licenses are unenumerable and the quota is unreachable,
 * so a deregistration attempted afterwards has nothing to name.
 *
 * Two failure modes, handled differently on purpose:
 *   * ENUMERATION fails → throw, delete NOTHING. We cannot know what to
 *     deregister, and destroying the app anyway would orphan every quota row
 *     silently. Nothing is destroyed yet, so a retry is free.
 *   * A REVOKE fails → still delete the app, and NAME the licenses whose quota was
 *     retained. The operator asked for a destructive action; refusing it leaves
 *     them stuck while the orphans persist regardless. What is not acceptable is
 *     telling them it was clean.
 */
export const handleDeleteApp = (req: Request, appId: string): Promise<Response> =>
  gated(req, () => deleteAppAndDeregisterQuota(appId));

export async function deleteAppAndDeregisterQuota(
  appId: string,
): Promise<AppDeleteReport> {
  // Admin listing — no tenant filter, so this sees EVERY tenant's licenses for the
  // app, which is exactly the set the cascade is about to destroy.
  const licenses = await adminListAppLicenses(appId);

  const outcomes = await mapWithConcurrency(
    licenses,
    APP_DELETE_REVOKE_CONCURRENCY,
    async (
      lic,
    ): Promise<{ deregistered: number; retained: RetainedQuota | null }> => {
      const identity = {
        license_id: lic.id,
        tenant_id: lic.tenant_id,
        subject_id: lic.subject_id,
      };
      try {
        // Already-revoked licenses are included on purpose: provisioning
        // deregisters the quota independently of the revoke outcome, so an
        // already-revoked license (e.g. one killed by fr's pre-#733 direct path)
        // still gets its orphan cleaned up here. The revoke is addressed with the
        // license's OWN tenant_id, so provisioning's ownership guard passes.
        const r = await revokeLicenseById({
          tenantId: lic.tenant_id,
          licenseId: lic.id,
          // Deterministic: a retried cascade must RESUME a partially-failed revoke,
          // not open a second run beside the orphan.
          idempotencyKey: licenseRevokeIdempotencyKey(lic.id),
          reason: `app ${appId} deleted from the super-admin licensing console`,
        });
        // provisioning treats a billing failure as non-fatal and reports it in a
        // 200 body. Reading the flag is the whole point — a 200 is not success.
        return {
          deregistered: r.quotas_deregistered,
          retained: r.billing_quota_retained
            ? {
                ...identity,
                reason:
                  'provisioning revoked the license but could not deregister its ' +
                  `billing quota (billing_quota_retained, run ${r.idempotency_key})`,
              }
            : null,
        };
      } catch (e) {
        return {
          deregistered: 0,
          retained: {
            ...identity,
            reason: `revoke through provisioning failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
        };
      }
    },
  );

  const retained = outcomes
    .map((o) => o.retained)
    .filter((r): r is RetainedQuota => r !== null);
  const quotasDeregistered = outcomes.reduce((n, o) => n + o.deregistered, 0);

  if (retained.length > 0) {
    console.error(
      `[licenses-admin] app ${appId} deleted with ${retained.length} of ` +
        `${licenses.length} billing quota configs RETAINED (orphaned rows the ` +
        `re-seeder will keep alive):`,
      retained,
    );
  }

  await adminDeleteApp(appId);

  return {
    app_id: appId,
    deleted: true,
    licenses_found: licenses.length,
    quotas_deregistered: quotasDeregistered,
    // DERIVED from what happened, never from "nothing threw".
    billing_quota_retained: retained.length > 0,
    retained_quota_licenses: retained,
  };
}

export const handleListAppLicenses = (
  req: Request,
  appId: string,
): Promise<Response> => gated(req, () => adminListAppLicenses(appId));

// ---------------------------------------------------------------------------
// Handlers — catalog: plans + regions
// ---------------------------------------------------------------------------

export const handleListPlans = (req: Request): Promise<Response> =>
  gated(req, () => adminListPlans());

export const handleListAppPlans = (
  req: Request,
  appId: string,
): Promise<Response> => gated(req, () => adminListAppPlans(appId));

export const handleCreatePlan = (req: Request): Promise<Response> =>
  gated(req, async () => adminCreatePlan(await body(req, CreatePlanBody)), 201);

/**
 * Update a plan — and, when its `quota_monthly` changes, PROPAGATE that to billing.
 *
 * Billing keys the durable request-quota config by license_id with the plan value
 * SNAPSHOTTED at grant time, so a bare PATCH never reaches the already-registered
 * configs — the 6h re-seeder would republish the stale value forever. So after the
 * PATCH succeeds, if the caller changed `quota_monthly`, re-apply it to every live
 * license on the plan through provisioning (which registers, or deregisters when the
 * plan becomes unlimited).
 *
 * The propagation is best-effort: the plan edit already succeeded, so a resync failure
 * must NOT fail the request — it is surfaced in `quota_resync` (never hidden) so the
 * operator knows enforcement may still carry the old value for some licenses.
 */
export const handleUpdatePlan = (req: Request, planId: string): Promise<Response> =>
  gated(req, async () => {
    const patch = await body(req, UpdatePlanBody);
    const updated = await adminUpdatePlan(planId, patch);

    // Only propagate when the operator actually touched the quota. Field omitted =
    // leave enforcement alone; present (incl. null = unlimited) = a change to apply.
    // The response PRESERVES the PlanRecord (established contract) and ADDS the resync
    // outcome — the propagation is a best-effort side effect: the PATCH already committed,
    // so failing the request would falsely report the edit as failed. But a degraded/failed
    // resync must NOT be hidden (the doc contract above): billing enforcement may still carry
    // the OLD limit for some licenses, and only the operator can decide to retry. So it is
    // logged LOUD (provisioning audits it too) AND surfaced in `quota_resync` /
    // `quota_resync_ok`, mirroring how the grant path surfaces `quota_registered`.
    if ('quota_monthly' in patch) {
      let quotaResync: {
        status: string;
        ok: boolean;
        licenses_found: number | null;
        quotas_registered: number | null;
        quotas_deregistered: number | null;
        /** Licenses the resync could NOT apply (or the transport error). Never hidden. */
        failures: string[];
      };
      try {
        const resync = await resyncPlanQuota({
          appId: updated.app_id,
          planId: updated.id,
          quotaMonthly: updated.quota_monthly,
        });
        if (resync.status !== 'resynced') {
          console.error(
            `[licenses-admin] plan ${planId} quota changed to ${updated.quota_monthly} but ` +
              `${resync.failures.length} license(s) did NOT resync (billing enforcement carries ` +
              `the OLD value for them): ${resync.failures.join(', ')}`,
          );
        }
        quotaResync = {
          status: resync.status,
          ok: resync.status === 'resynced',
          licenses_found: resync.licenses_found,
          quotas_registered: resync.quotas_registered,
          quotas_deregistered: resync.quotas_deregistered,
          failures: resync.failures,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `[licenses-admin] plan ${planId} quota changed to ${updated.quota_monthly} but the ` +
            `propagation to billing FAILED (the plan edit stands; enforcement still carries the ` +
            `old value): ${message}`,
        );
        // The call never completed, so no per-license breakdown exists — say so with
        // nulls rather than fabricating zeros, and carry the error as the single failure.
        quotaResync = {
          status: 'failed',
          ok: false,
          licenses_found: null,
          quotas_registered: null,
          quotas_deregistered: null,
          failures: [message],
        };
      }
      // Spread PRESERVES the PlanRecord shape; the two fields are additive. DERIVED
      // from the resync result, never assumed clean from a lack of throws.
      return { ...updated, quota_resync: quotaResync, quota_resync_ok: quotaResync.ok };
    }
    return updated;
  });

/** 409 upstream while licenses reference the plan — surfaced as UPSTREAM_CONFLICT. */
export const handleDeletePlan = (req: Request, planId: string): Promise<Response> =>
  gated(req, () => adminDeletePlan(planId), 204);

export const handleListRegions = (req: Request): Promise<Response> =>
  gated(req, () => adminListRegions());

export const handleCreateRegion = (req: Request): Promise<Response> =>
  gated(req, async () => adminCreateRegion(await body(req, CreateRegionBody)), 201);

// ---------------------------------------------------------------------------
// Handlers — grants (the licenses themselves)
// ---------------------------------------------------------------------------

export const handleListAllLicenses = (req: Request): Promise<Response> =>
  gated(req, () => adminListAllLicenses());

/**
 * List a subject's licenses IN ONE TENANT.
 *
 * `X-Target-Tenant-Id` is REQUIRED — same as the grant/revoke/delete WRITE paths,
 * and for the same reason (defense-in-depth on a cross-tenant read): the licenses
 * service scopes the lookup by tenant, and with no header its `get_tenant_id` falls
 * back to the CALLER's JWT `sub` — our service account's subject uuid, which owns no
 * licenses. So a tenant-less read cannot answer the operator's actual question; it
 * silently scopes to the wrong (empty) tenant and returns [] that reads like "this
 * subject holds nothing". Refuse it outright rather than mislead.
 */
export const handleListSubjectLicenses = (
  req: Request,
  subjectId: string,
): Promise<Response> =>
  gated(req, () => {
    const tenant = targetTenant(req);
    if (!tenant) {
      throw new BadRequestError(
        'X-Target-Tenant-Id is required: this read is tenant-scoped, and with no ' +
          "header the lookup falls back to the caller SA's own subject → the wrong " +
          '(empty) tenant, returning [] that looks like "holds nothing".',
      );
    }
    return adminListSubjectLicenses(subjectId, tenant);
  });

/**
 * Grant a license, and mint its first token in the same call.
 *
 * Upstream splits this in two (`POST /licenses/user/{id}` returns a license but
 * NO token; the token comes from a second call). Splitting it in the UI too
 * would leave a license with no token whenever the second call fails —
 * something the operator cannot see and would have to know to fix. So we join
 * them and report honestly: `token: null` + `token_error` when the mint fails,
 * rather than pretending the grant fully succeeded.
 *
 * The raw token is returned ONCE and never persisted in plaintext anywhere.
 */
export const handleCreateLicense = (
  req: Request,
  subjectId: string,
): Promise<Response> =>
  gated(
    req,
    async () => {
      const tenantId = targetTenant(req);
      if (!tenantId) {
        // provisioning scopes the mint by tenant_id (and the underlying licenses
        // write falls back to the caller's own subject with no tenant), so a
        // tenant-less grant would land in the wrong tenant. Refuse it outright.
        throw new BadRequestError(
          'X-Target-Tenant-Id is required to grant: provisioning scopes the mint ' +
            'by tenant, so a tenant-less grant lands in the wrong tenant.',
        );
      }
      const b = await body(req, CreateLicenseBody);
      refuseAppOutsideFrBundle((await adminGetApp(b.app_id)).key);

      // Route the mint through the provisioning engine (not licenses directly) so
      // the plan's monthly billing quota is REGISTERED — license-authz enforces it
      // at 402. provisioning mints the license via the licenses service AND returns
      // the raw token in one call; a mint/token failure throws (mapped to the wire),
      // so there is no "license without token" split to report here.
      const g = await grantLicense({
        tenantId,
        subjectId,
        appId: b.app_id,
        planId: b.plan_id,
        regionId: b.region_id,
        startsAt: b.starts_at,
        expiresAt: b.expires_at,
        metadata: b.metadata,
      });
      // A 'partial' grant means the license + token minted but the billing quota
      // did NOT register — so license-authz has nothing to enforce at 402, which is
      // the whole reason the mint was routed through provisioning. Do NOT launder
      // that into a clean 201: surface it (quota_registered + partial_failures) so
      // the operator/UI can see the license is unmetered, mirroring how
      // handleProvisionUser surfaces its own partial_failures.
      const quotaRegistered = g.status !== 'partial';
      if (!quotaRegistered) {
        console.warn(
          `[licenses-admin] grant ${g.license.license_id} degraded: ${g.partial_failures.join(', ')}`,
        );
      }
      return {
        license: { id: g.license.license_id },
        token: g.license.token,
        token_error: null,
        // DERIVED from the provisioning result, never assumed. The UI must not
        // render a 'partial' grant as a plain success.
        quota_registered: quotaRegistered,
        partial_failures: g.partial_failures,
        // COSMETIC degradations (e.g. a succeeded_with_warnings grant). Forwarded for
        // symmetry with handleProvisionUser, which surfaces both axes — dropping these
        // hid non-fatal warnings the operator should still see.
        warnings: g.warnings,
      };
    },
    201,
  );

/**
 * Delete EVERY license a subject holds IN ONE TENANT. Returns `{deleted: n}`.
 *
 * `X-Target-Tenant-Id` is REQUIRED, same as revoke and for the same reason:
 * upstream scopes the delete by tenant, and with no header `get_tenant_id`
 * falls back to the CALLER's JWT `sub` — our service account's subject uuid,
 * which owns no licenses. So a tenant-less call can only ever delete 0 while
 * answering `200 {deleted: 0}`. It cannot succeed, so refuse it outright.
 *
 * Note `{deleted: 0}` stays a legitimate answer WITH a tenant (the subject may
 * genuinely hold nothing there) — so the count is surfaced rather than thrown
 * on. Callers must report the number, not the 200.
 */
export const handleDeleteSubjectLicenses = (
  req: Request,
  subjectId: string,
): Promise<Response> =>
  gated(req, async () => {
    const tenant = targetTenant(req);
    if (!tenant) {
      throw new BadRequestError(
        'X-Target-Tenant-Id is required: the revoke is scoped by tenant, so a ' +
          'tenant-less call would affect 0 and still answer 200.',
      );
    }
    // Route through provisioning so each license's billing quota is deregistered
    // (fr's direct delete left orphaned quota rows). Revokes every active license
    // the subject holds in the tenant; `{deleted: n}` is preserved (n = revoked).
    const r = await revokeSubjectLicenses({ tenantId: tenant, subjectId });
    // Surface the billing outcome. A quota that could NOT be deregistered is an
    // orphan billing's 6h re-seeder keeps alive forever — reporting only `{deleted}`
    // hid it, and a fresh-key retry can't recover it (subject-mode revoke only sees
    // ACTIVE licenses, and they are all revoked now). The operator must be told.
    if (r.billing_quota_retained) {
      console.error(
        `[licenses-admin] delete-subject ${subjectId} revoked ${r.licenses_revoked} license(s) ` +
          `but RETAINED billing quota (${r.licenses_revoked - r.quotas_deregistered} orphaned; ` +
          `run ${r.idempotency_key})`,
      );
    }
    return {
      deleted: r.licenses_revoked,
      quotas_deregistered: r.quotas_deregistered,
      // DERIVED from provisioning, never assumed from a lack of throws.
      billing_quota_retained: r.billing_quota_retained,
    };
  });

export const handleMintToken = (
  req: Request,
  licenseId: string,
): Promise<Response> =>
  gated(req, async () => adminMintToken(licenseId, await body(req, MintTokenBody)), 201);

export const handleRegenerateToken = (
  req: Request,
  licenseId: string,
): Promise<Response> =>
  gated(req, () => licensesClient.regenerateToken(licenseId, targetTenant(req)));

/**
 * Revoke a license or a single token.
 *
 * `X-Target-Tenant-Id` is REQUIRED here, unlike everywhere else it is optional.
 * Upstream masks a tenant mismatch as `200 {revoked:false,"License not found"}`
 * and leaves the license working (verified live), so omitting the tenant is not
 * a degraded revoke — it is a NO-OP that looks like success. Rejecting it at
 * the edge beats discovering it from a license that never died.
 */
export const handleRevoke = (req: Request): Promise<Response> =>
  gated(req, async () => {
    const b = await body(req, RevokeBody);
    const tenant = targetTenant(req);
    if (!tenant) {
      throw new BadRequestError(
        'X-Target-Tenant-Id is required to revoke: a tenant mismatch is masked as ' +
          '"License not found" and leaves the license active, so a revoke without ' +
          "it silently does nothing. Pass the license's tenant_id.",
      );
    }
    // Token-only revoke: revoking ONE token neither removes the license nor changes
    // its quota, so it stays on the direct licenses path.
    if (b.token) {
      return adminRevoke(b, tenant);
    }
    // License revoke: route through provisioning so the billing quota is
    // DEREGISTERED (fr's direct path left an orphaned quota row that the re-seeder
    // kept alive). Preserve the {revoked, message} shape the frontend consumes.
    const r = await revokeLicenseById({ tenantId: tenant, licenseId: b.license_id! });
    const revoked = r.licenses_revoked > 0;
    // provisioning now 404s a license that is absent OR belongs to another tenant
    // (see its license-ownership guard), which the post() layer turns into a thrown
    // UPSTREAM_NOT_FOUND. So reaching here with licenses_revoked === 0 means the
    // license EXISTED under this tenant and was ALREADY revoked — its quota is still
    // deregistered — not "not found". Report that honestly.
    if (r.billing_quota_retained) {
      console.error(
        `[licenses-admin] revoke ${b.license_id} RETAINED billing quota (orphan; run ${r.idempotency_key})`,
      );
    }
    return {
      revoked,
      message: revoked
        ? 'License and all tokens revoked successfully'
        : 'License was already revoked (billing quota deregistered)',
      // DERIVED from provisioning — a retained quota is an orphan, surfaced not hidden.
      billing_quota_retained: r.billing_quota_retained,
    };
  });

// ---------------------------------------------------------------------------
// Handlers — tenants + BYO mode
// ---------------------------------------------------------------------------

/**
 * `?include_archived=true` also returns archived tenants, and
 * `?include_service_actors=true` also returns service-mesh auth principals
 * (upstream hides those by default now). Only the literal string `true` counts
 * for either — `?include_archived=false` must not read as truthy "the param is
 * present", which is what a bare presence check would do.
 */
export const handleListTenants = (req: Request): Promise<Response> =>
  gated(req, () =>
    adminListTenants(
      query(req, 'include_archived') === 'true',
      query(req, 'include_service_actors') === 'true',
    ),
  );

export const handleGetTenant = (req: Request, nameOrId: string): Promise<Response> =>
  gated(req, () => adminGetTenant(nameOrId));

/**
 * `GET /api/admin/licenses/tenants/:nameOrId/offerings` — what this tenant has
 * been provisioned, per product. `offering_code: null` is "provenance unknown",
 * NOT "no offering" — see `adminListTenantOfferings`.
 */
export const handleListTenantOfferings = (
  req: Request,
  nameOrId: string,
): Promise<Response> => gated(req, () => adminListTenantOfferings(nameOrId));

/**
 * `GET /api/admin/licenses/tenants/:nameOrId/seat-count` — how many seats this
 * tenant already has. Billing's per-seat denominator, proxied unchanged.
 *
 * ⛔ AN UNREADABLE UPSTREAM MUST NOT BECOME A ZERO. The call is deliberately
 * bare inside `gated`, with no `catch`: every failure — a 404 for an unknown
 * tenant, a 503 from a restarting licences pod — reaches the wire as an error,
 * exactly as the sibling handlers do. Wrapping this in `catch { return {seats:0} }`
 * would make an outage indistinguishable from a tenant that owes nothing, and
 * that collapse is the defect class this whole surface exists to delete. Read
 * `basis` to tell an archived tenant's 0 from a real one; never infer a 0 from a
 * failure.
 *
 * `?app=<key>` SCOPES THE COUNT TO ONE PRODUCT, and is forwarded — the same
 * spelling `handleGetByoMode` uses on the neighbouring tenant route. ⚠️ WITHOUT
 * it the number aggregates EVERY app the tenant holds, so an unscoped figure
 * must be labelled as all-apps and never rendered as one product's seat count.
 * The response echoes `app_key` (`null` = every app) so the caller can tell
 * which it is holding. An unknown key is **422 `app_not_found`** upstream,
 * deliberately not 404, because billing's seats client reads a 404 as a durable
 * 0 — and it propagates, because a 422 absorbed into `{seats: 0}` is the same
 * lie as an absorbed outage.
 *
 * ⚠️ An earlier revision of this handler 400'd `?app=` on the claim that no
 * per-app count existed, generalised from "seats are minted per subject, apps
 * are sold per tenant". That sentence is why the parameter is NEEDED. The claim
 * was measured false against `origin/main` (and against the running pod, which
 * is byte-identical to it) — a guard enforcing something the surface could not
 * see is the same defect class as a zero standing in for an absence.
 *
 * `?as_of=` is forwarded too. `period_start`/`period_end` exist upstream and are
 * deliberately not exposed — see `adminTenantSeatCount`.
 */
export const handleGetTenantSeatCount = (
  req: Request,
  nameOrId: string,
): Promise<Response> =>
  gated(req, () =>
    adminTenantSeatCount(nameOrId, {
      asOf: query(req, 'as_of'),
      app: query(req, 'app'),
    }),
  );

/**
 * Create a licences tenant owned by fr. NOT idempotent by name (licences
 * migration 050): a name fr already holds is answered here as an explicit 409
 * `tenant_name_taken` — never as "here is the existing tenant", which is how fr
 * used to be handed another app's tenant UUID. A name only another app holds
 * creates a NEW tenant.
 */
export const handleCreateTenant = (req: Request): Promise<Response> =>
  gated(
    req,
    async () => {
      const b = await body(req, CreateTenantBody);
      try {
        return await adminCreateTenant(b);
      } catch (e) {
        if (
          isIntegrationError(e) &&
          e.upstreamStatus === 409 &&
          licencesRefusalCode(e.upstreamBody) === 'tenant_name_taken'
        ) {
          throw new AppError(
            409,
            `fr already has a licences tenant named '${b.name}'. Tenant names are ` +
              'unique per owning app: choose another name, or use the existing tenant.',
          ).withCode('tenant_name_taken');
        }
        throw e;
      }
    },
    201,
  );

/** Rename. The name is an identifier upstream — see `adminRenameTenant`. */
export const handleRenameTenant = (
  req: Request,
  nameOrId: string,
): Promise<Response> =>
  gated(req, async () => {
    const b = await body(req, RenameTenantBody);
    return adminRenameTenant(nameOrId, b.name);
  });

/** Archive or restore. Revokes nothing — see `adminSetTenantArchived`. */
export const handleSetTenantArchived = (
  req: Request,
  nameOrId: string,
): Promise<Response> =>
  gated(req, async () => {
    const b = await body(req, ArchiveTenantBody);
    return adminSetTenantArchived(nameOrId, b.archived);
  });

/** `?app=<key>` resolves the effective posture for one product. */
export const handleGetByoMode = (req: Request, nameOrId: string): Promise<Response> =>
  gated(req, () => adminGetByoMode(nameOrId, query(req, 'app')));

export const handleSetTenantByoMode = (
  req: Request,
  nameOrId: string,
): Promise<Response> =>
  gated(req, async () => {
    const b = await body(req, ByoModeBody);
    return adminSetTenantByoMode(nameOrId, b.byo_mode);
  });

export const handleSetTenantAppByoMode = (
  req: Request,
  nameOrId: string,
  appKey: string,
): Promise<Response> =>
  gated(req, async () => {
    const b = await body(req, ByoModeBody);
    return adminSetTenantAppByoMode(nameOrId, appKey, b.byo_mode);
  });

/** Drop the per-product override; the tenant-wide posture applies again. */
export const handleClearTenantAppByoMode = (
  req: Request,
  nameOrId: string,
  appKey: string,
): Promise<Response> =>
  gated(req, () => adminClearTenantAppByoMode(nameOrId, appKey), 204);

// ---------------------------------------------------------------------------
// Handlers — offerings
// ---------------------------------------------------------------------------

export const handleListOfferings = (req: Request): Promise<Response> =>
  gated(req, async () => ({ offerings: await adminListOfferings(query(req, 'app')) }));

export const handleGetOffering = (
  req: Request,
  appKey: string,
  code: string,
): Promise<Response> => gated(req, () => adminGetOffering(appKey, code));

export const handleCreateOffering = (req: Request): Promise<Response> =>
  gated(
    req,
    async () => {
      const b = await body(req, CreateOfferingBody);
      refuseAppOutsideFrBundle(b.app_key);
      return adminCreateOffering(b);
    },
    201,
  );

export const handleDeleteOffering = (
  req: Request,
  appKey: string,
  code: string,
): Promise<Response> => gated(req, () => adminDeleteOffering(appKey, code), 204);

export const handleProvisionTenantOffering = (
  req: Request,
  nameOrId: string,
  appKey: string,
  code: string,
): Promise<Response> =>
  gated(
    req,
    async () => {
      refuseAppOutsideFrBundle(appKey);
      return adminProvisionTenantOffering(nameOrId, appKey, code);
    },
    201,
  );

export const handleUnprovisionTenantOffering = (
  req: Request,
  nameOrId: string,
  appKey: string,
  code: string,
): Promise<Response> =>
  gated(req, () => adminUnprovisionTenantOffering(nameOrId, appKey, code));

// ---------------------------------------------------------------------------
// Handlers — people (Keycloak user resolution for the console)
//
// This exists so an operator NEVER pastes a Keycloak `sub` UUID: `search` backs
// the grant-form person typeahead, going through the portal admin SA
// (view-users) via the shared keycloak client.
//
// ⛔ There used to be a second handler here, `handleResolveUsers` — batch
// sub → person for the licenses table's `Person` column. That column was
// removed (commit 25296721, "a licence is held by a tenant") and this was its
// only caller; the route (`POST /api/admin/licenses/users/resolve`) and this
// handler were removed with it. `keycloak.resolveUsers` and
// `keycloak.getUserById` themselves stay — they have 12 other production
// callers (dashboard, approvals, tenant/workspace members, admin/users,
// admin/department-members, comments, agui actions).
// ---------------------------------------------------------------------------

/** `GET /api/admin/licenses/users?q=<email|name>` — person typeahead. */
export const handleSearchUsers = (req: Request): Promise<Response> =>
  gated(req, async () => {
    const q = query(req, 'q') ?? '';
    if (q.trim().length < 2) {
      // Avoid a full-directory scan on a single keystroke.
      return { users: [] };
    }
    return { users: await keycloak.searchUsers(q) };
  });

// ---------------------------------------------------------------------------
// Handlers — budget (super-admin: view + top up ANY tenant)
//
// The tenant-admin self-serve equivalents live in routes/me/budget-topup.ts;
// these are the super-admin console's cross-tenant view. Top-up reuses the same
// payment-seam runTopUp so free-vs-paid behaviour is identical everywhere.
// ---------------------------------------------------------------------------

/** `GET /api/admin/licenses/budget/:tenantId` — a tenant's aggregate budget. */
export const handleGetTenantBudget = (req: Request, tenantId: string): Promise<Response> =>
  gated(req, () => getBudgetStatus(tenantId));

/** `GET /api/admin/licenses/budget-packages` — the top-up package dropdown source. */
export const handleListBudgetPackages = (req: Request): Promise<Response> =>
  gated(req, async () => ({ packages: listedTopupPackages(), topupEnabled: isBudgetTopupEnabled() }));

/**
 * `POST /api/admin/licenses/budget/reset/:tenantId` — zero EVERY consumed
 * counter the tenant holds, so its full allowance is available again.
 *
 * Destructive to the meter, not to the budget rows: the allowances survive,
 * only `consumed_tokens` is zeroed. Billing owns that semantics; this relays
 * its report (what was reset, and the consumed total it destroyed) so the
 * console can state the outcome instead of claiming a bare success.
 */
export const handleResetTenantBudget = (
  req: Request,
  tenantId: string,
): Promise<Response> =>
  gated(req, async () => {
    const { reason } = await body(req, ResetTenantBudgetBody);
    return resetTenantBudgets({ tenantId, reason });
  });

/**
 * `PATCH /api/admin/licenses/budget/line/:licenseId` — set ONE licence's
 * budget override, or CLEAR it (`token_budget_override: null`, falling back to
 * the plan's allowance).
 *
 * Per LICENCE, not per tenant: a tenant's figure is a sum over stacked budget
 * rows, each keyed to the licence that produced it. Naming the tenant could
 * only ever be ambiguous about which row moves.
 */
export const handleAdjustLicenseBudget = (
  req: Request,
  licenseId: string,
): Promise<Response> =>
  gated(req, async () => adminSetLicenseBudget(licenseId, await body(req, LicenseBudgetBody)));

/**
 * `POST /api/admin/licenses/budget/topup/:tenantId` — top up any tenant.
 * Gates inline (not via `gated`) because `runTopUp` returns a Response itself.
 */
export async function handleTopUpTenant(req: Request, tenantId: string): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!isSuperAdmin(user)) return jsonResponse({ error: 'super-admin only' }, 403);
  // BUDGET_TOPUP_ENABLED kill switch — no free top-up, not even for operators.
  if (!isBudgetTopupEnabled()) return topupUnavailableResponse();

  // idempotency_key is required here for the same reason as the tenant route
  // (migration 118): the super-admin console allocates the same 1M-100M-token
  // packages, so an unkeyed double-submit double-credits identically.
  let pkgId: string;
  let idempotencyKey: string;
  try {
    // The SAME body as the tenant route (routes/me/budget-topup-schemas.ts `TopupBody`).
    const parsed = await body(req, TopupBody);
    pkgId = parsed.package_id;
    idempotencyKey = parsed.idempotency_key;
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'invalid request body', details: e.errors }, 422);
    }
    if (e instanceof SyntaxError) return jsonResponse({ error: 'invalid JSON body' }, 400);
    throw e;
  }
  const pkg = findTopupPackage(pkgId);
  if (!pkg) {
    return jsonResponse(
      { error: `unknown package '${pkgId}'`, packages: TOPUP_PACKAGES.map((p) => p.id) },
      404,
    );
  }
  return runTopUp({ tenantId, actorUserId: user.id, pkg, idempotencyKey });
}
