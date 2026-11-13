// fr-agui SPEC §13 P4c part 3 — spec drain: super-admin user provisioning
// (routes/admin/super-admin.ts: POST /api/admin/super-admin/{provision,deprovision}-user),
// re-expressed with NO behaviour change (`legacyHandler`).
//
// Both handlers catch every validateAuth refusal and answer `{ error: 'unauthorized' }`
// with its own status (the conveyor write door: 403), then require the `super_admin`
// realm role (403 'super-admin only'). The target tenant is the body's `tenant_slug`,
// never the request tenant: `tenancy: 'platform'`, `isAuthenticatedSuperAdmin`.
//
// 🔐 Provisioning yields one-time secrets exactly once (a replay returns none): the
// temporary password and the licence tokens, for the primary user AND every
// additional seat, are `secrets.output`. A BYO provider key in the inference block is
// `secrets.input` (refused today: setup 3 is not yet available).
import { z } from 'zod';

import { DeprovisionUserBody, ProvisionUserBody } from '../../routes/admin/super-admin-schemas';
import type { Capability } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { caughtAuthResponses, routeRule, settingsCapabilities } from '../observe/_shared';

const GATE = "403: `error` 'super-admin only' (not a super_admin). ";
const BODY = "422: `error` 'invalid request body' (`details`: the zod issues; an unknown key is refused). 400: `error` 'invalid JSON body'. ";

const grantSync = z
  .enum(['disabled', 'added', 'already', 'skipped_no_tenant', 'skipped_tenant_mismatch', 'skipped_super_admin', 'skipped_user_absent', 'failed'])
  .describe('The Keycloak realm tenant_admin write-through outcome (workspace-admin grants only).');

const tokensByApp = z.record(z.string()).describe('🔐 app key → the licence token minted NOW, shown ONCE. Empty on a replay.');
const licenseIds = z.record(z.string()).describe('app key → licence id (the audit / revoke handle).');
const tempPassword = z.string().nullable().describe('🔐 The temporary password, shown ONCE; null when none was minted (an existing account is never rotated; a replay mints nothing).');

const seat = z.object({
  email: z.string(),
  status: z.enum(['provisioned', 'replayed', 'failed']).describe('A failed seat fails nothing else and rolls nothing back.'),
  error: z.string().optional().describe('`failed` only: the upstream sentence.'),
  user_id: z.string().optional(),
  already_existed: z.boolean().optional(),
  temporary_password: tempPassword.optional(),
  magic_link_sent: z.boolean().optional(),
  tokens: tokensByApp.optional(),
  license_ids: licenseIds.optional(),
  warnings: z.array(z.string()).optional(),
  partial_failures: z.array(z.string()).optional(),
});

/** lib/inference-provisioning.ts `InferenceOutcome` (present only when the request carried `inference`). */
const inferenceOutcome = z.object({
  status: z.enum(['success', 'partial', 'failed']),
  policy_version: z.number().nullable(),
  idempotency_key: z.string(),
  replayed: z.boolean(),
  steps: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'skipped', 'failed']), detail: z.record(z.unknown()) })),
  smoke: z.array(
    z.object({
      tier: z.string(),
      served_provider: z.string().nullable(),
      policy_version: z.number().nullable(),
      llm_setup: z.number().nullable(),
      key_owner: z.string().nullable(),
      verified: z.boolean().describe('True ONLY when provisioning reported its IR ledger read-back matched.'),
    }),
  ),
  error: z.string().optional(),
});

const provisioned = z.object({
  catalogue: z.union([
    z.object({ status: z.literal('imported'), result: z.unknown() }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]).describe("The tenant's PM catalogue import (requirements_management import-defaults); a failure is reported, never rolled back."),
  user_id: z.string(),
  keycloak_sync: grantSync.optional(),
  tenant_id: z.string(),
  already_existed: z.boolean(),
  temporary_password: tempPassword,
  magic_link_sent: z.boolean(),
  replayed: z.boolean().describe('An identical (email, tenant_slug) run already succeeded: ids, but NO one-time secrets.'),
  tokens: tokensByApp,
  license_ids: licenseIds,
  budget_id: z.string().nullable().describe('The manual token budget; null when the request carried `inference` (money-budgeted).'),
  inference: inferenceOutcome.optional(),
  provisioning_status: z.string().describe("provisioning's own: success | succeeded_with_warnings | partial."),
  warnings: z.array(z.string()).describe('COSMETIC degradations.'),
  partial_failures: z.array(z.string()).describe('MATERIAL degradations (e.g. the billing quota did not register).'),
  seats: z.array(seat).describe('One per `additional_seats` entry, in request order (always an array).'),
  app_plans: z.record(z.string()).nullable().describe('The plan choice this run sent; null when none was supplied.'),
});

/** routes/admin/super-admin-member.ts `ProvisionMemberResult` — the `tenant_id` (existing-tenant) mode. */
const memberProvisioned = z.object({
  mode: z.literal('existing_tenant'),
  user_id: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  already_existed: z.boolean().describe('The account existed AND already belonged to this tenant (any other tenant is a 409).'),
  temporary_password: tempPassword.describe(
    '🔐 The temporary password, shown ONCE. Issued for a new account, and for an existing same-tenant account that holds no ' +
      'password credential (a previous run failed before setting one). null for an existing account that already has a password: it is never rotated.',
  ),
  magic_link_sent: z.boolean(),
  replayed: z.literal(false),
  workspace_role: z.enum(['admin', 'member']),
  realm_role: z.enum(['added', 'already']).describe('The direct Keycloak realm `member` mapping.'),
  keycloak_sync: grantSync.optional(),
  warnings: z.array(z.string()),
});

export const PROVISIONING_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'provisioning', tag: 'User Provisioning', tenancy: 'platform',
    module: 'src/routes/admin/super-admin.ts', load: () => import('../../routes/admin/super-admin'),
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'provisioning.provision_user', method: 'POST', path: '/api/admin/super-admin/provision-user', handler: 'handleProvisionUser', effect: 'write', successStatus: 201,
      summary: 'Onboard a person (and optional further seats) into a tenant through the provisioning engine',
      description:
        'provisioning resolves the tenant (`tenant_slug`), creates the Keycloak account, mints a licence per app and registers its ' +
        'billing quota; fr adds the workspace role, the token budget and the audit row. It is NOT transactional: every pre-flight ' +
        'refusal answers before anything is minted, and a failed seat is reported per person. Idempotent on (email, tenant_slug). ' +
        '`inference` is accepted only while FR_INFERENCE_PROVISIONING is on and needs the owner\'s own verified portal token. ' +
        'EXISTING-TENANT mode: send `tenant_id` instead of `tenant_slug` (exactly one) to add a human member to a tenant that ' +
        'already exists (any tenant licences resolves for fr by id). It mints NO tenant, licence, budget or seat — `apps`, ' +
        '`app_plans`, `additional_seats`, `inference`, `monthly_budget_tokens` and `phone_e164` are refused — assigns the realm ' +
        'role `member`, and never re-tenants an existing account. `workspace_role` defaults to `member` in this mode.',
      input: ProvisionUserBody,
      output: z.union([provisioned, memberProvisioned]),
      secrets: { input: ['/inference/byo_keys/api_key'], output: ['/temporary_password', '/tokens', '/seats/temporary_password', '/seats/tokens'] },
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        GATE + BODY +
          "422: `error` 'inference_provisioning_disabled', 'app_plans_for_unrequested_apps', 'apps_not_in_fr_bundle' (`apps`: any key other than fr / fr-frontend), " +
          "'apps_not_for_people' or 'apps_without_active_plan' (`detail`; nothing attempted). 403: `error` 'owner_portal_token_required' " +
          "(an inference block without the owner's verified portal token). 503: `error` 'catalogue_unreadable' / " +
          "'catalogue_missing_audience' (the licences catalogue cannot say which apps a person may hold; nothing attempted). 409: " +
          "`error.code` licences' refusal (e.g. 'tenant_name_taken') or 'provisioning_conflict' (`error.upstream`). Any provisioning " +
          "status is relayed (`error.code` 'UPSTREAM_…'). 500: `error` 'provisioning failed' (`detail`). " +
          "Existing-tenant mode: 404 `error` 'tenant_not_found' (licences does not resolve the id for fr); 409 `error` " +
          "'tenant_archived', or 'tenant_divergence' (`user_id`, `existing_tenant_id`: the account belongs to another tenant; " +
          "nothing changed). ",
      ),
    },
    {
      id: 'provisioning.deprovision_user', method: 'POST', path: '/api/admin/super-admin/deprovision-user', handler: 'handleDeprovisionUser', effect: 'destructive',
      summary: "Offboard a person: reverse their provisioning run (the Keycloak account, that run's licences and billing quota)",
      description:
        'Addressed by the same (email, tenant_slug) the provision used. The shared registry tenant and every fr-local artefact ' +
        '(`fr_local_retained`) are kept. A replay answers `already_deprovisioned`.',
      input: DeprovisionUserBody,
      output: z.object({
        keycloak_user_deleted: z.boolean().describe('false: the account was already gone.'),
        licenses_deleted: z.number().int(),
        tenant_id: z.string().nullable(),
        tenant_retained: z.boolean().describe('Always true: a tenant is never destroyed by offboarding one person.'),
        billing_quota_retained: z.boolean(),
        already_deprovisioned: z.boolean(),
        fr_local_retained: z.array(z.string()),
      }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        GATE + BODY +
          "404: `error` 'no provisioning run to reverse' (`detail`; nothing deleted). Any provisioning status is relayed " +
          "(`error.code` 'UPSTREAM_…'). 500: `error` 'deprovisioning failed' (`detail`). " +
          "409: `error` 'last_tenant_member' (`detail`, `tenant_id`, `signup_id`): the tenant was founded by an early-access " +
          "signup and nobody else holds a role in it, so " +
          "offboarding only this person would strand its tenant-level licences — remove the early-access workspace " +
          "(POST /api/signup-approvals/:id/remove) instead; nothing was called. 502: `error` 'last_member_check_failed' (nothing called). ",
      ),
    },
  ],
);
