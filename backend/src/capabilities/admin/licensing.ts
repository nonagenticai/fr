// fr-agui SPEC §13 P4c part 3 — spec drain: the super-admin licensing console
// (routes/admin/licenses-admin.ts, 40 routes under /api/admin/licenses), re-expressed
// with NO behaviour change (`legacyHandler`).
//
// The console is a THIN PROXY of the licences service's admin API (apps, plans,
// regions, licences, tokens, tenants, BYO posture, offerings), plus fr's own
// person typeahead (Keycloak) and the cross-tenant budget view / top-up (billing).
// Every handler runs `gated()`: validateAuth CAUGHT and answered `{ error:
// 'unauthorized' }` with the throw's own status (the conveyor write door is a 403
// with that body), then the `super_admin` realm role (403 'super-admin only'). The
// top-up gates inline and answers EVERY validateAuth refusal 401. None reads the
// request tenant: a super-admin acts ACROSS tenants and names the target in the path,
// the body or `X-Target-Tenant-Id` — so `tenancy: 'platform'`, `isAuthenticatedSuperAdmin`.
//
// Response shapes are the licences service's own (origin/main main.py response
// models), relayed unchanged unless the description says fr reshapes them.
//
// 🔐 Raw licence tokens (`token_urlsafe(32)` upstream, shown ONCE) are `secrets.output`
// on the grant, the mint and the rotation; the token a revoke names is `secrets.input`.
import { z } from 'zod';

import {
  ArchiveTenantBody,
  ByoModeBody,
  CreateAppBody,
  CreateLicenseBody,
  CreateOfferingBody,
  CreatePlanBody,
  CreateRegionBody,
  CreateTenantBody,
  LicenseBudgetBody,
  MintTokenBody,
  RenameTenantBody,
  ResetTenantBudgetBody,
  RevokeBody,
  UpdatePlanBody,
} from '../../routes/admin/licenses-admin-schemas';
import { TopupBody } from '../../routes/me/budget-topup-schemas';
import { budgetStatus, topupAllocated, topupPackage } from '../account/usage';
import type { Capability, ResponseSpec } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { caughtAuthResponses, pathId, routeRule, settingsCapabilities, type SettingsRoute } from '../observe/_shared';

const LICENCES =
  "Any licences-service status is relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through with their body, its 401 / 5xx or " +
  'no answer is 502, a timeout 504). ';
const GATE = "403: `error` 'super-admin only' (not a super_admin). ";
const BODY = "422: `error` 'invalid request body' (`details`: the zod issues; an unknown key is refused). 400: `error` 'invalid JSON body'. ";
const TARGET =
  "400: `error` 'X-Target-Tenant-Id is required…' (the `X-Target-Tenant-Id` request header names the licence's tenant; " +
  'without it nothing is sent). ';
/** P4d-1: the request header naming the licence's tenant (routes/admin/licenses-admin.ts `targetTenant`). */
const TARGET_HEADER = (required: boolean) => [
  {
    name: 'X-Target-Tenant-Id' as const,
    required,
    description: required
      ? "The licence's tenant. REQUIRED: fr answers 400 without it and sends nothing."
      : "The licence's tenant, forwarded to licences when present.",
  },
];
const NOT_ISSUABLE = "403: `code` 'app_not_issuable_by_fr' (an app outside fr's platform context — the fr bundle; nothing sent). ";

/** gated(): the caught validateAuth (own status), the super_admin gate, then the route's own refusals. */
const licResponses = (method: string, extra = ''): ResponseSpec[] =>
  caughtAuthResponses({ status: 'own', write: method !== 'GET' }, GATE + extra + LICENCES);

const isoOrNull = z.string().nullable();

/** licences `AppResponse`. */
const app = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    revoked: z.boolean(),
    audience: z.enum(['human', 'platform', 'automation']).describe("Who holds a licence: 'human' (end-user product), 'platform' (service-to-service), 'automation' (n8n action module)."),
    created_at: z.string(),
  })
  .passthrough();

/** licences `PlanResponse`. */
const plan = z
  .object({
    id: z.string(),
    app_id: z.string(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    region_id: z.string().nullable(),
    duration_days: z.number().int().nullable(),
    rate_limit_rpm: z.number().int().nullable().describe('Accepted and stored; enforced by nothing (fr#1046).'),
    rate_limit_burst: z.number().int().nullable().describe('Accepted and stored; enforced by nothing (fr#1046).'),
    quota_monthly: z.number().int().nullable(),
    token_budget_monthly: z.number().int().nullable(),
    revoked: z.boolean(),
    created_at: z.string(),
  })
  .passthrough();

/** licences `RegionResponse`. */
const region = z.object({ id: z.string(), code: z.string(), name: z.string(), active: z.boolean(), created_at: z.string() }).passthrough();

const planInfo = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    rate_limit_rpm: z.number().int().nullable(),
    rate_limit_burst: z.number().int().nullable(),
    quota_monthly: z.number().int().nullable(),
    token_budget_monthly: z.number().int().nullable(),
  })
  .passthrough();

/** licences `LicenseResponse` (never a token), without the joined `plan` block. */
const licenceBase = z
    .object({
      id: z.string(),
      subject_id: z.string(),
      tenant_id: z.string(),
      app_id: z.string(),
      plan_id: z.string(),
      region_id: z.string().nullable(),
      status: z.string().describe('STRUCTURAL status; `effective_status` resolves it against the time window.'),
      effective_status: z.string().nullable().describe("'active' | 'pending' | 'expired' | 'revoked'."),
      starts_at: z.string(),
      expires_at: isoOrNull,
      created_at: z.string(),
      updated_at: z.string(),
      revoked_at: isoOrNull,
      metadata: z.record(z.unknown()).nullable(),
      metering_provisioned_at: isoOrNull,
      metering_verified_at: isoOrNull,
      token_budget_override: z.number().int().nullable(),
      quota_override: z.number().int().nullable(),
      app: z.object({ id: z.string(), key: z.string(), name: z.string() }).passthrough().nullable(),
    })
    .passthrough();
/** The reads that join the plan (`_enrich_license_response`). */
const licence = licenceBase.extend({ plan: planInfo.nullable() });

/** licences `TenantResponse` (`Tenant.to_dict`). */
const tenant = z
  .object({
    id: z.string(),
    name: z.string(),
    keycloak_realm: z.string().nullable(),
    byo_mode: z.string().nullable().describe("'local_allowed', 'byo_required' or 'platform_only'."),
    budget_currency: z.enum(['EUR', 'USD', 'CAD']).nullable().describe('null: the tenant is token-budgeted; else money-budgeted in billing.'),
    kind: z.string().nullable().describe('customer | internal | service | test | unclassified.'),
    cost_centre: z.string().nullable(),
    owner_key: z.string().nullable().describe("The app that OWNS this tenant ('fr', 'commonpractice', …); names are unique per owner."),
    external_ref: z.string().nullable(),
    archived_at: isoOrNull.describe('null while live. Archiving revokes NOTHING (licences, tokens and budgets survive).'),
    created_at: isoOrNull,
  })
  .passthrough();

/** licences `OfferingResponse` (every field present; the nullable ones null). */
const money = z.number().nullable();
const offering = z
  .object({
    id: z.string(),
    app_id: z.string(),
    app_key: z.string().nullable(),
    code: z.string(),
    name: z.string(),
    byo_mode: z.string(),
    markup_pct: money,
    surcharge_input_per_1m_usd: money,
    surcharge_output_per_1m_usd: money,
    surcharge_cache_creation_per_1m_usd: money,
    surcharge_cache_read_per_1m_usd: money,
    surcharge_per_request_usd: money,
    access_price_usd: money,
    access_cadence: z.string().describe("'monthly' or 'one_time'."),
    included_allowance_usd: money,
    notes: z.string().nullable(),
    created_at: isoOrNull,
    updated_at: isoOrNull,
  })
  .passthrough();

/**
 * The offering body: fr checks the identity + posture fields it routes on (`CreateOfferingBody`, passthrough) and
 * forwards the WHOLE body verbatim to licences `OfferingCreate`, whose remaining fields are declared here with
 * licences' own types (end to end).
 */
const optMoney = z.number().min(0).nullable().optional();
const CreateOfferingInput = CreateOfferingBody.extend({
  markup_pct: optMoney.describe('Relative markup percent (licences validates >= 0).'),
  surcharge_input_per_1m_usd: optMoney,
  surcharge_output_per_1m_usd: optMoney,
  surcharge_cache_creation_per_1m_usd: optMoney,
  surcharge_cache_read_per_1m_usd: optMoney,
  surcharge_per_request_usd: optMoney,
  access_price_usd: optMoney.describe('Fixed access fee; null = free access.'),
  access_cadence: z.enum(['monthly', 'one_time']).optional().describe("Default 'monthly' (licences)."),
  included_allowance_usd: optMoney.describe('Monthly included-usage credit (USD).'),
  notes: z.string().nullable().optional(),
}).describe('fr checks app_key / code / name / byo_mode and forwards the body verbatim to licences OfferingCreate.');

const tenantOffering = z
  .object({
    app_key: z.string(),
    app_name: z.string(),
    byo_mode: z.string(),
    offering_code: z.string().nullable().describe('null = the provenance is UNKNOWN (set directly, or predates migration 025), NOT "no offering".'),
    offering_provenance: z.enum(['recorded', 'unknown']),
    created_at: isoOrNull,
    updated_at: isoOrNull,
  })
  .passthrough();

/** licences `InternalSeatCountResponse`. */
const seatCount = z
  .object({
    tenant_id: z.string(),
    seats: z.number().int(),
    subjects: z.number().int(),
    human_subjects: z.number().int().describe('THE BILLABLE BASIS (a person, not a principal).'),
    service_subjects: z.number().int(),
    unresolved_subjects: z.number().int().describe('Should read 0; nonzero is a schema regression, never a seat.'),
    basis: z.string().describe("'active_licences' | 'tenant_archived' | 'active_during_period'."),
    tenant_kind: z.string(),
    tenant_archived: z.boolean(),
    as_of: z.string(),
    app_key: z.string().nullable().describe('The product the count is scoped to; null = EVERY app (label it all-apps).'),
  })
  .passthrough();

const retained = z.object({ license_id: z.string(), tenant_id: z.string(), subject_id: z.string(), reason: z.string() });
const quotaResync = z.object({
  status: z.string().describe("'resynced', 'partial', or 'failed' (the call itself did not complete)."),
  ok: z.boolean(),
  licenses_found: z.number().int().nullable(),
  quotas_registered: z.number().int().nullable(),
  quotas_deregistered: z.number().int().nullable(),
  failures: z.array(z.string()),
});

const tokenMinted = z
  .object({
    token_id: z.string(),
    license_id: z.string(),
    token: z.string().describe('🔐 The raw token, returned ONCE.'),
    token_type: z.string(),
    created_at: z.string(),
    expires_at: isoOrNull,
    long_lived_owner: z.string().nullable(),
  })
  .passthrough();

const appId = { appId: pathId('The licences app id') };
const planId = { planId: pathId('The licences plan id') };
const subjectId = { subjectId: pathId('The Keycloak subject (sub) of the licence holder') };
const licenseId = { licenseId: pathId('The licences licence id') };
const nameOrId = { nameOrId: pathId('The licences tenant, by name or id') };
const appKey = { appKey: pathId('The product (app) key') };
const offeringKey = { ...appKey, code: pathId('The offering code') };
const flag = (what: string) => z.string().optional().describe(`${what} Only the literal 'true' counts.`);

type Group = 'catalog' | 'grants' | 'tenants' | 'budget' | 'offerings';
const group = (routes: SettingsRoute[]): ReadonlyArray<Capability<unknown, unknown>> =>
  settingsCapabilities(
    {
      area: 'licensing', tag: 'Licensing Console', tenancy: 'platform',
      module: 'src/routes/admin/licenses-admin.ts', load: () => import('../../routes/admin/licenses-admin'),
      rule: routeRule(isAuthenticatedSuperAdmin),
    },
    routes,
  );

const ROUTES: Record<Group, SettingsRoute[]> = {
  catalog: [
    {
      id: 'licensing.search_users', method: 'GET', path: '/api/admin/licenses/users', handler: 'handleSearchUsers', effect: 'read',
      summary: 'Find a person in Keycloak by email or name (the grant-form typeahead)',
      description: 'A query shorter than 2 characters answers an empty list without searching. At most 20 enabled accounts.',
      input: z.object({ q: z.string().optional().describe('Email or name fragment (2+ characters after trim).') }),
      output: z.object({
        users: z.array(z.object({ id: z.string(), email: z.string().nullable(), name: z.string(), username: z.string().nullable(), tenant_id: z.string().nullable() })),
      }),
      responses: licResponses('GET', "A Keycloak failure: `error.code` 'UPSTREAM_…' or 'SERVICE_AUTH_FAILED' (admin credentials unconfigured). "),
    },
    {
      id: 'licensing.list_apps', method: 'GET', path: '/api/admin/licenses/apps', handler: 'handleListApps', effect: 'read',
      summary: 'The app catalogue fr may issue (foreign-owned apps and test residue filtered out)',
      description: "Apps another owner issues (CommonPractice, w2v, merqi, …) are never listed. Test / demo residue keys are hidden unless `include_test`.",
      input: z.object({ include_test: flag('Also list test / demo residue apps.') }),
      output: z.array(app),
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.create_app', method: 'POST', path: '/api/admin/licenses/apps', handler: 'handleCreateApp', effect: 'write', successStatus: 201,
      summary: 'Register an app in the licences catalogue',
      description: "licences answers an existing key unchanged. `audience` / `issuers` cannot be sent (the body is strict): licences defaults them ('platform', fr).",
      input: CreateAppBody,
      output: app,
      responses: licResponses('POST', BODY),
    },
    {
      id: 'licensing.get_app', method: 'GET', path: '/api/admin/licenses/apps/:appId', handler: 'handleGetApp', effect: 'read',
      summary: 'One app of the licences catalogue', input: z.object(appId), output: app, responses: licResponses('GET'),
    },
    {
      id: 'licensing.delete_app', method: 'DELETE', path: '/api/admin/licenses/apps/:appId', handler: 'handleDeleteApp', effect: 'destructive',
      summary: "Delete an app — a HARD cascade of its plans, licences and tokens — deregistering each licence's billing quota first",
      description:
        'Each licence is revoked through provisioning (which deregisters its quota) BEFORE the app is destroyed. A revoke that fails ' +
        'does not stop the delete: the licence is NAMED in `retained_quota_licenses`. If the licences cannot be enumerated, nothing is deleted.',
      input: z.object(appId),
      output: z.object({
        app_id: z.string(),
        deleted: z.literal(true),
        licenses_found: z.number().int(),
        quotas_deregistered: z.number().int(),
        billing_quota_retained: z.boolean().describe('Derived from `retained_quota_licenses`.'),
        retained_quota_licenses: z.array(retained),
      }),
      responses: licResponses('DELETE'),
    },
    {
      id: 'licensing.list_app_plans', method: 'GET', path: '/api/admin/licenses/apps/:appId/plans', handler: 'handleListAppPlans', effect: 'read',
      summary: "One app's plans", input: z.object(appId), output: z.array(plan), responses: licResponses('GET'),
    },
    {
      id: 'licensing.list_app_licenses', method: 'GET', path: '/api/admin/licenses/apps/:appId/licenses', handler: 'handleListAppLicenses', effect: 'read',
      summary: "Every licence of one app, across every tenant", input: z.object(appId), output: z.array(licence), responses: licResponses('GET'),
    },
    {
      id: 'licensing.list_plans', method: 'GET', path: '/api/admin/licenses/plans', handler: 'handleListPlans', effect: 'read',
      summary: 'Every plan (revoked ones hidden by licences)', input: z.object({}), output: z.array(plan), responses: licResponses('GET'),
    },
    {
      id: 'licensing.create_plan', method: 'POST', path: '/api/admin/licenses/plans', handler: 'handleCreatePlan', effect: 'write', successStatus: 201,
      summary: 'Create a plan',
      description: 'An omitted `quota_monthly` / `token_budget_monthly` takes licences\' METERED default (1,000,000 / 50,000,000), not unlimited.',
      input: CreatePlanBody,
      output: plan,
      responses: licResponses('POST', BODY),
    },
    {
      id: 'licensing.update_plan', method: 'PATCH', path: '/api/admin/licenses/plans/:planId', handler: 'handleUpdatePlan', effect: 'write',
      summary: 'Update a plan; a `quota_monthly` change is re-applied to every live licence on it',
      description:
        'When the body names `quota_monthly`, provisioning re-applies it to each licence (billing snapshots the plan value at grant ' +
        'time). The re-apply is best effort: the edit stands, and the outcome is `quota_resync` / `quota_resync_ok` (absent otherwise).',
      input: z.object(planId).merge(UpdatePlanBody),
      output: plan.extend({ quota_resync: quotaResync.optional(), quota_resync_ok: z.boolean().optional() }),
      responses: licResponses('PATCH', BODY),
    },
    {
      id: 'licensing.delete_plan', method: 'DELETE', path: '/api/admin/licenses/plans/:planId', handler: 'handleDeletePlan', effect: 'destructive', successStatus: 204,
      summary: 'Delete a plan no licence references',
      input: z.object(planId),
      output: z.null(),
      responses: licResponses('DELETE', "409: licences' conflict, relayed (`error.code` 'UPSTREAM_CONFLICT'): licences still reference the plan. "),
    },
    {
      id: 'licensing.list_regions', method: 'GET', path: '/api/admin/licenses/regions', handler: 'handleListRegions', effect: 'read',
      summary: 'The licence regions', input: z.object({}), output: z.array(region), responses: licResponses('GET'),
    },
    {
      id: 'licensing.create_region', method: 'POST', path: '/api/admin/licenses/regions', handler: 'handleCreateRegion', effect: 'write', successStatus: 201,
      summary: 'Create a licence region', input: CreateRegionBody, output: region, responses: licResponses('POST', BODY),
    },
  ],
  grants: [
    {
      id: 'licensing.list_grants', method: 'GET', path: '/api/admin/licenses/grants', handler: 'handleListAllLicenses', effect: 'read',
      summary: 'Every licence, across every tenant (soft-deleted ones excluded)', input: z.object({}), output: z.array(licence), responses: licResponses('GET'),
    },
    {
      id: 'licensing.revoke', method: 'POST', path: '/api/admin/licenses/grants/revoke', handler: 'handleRevoke', effect: 'destructive',
      summary: 'Revoke a whole licence (all its tokens, quota deregistered) or ONE raw token',
      description:
        'Exactly one of `license_id` / `token`. `X-Target-Tenant-Id` (the licence\'s tenant) is REQUIRED: licences masks a tenant ' +
        'mismatch as "not found" and leaves the licence working. A licence revoke goes through provisioning (its billing quota is ' +
        'deregistered; `billing_quota_retained` reports an orphan); a token revoke stays on licences and answers its body.',
      input: RevokeBody,
      output: z.object({
        revoked: z.boolean().describe('Licence arm: false = it was already revoked (its quota still deregistered). Token arm: always true.'),
        message: z.string(),
        billing_quota_retained: z.boolean().optional().describe('Licence arm only.'),
      }),
      secrets: { input: ['/token'] },
      headers: TARGET_HEADER(true),
      responses: licResponses(
        'POST',
        BODY + TARGET + "404: `error.code` 'UPSTREAM_NOT_FOUND' — the licence is absent or another tenant's, or licences revoked nothing (the token is STILL ACTIVE). ",
      ),
    },
    {
      id: 'licensing.list_subject_grants', method: 'GET', path: '/api/admin/licenses/grants/user/:subjectId', handler: 'handleListSubjectLicenses', effect: 'read',
      summary: "One person's licences",
      description:
        '`X-Target-Tenant-Id` is REQUIRED by fr (400 without it) and forwarded, but licences applies no tenant filter for a ' +
        "`license-admin` caller — which fr's service account is — so the list holds the person's licences in EVERY tenant. An " +
        'unknown subject is an empty list. licences does not join the plan on this read (its `plan` is always null), so no plan ' +
        'block is declared.',
      input: z.object(subjectId),
      output: z.array(licenceBase),
      headers: TARGET_HEADER(true),
      responses: licResponses('GET', TARGET),
    },
    {
      id: 'licensing.create_grant', method: 'POST', path: '/api/admin/licenses/grants/user/:subjectId', handler: 'handleCreateLicense', effect: 'write', successStatus: 201,
      summary: 'Grant a person a licence (through provisioning, so its billing quota registers) and return its first token',
      description:
        '`X-Target-Tenant-Id` (the tenant the licence lands in) is REQUIRED. The app must be one fr issues. `quota_registered` false ' +
        '(`partial_failures`) is a licence billing does NOT meter: render it as degraded, never as a plain success. The token is shown ONCE. ' +
        '(The body also carries `token_error`, always null since the mint moved into provisioning: not declared.)',
      input: z.object(subjectId).merge(CreateLicenseBody),
      output: z.object({
        license: z.object({ id: z.string() }),
        token: z.string().nullable().describe('🔐 The raw token, shown ONCE; null on an idempotent provisioning replay.'),
        quota_registered: z.boolean(),
        partial_failures: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
      secrets: { output: ['/token'] },
      headers: TARGET_HEADER(true),
      responses: licResponses('POST', TARGET + BODY + NOT_ISSUABLE + "Any provisioning status is relayed the same way. "),
    },
    {
      id: 'licensing.delete_subject_grants', method: 'DELETE', path: '/api/admin/licenses/grants/user/:subjectId', handler: 'handleDeleteSubjectLicenses', effect: 'destructive',
      summary: "Revoke every active licence a person holds in one tenant (quota deregistered)",
      description: '`X-Target-Tenant-Id` is REQUIRED. `deleted` is the number revoked; 0 is a real answer (the person held none there).',
      input: z.object(subjectId),
      output: z.object({ deleted: z.number().int(), quotas_deregistered: z.number().int(), billing_quota_retained: z.boolean() }),
      headers: TARGET_HEADER(true),
      responses: licResponses('DELETE', TARGET + "Any provisioning status is relayed (`error.code` 'UPSTREAM_…'). "),
    },
    {
      id: 'licensing.mint_token', method: 'POST', path: '/api/admin/licenses/grants/:licenseId/tokens', handler: 'handleMintToken', effect: 'write', successStatus: 201,
      summary: 'Mint an additional token for a licence (shown ONCE)',
      description: 'Always bounded: an omitted `expires_days` is 365. The tenant is the licence\'s own (read from licences), never the caller\'s.',
      input: z.object(licenseId).merge(MintTokenBody),
      output: tokenMinted,
      secrets: { output: ['/token'] },
      responses: licResponses('POST', BODY),
    },
    {
      id: 'licensing.regenerate_token', method: 'POST', path: '/api/admin/licenses/grants/:licenseId/regenerate-token', handler: 'handleRegenerateToken', effect: 'destructive',
      summary: "Rotate a licence's tokens: revoke them all and mint one replacement (shown ONCE)",
      description:
        '`X-Target-Tenant-Id` is forwarded when present. licences refuses a rotation that cannot carry a live expiry forward (409 ' +
        "`license_not_active` / `all_tokens_expired` / `all_tokens_revoked`, relayed): nothing was revoked.",
      input: z.object(licenseId),
      output: z
        .object({
          token: z.string().describe('🔐 The replacement token, shown ONCE.'),
          message: z.string(),
          expires_at: isoOrNull.describe('null = perpetual (until revoked).'),
        })
        .passthrough(),
      secrets: { output: ['/token'] },
      headers: TARGET_HEADER(false),
      responses: licResponses('POST'),
    },
  ],
  tenants: [
    {
      id: 'licensing.list_tenants', method: 'GET', path: '/api/admin/licenses/tenants', handler: 'handleListTenants', effect: 'read',
      summary: 'The licences tenants (archived and service-actor ones only on request)',
      input: z.object({ include_archived: flag('Also list archived tenants.'), include_service_actors: flag("Also list `kind='service'` auth principals.") }),
      output: z.array(tenant),
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.create_tenant', method: 'POST', path: '/api/admin/licenses/tenants', handler: 'handleCreateTenant', effect: 'write', successStatus: 201,
      summary: 'Create a licences tenant owned by fr',
      description:
        'NOT idempotent by name: a name fr already holds is 409 `tenant_name_taken`. A known `external_ref` returns that tenant ' +
        '(still 201 here). A name only another app holds creates a NEW tenant. `keycloak_realm` is immutable afterwards.',
      input: CreateTenantBody,
      output: tenant,
      responses: licResponses('POST', BODY + "409: `code` 'tenant_name_taken'. "),
    },
    {
      id: 'licensing.get_tenant', method: 'GET', path: '/api/admin/licenses/tenants/:nameOrId', handler: 'handleGetTenant', effect: 'read',
      summary: 'One licences tenant, by name or id', input: z.object(nameOrId), output: tenant, responses: licResponses('GET'),
    },
    {
      id: 'licensing.list_tenant_offerings', method: 'GET', path: '/api/admin/licenses/tenants/:nameOrId/offerings', handler: 'handleListTenantOfferings', effect: 'read',
      summary: "What a tenant has been provisioned, per product (its per-product BYO posture rows)",
      description: 'An empty list = no per-product overrides: every product resolves to the tenant-wide `byo_mode`.',
      input: z.object(nameOrId),
      output: z.array(tenantOffering),
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.get_tenant_seat_count', method: 'GET', path: '/api/admin/licenses/tenants/:nameOrId/seat-count', handler: 'handleGetTenantSeatCount', effect: 'read',
      summary: "A tenant's billable seat count (billing's per-seat denominator)",
      description:
        'WITHOUT `app` the count aggregates EVERY app the tenant holds (`app_key` null): label it all-apps. An unknown tenant is a 404 ' +
        "and an unknown app key a 422 `app_not_found` (relayed) — never a 0. `basis` tells an archived tenant's 0 from a real one. " +
        'licences also returns `period_start` / `period_end`, always null here (fr never requests a period count): not declared.',
      input: z.object({
        ...nameOrId,
        as_of: z.string().optional().describe('ISO-8601: count at a past instant (a closed billing period).'),
        app: z.string().optional().describe('Scope the count to ONE product (app key).'),
      }),
      output: seatCount,
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.set_tenant_archived', method: 'PATCH', path: '/api/admin/licenses/tenants/:nameOrId/archive', handler: 'handleSetTenantArchived', effect: 'write',
      summary: 'Archive (or restore) a tenant — a "do not provision here" flag that revokes NOTHING',
      input: z.object(nameOrId).merge(ArchiveTenantBody),
      output: tenant,
      responses: licResponses('PATCH', BODY),
    },
    {
      id: 'licensing.rename_tenant', method: 'PATCH', path: '/api/admin/licenses/tenants/:nameOrId', handler: 'handleRenameTenant', effect: 'write',
      summary: "Rename a tenant (the name is an identifier: anything addressing the old name breaks)",
      input: z.object(nameOrId).merge(RenameTenantBody),
      output: tenant,
      responses: licResponses('PATCH', BODY),
    },
    {
      id: 'licensing.get_byo_mode', method: 'GET', path: '/api/admin/licenses/tenants/:nameOrId/byo-mode', handler: 'handleGetByoMode', effect: 'read',
      summary: "A tenant's EFFECTIVE BYO posture, optionally for one product",
      input: z.object({ ...nameOrId, app: z.string().optional().describe('Resolve the posture for this product key.') }),
      output: z
        .object({
          tenant_id: z.string(),
          name: z.string(),
          byo_mode: z.string().describe("'local_allowed', 'byo_required' or 'platform_only' (the per-product override, else the tenant-wide value)."),
          app: z.string().nullable(),
          resolution: z.string().describe("Where `byo_mode` came from: 'row' (read from a row) — a failed read answers 503 here, never a fabricated value."),
        })
        .passthrough(),
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.set_tenant_byo_mode', method: 'PATCH', path: '/api/admin/licenses/tenants/:nameOrId/byo-mode', handler: 'handleSetTenantByoMode', effect: 'write',
      summary: "Set a tenant's tenant-wide BYO posture",
      input: z.object(nameOrId).merge(ByoModeBody),
      output: tenant,
      responses: licResponses('PATCH', BODY),
    },
    {
      id: 'licensing.set_tenant_app_byo_mode', method: 'PUT', path: '/api/admin/licenses/tenants/:nameOrId/apps/:appKey/byo-mode', handler: 'handleSetTenantAppByoMode', effect: 'write',
      summary: "Set a per-product BYO posture override for a tenant",
      input: z.object({ ...nameOrId, ...appKey }).merge(ByoModeBody),
      output: z
        .object({
          tenant_id: z.string(),
          tenant_name: z.string(),
          app_id: z.string(),
          app_key: z.string(),
          byo_mode: z.string(),
          offering_code: z.string().nullable(),
          prior_offering_code: z.string().nullable(),
          prior_byo_mode: z.string().nullable().describe('The override this write replaced; null when it created the row.'),
        })
        .passthrough(),
      responses: licResponses('PUT', BODY),
    },
    {
      id: 'licensing.clear_tenant_app_byo_mode', method: 'DELETE', path: '/api/admin/licenses/tenants/:nameOrId/apps/:appKey/byo-mode', handler: 'handleClearTenantAppByoMode', effect: 'destructive', successStatus: 204,
      summary: 'Drop a per-product BYO override (the tenant-wide posture applies again)',
      description: 'Idempotent: 204 whether or not an override existed (licences\' `cleared` flag is not relayed).',
      input: z.object({ ...nameOrId, ...appKey }),
      output: z.null(),
      responses: licResponses('DELETE'),
    },
  ],
  budget: [
    {
      id: 'licensing.list_budget_packages', method: 'GET', path: '/api/admin/licenses/budget-packages', handler: 'handleListBudgetPackages', effect: 'read',
      summary: 'The token top-up packages (none while top-up is disabled)',
      input: z.object({}),
      output: z.object({ packages: z.array(topupPackage), topupEnabled: z.boolean() }),
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.top_up_tenant', method: 'POST', path: '/api/admin/licenses/budget/topup/:tenantId', handler: 'handleTopUpTenant', effect: 'write', successStatus: 201,
      summary: "Top up ANY tenant's token budget with a package",
      description:
        'Disabled until payment processing exists (BUDGET_TOPUP_ENABLED): then 409 `topup_unavailable` after the gate, before the ' +
        'body is read. Idempotent on (tenant, `idempotency_key`): a replay answers 200 with `idempotent_replay`.',
      input: z.object({ tenantId: pathId('The tenant whose budget is topped up') }).merge(TopupBody),
      output: topupAllocated,
      responses: [
        {
          status: 200,
          description: "An idempotent replay: this `idempotency_key` was already used for the tenant; the ORIGINAL's outcome, nothing allocated again.",
          schema: topupAllocated.extend({ status: z.enum(['pending', 'allocated', 'failed']), idempotent_replay: z.literal(true) }),
        },
        ...caughtAuthResponses(
          { status: '401', write: true },
          GATE +
            "409: `error` 'topup_unavailable' (top-up disabled; nothing read or written). " + BODY +
            "404: `error` \"unknown package '…'\" (`packages`: the ids). Any billing status of the allocation is relayed (`error.code` 'UPSTREAM_…'). ",
        ),
      ],
    },
    {
      id: 'licensing.get_tenant_budget', method: 'GET', path: '/api/admin/licenses/budget/:tenantId', handler: 'handleGetTenantBudget', effect: 'read',
      summary: "ANY tenant's aggregate token budget (billing's, relayed)",
      description: 'A tenant with no budgets (billing 404) is an empty aggregate.',
      input: z.object({ tenantId: pathId('The tenant (id or registered name)') }),
      output: budgetStatus,
      responses: caughtAuthResponses({ status: 'own' }, GATE + "Any billing status is relayed (`error.code` 'UPSTREAM_…'). "),
    },
    {
      id: 'licensing.reset_tenant_budget', method: 'POST', path: '/api/admin/licenses/budget/reset/:tenantId', handler: 'handleResetTenantBudget', effect: 'destructive',
      summary: "Zero EVERY consumed token counter a tenant holds",
      description:
        'The allowances survive; only `consumed_tokens` is zeroed, so the full budget is available again. ' +
        'Relays billing\'s report — `reset_count`, `budget_ids` and the `previous_consumed_total` the reset destroyed — ' +
        'rather than a bare success. A downstream failure is NOT rolled back: re-read the budget to see the new state.',
      input: z.object({ tenantId: pathId('The tenant whose consumed counters are reset') }).merge(ResetTenantBudgetBody),
      output: z.object({
        tenant_id: z.string(),
        reset_count: z.number().int().describe('How many budget rows were reset (0 is a legitimate answer: nothing to zero).'),
        budget_ids: z.array(z.string()).describe('The budget rows that were touched.'),
        previous_consumed_total: z.number().describe('The consumed total the reset destroyed, summed over the reset rows.'),
      }),
      responses: licResponses('POST', BODY + "Any billing status is relayed (`error.code` 'UPSTREAM_…'). "),
    },
    {
      id: 'licensing.adjust_license_budget', method: 'PATCH', path: '/api/admin/licenses/budget/line/:licenseId', handler: 'handleAdjustLicenseBudget', effect: 'write',
      summary: "Set or CLEAR one licence's token-budget override",
      description:
        '`token_budget_override: null` clears the override and falls back to the plan\'s `token_budget_monthly` — it is not "leave it alone". ' +
        "The body and response are the licences service's own and are relayed unchanged; re-read the tenant's budget for the resulting rows.",
      input: z.object({ licenseId: pathId('The licences licence id whose budget row is adjusted') }).merge(LicenseBudgetBody),
      output: z
        .object({
          license_id: z.string().optional().describe('The licence the override now applies to, when licences echoes it.'),
          token_budget_override: z.number().int().nullable().optional().describe('The stored override; null means the plan allowance applies.'),
        })
        .passthrough(),
      responses: licResponses('PATCH', BODY),
    },
  ],
  offerings: [
    {
      id: 'licensing.list_offerings', method: 'GET', path: '/api/admin/licenses/offerings', handler: 'handleListOfferings', effect: 'read',
      summary: 'The offerings (per-product usage + access policy templates)',
      input: z.object({ app: z.string().optional().describe('Only this product key.') }),
      output: z.object({ offerings: z.array(offering) }),
      responses: licResponses('GET'),
    },
    {
      id: 'licensing.create_offering', method: 'POST', path: '/api/admin/licenses/offerings', handler: 'handleCreateOffering', effect: 'write', successStatus: 201,
      summary: 'Create or update an offering (upsert by app + code)',
      input: CreateOfferingInput,
      output: offering,
      responses: licResponses('POST', BODY.replace('; an unknown key is refused', '; unknown keys are forwarded') + NOT_ISSUABLE),
    },
    {
      id: 'licensing.get_offering', method: 'GET', path: '/api/admin/licenses/offerings/:appKey/:code', handler: 'handleGetOffering', effect: 'read',
      summary: 'One offering', input: z.object(offeringKey), output: offering, responses: licResponses('GET'),
    },
    {
      id: 'licensing.delete_offering', method: 'DELETE', path: '/api/admin/licenses/offerings/:appKey/:code', handler: 'handleDeleteOffering', effect: 'destructive', successStatus: 204,
      summary: 'Delete an offering',
      description: "Idempotent: 204 whether or not one existed (licences' `deleted` flag is not relayed).",
      input: z.object(offeringKey),
      output: z.null(),
      responses: licResponses('DELETE'),
    },
    {
      id: 'licensing.provision_tenant_offering', method: 'POST', path: '/api/admin/licenses/tenants/:nameOrId/offerings/:appKey/:code', handler: 'handleProvisionTenantOffering', effect: 'write', successStatus: 201,
      summary: 'Materialise an offering onto a tenant: the posture row, the billing markup rule and (priced / with an allowance) the access charge',
      description: 'The two `*_provisioned` flags are the honest report: false when the offering carried nothing for that axis. A failed billing write is 502 (relayed).',
      input: z.object({ ...nameOrId, ...offeringKey }),
      output: z
        .object({
          tenant_id: z.string(),
          tenant_name: z.string(),
          app_key: z.string(),
          code: z.string(),
          byo_mode: z.string(),
          markup_rule_provisioned: z.boolean(),
          access_charge_provisioned: z.boolean(),
        })
        .passthrough(),
      responses: licResponses('POST', NOT_ISSUABLE),
    },
    {
      id: 'licensing.unprovision_tenant_offering', method: 'DELETE', path: '/api/admin/licenses/tenants/:nameOrId/offerings/:appKey/:code', handler: 'handleUnprovisionTenantOffering', effect: 'destructive',
      summary: "Remove an offering's posture override from a tenant (the billing markup rule SURVIVES: billing has no markup-rule delete)",
      input: z.object({ ...nameOrId, ...offeringKey }),
      output: z
        .object({
          tenant: z.string(),
          app_key: z.string(),
          code: z.string(),
          posture_cleared: z.boolean(),
          note: z.string().describe('The fixed disclosure that the billing markup rule survives.'),
        })
        .passthrough(),
      responses: licResponses('DELETE'),
    },
  ],
};

export const LICENSING_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...group(ROUTES.catalog),
  ...group(ROUTES.grants),
  ...group(ROUTES.tenants),
  ...group(ROUTES.budget),
  ...group(ROUTES.offerings),
];
