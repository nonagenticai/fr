// src/routes/admin/super-admin-schemas.ts
//
// The request-body schemas of POST /api/admin/super-admin/{provision,deprovision}-user,
// moved verbatim out of routes/admin/super-admin.ts (fr-agui P4c part 3) so the
// capability declarations (capabilities/admin/provisioning.ts) describe the SAME
// contract the handlers enforce. Side-effect free: zod + lib/inference-input-schema.

import { z } from 'zod';

import { FR_APP_KEY } from '../../lib/fr-app-key';
import { InferenceInputSchema } from '../../lib/inference-input-schema';

/**
 * Upper bound on `additional_seats` in ONE provision request.
 *
 * Not a licensing limit — a request-shape limit. Each seat is its own full
 * provisioning run (tenant resolve + Keycloak account + licence + quota
 * registration per app), walked SEQUENTIALLY so one person's failure cannot be
 * confused with another's, inside a synchronous HTTP request. 25 keeps the
 * worst case inside a sane request budget; a larger onboarding belongs in a job.
 */
export const MAX_ADDITIONAL_SEATS = 25;

/**
 * The fields that are REFUSED (422) when the body names an existing tenant by
 * `tenant_id`. Adding a member to an existing tenant mints NO licence, budget or
 * seat (George 2026-10-10: the tenant holds the licence), so every field that
 * only feeds those mints is a request this mode cannot honour — accepting and
 * ignoring it would discard an operator's choice silently. `phone_e164` is here
 * because its only writer is the new-tenant path's attribute merge.
 */
export const EXISTING_TENANT_REFUSED_FIELDS = [
  'apps',
  'app_plans',
  'additional_seats',
  'inference',
  'monthly_budget_tokens',
  'phone_e164',
] as const;

const ProvisionUserObject = z
  .object({
    email: z.string().email(),
    name: z.string().min(1),
    phone_e164: z
      .string()
      .regex(/^\+\d{10,15}$/, 'phone_e164 must be E.164 (e.g. +14155551234)')
      .optional(),
    /**
     * New-tenant mode: the slug the provisioning engine resolves (or mints) an
     * fr-owned tenant by. Exactly one of `tenant_slug` / `tenant_id`.
     */
    tenant_slug: z
      .string()
      .regex(
        /^[a-z0-9-]{2,40}$/,
        'tenant_slug must be 2-40 chars of [a-z0-9-]',
      )
      .optional(),
    /**
     * Existing-tenant mode: add a human MEMBER to the tenant with this id (any
     * owner fr can resolve, e.g. a platform-owned service tenant fr holds a
     * grant on). Never mints a tenant, licence, budget or seat, and never
     * re-tenants an existing account. Exactly one of `tenant_slug` / `tenant_id`;
     * the fields in EXISTING_TENANT_REFUSED_FIELDS are refused alongside it, and
     * `workspace_role` defaults to `member` instead of `admin`.
     *
     * Lower-cased at parse time (a uuid is case-insensitive, Keycloak attribute
     * values and fr's tenant keys are not): the stamped `tenant_id` attribute,
     * the divergence comparison and the tenant user-cache key all see ONE form.
     */
    tenant_id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    /**
     * fr's LOCAL workspace role. Its default is MODE-SPECIFIC (`admin` with
     * `tenant_slug`, `member` with `tenant_id`), so the schema carries NO zod
     * default: a schema-level default is served as one OpenAPI `default` for both
     * modes, and a spec-generated client would then send `admin` into an existing
     * tenant. The default is filled after parsing (ProvisionUserBody below).
     */
    workspace_role: z
      .enum(['admin', 'member'])
      .optional()
      .describe(
        'Default depends on the mode: `admin` with `tenant_slug` (the founding person of a new tenant), ' +
          '`member` with `tenant_id` (a person added to an existing tenant). Omit it to get that default.',
      ),
    // Any app key in the licenses catalog — validated against the LIVE catalog
    // in the orchestrator below (unknown key -> UPSTREAM_NOT_FOUND naming the
    // available keys), not pinned to a literal here.
    //
    // This used to be `z.enum(['fr-frontend'])`: a one-value enum that made
    // provisioning structurally incapable of granting a license for any of the
    // 28 other app_keys license-authz enforces at the edge. The orchestrator
    // below was always key-agnostic — the enum alone was the cage.
    //
    // The default is `['fr', 'fr-frontend']`: `fr` (FR_APP_KEY) is the key fr's own licence gate
    // (lib/require-fr-license.ts) requires, so a default provision that omitted it founded a
    // workspace the gate then refused ("No active license for this workspace"). It used to be
    // `['fr-frontend']` alone — the same drift as the 2026-10-20 early-access signup defect.
    // The shape check is deliberately loose (non-empty strings): the catalog is
    // the source of truth for which keys exist, and duplicating it here would
    // be a second list to drift.
    //
    // "Is this key appropriate for a HUMAN" is NOT checked here any more. It
    // used to be a `.refine()` against a literal set, and that literal existed
    // only because a zod refine is synchronous and cannot await the catalogue.
    // The answer is now `app.audience` in the licences service, so the refusal
    // lives in the pre-flight in `handleProvisionUser`, which already reads the
    // catalogue. A rejected key therefore comes back as a 422 with a named
    // `error` code rather than a zod issue — see `apps_not_for_people`.
    apps: z.array(z.string().min(1).max(255)).min(1).default([FR_APP_KEY, 'fr-frontend']),
    /**
     * OPTIONAL per-app licence plan choice: `app_key` → plan uuid.
     *
     * Omitted (the default) is byte-identical to the previous behaviour:
     * provisioning mints each licence against that app's first non-revoked plan.
     * Supplying an entry makes the operator's choice binding — provisioning
     * refuses a plan that is not active for that app with a 400 raised in its own
     * pre-flight, before anything is minted, and never falls back silently.
     *
     * The value shape is the only thing checked here. "Is this plan active for
     * that app" is the licences service's fact, asserted by the engine; "is this
     * app one the caller actually requested" is checked in the orchestrator below
     * (`app_plans_for_unrequested_apps`) because the engine ignores such an entry
     * silently, which would discard a choice without anyone noticing.
     */
    app_plans: z.record(z.string().min(1), z.string().uuid()).optional(),
    /**
     * OPTIONAL further people to onboard into the SAME tenant, each of whom ends
     * up holding their own licence for the same `apps` (and the same
     * `app_plans`).
     *
     * ⚠️ This is what "buying N seats" IS, and why there is no seat-COUNT field
     * here. A seat is a LICENCE ROW: billing derives a tenant's seat count by
     * COUNTING active `license` rows at query time
     * (licences `GET /internal/tenants/{id}/seat-count`), there is no
     * `seats`/`quantity` column anywhere, and licences carries a unique index
     * permitting at most ONE active licence per (tenant, app, subject). So N
     * seats is N SUBJECTS each holding a licence — a number field would be a
     * second source of truth that nothing enforces and nothing bills.
     *
     * Capped at 25: the loop is sequential (each person is a multi-second
     * fan-out through provisioning → licences → Keycloak → billing) and this
     * request is synchronous. A bulk import beyond that wants a job, not a
     * console POST.
     */
    additional_seats: z
      .array(
        z
          .object({
            email: z.string().email(),
            name: z.string().min(1),
          })
          .strict(),
      )
      .max(MAX_ADDITIONAL_SEATS)
      .optional(),
    monthly_budget_tokens: z.number().int().positive().default(1_000_000),
    send_password_reset_email: z.boolean().default(true),
    /**
     * OPTIONAL — the owner's per-tenant inference decision (PLAN
     * tenant-inference-provisioning §2.6). Accepted only while
     * FR_INFERENCE_PROVISIONING is on (else 422 `inference_provisioning_disabled`,
     * nothing attempted). When present: every seat call sends `byo_mode` +
     * `budget_currency` (EUR | USD | CAD, the owner's choice), the manual TOKEN
     * budget below is skipped (the tenant is money-budgeted by provisioning's
     * apply), and provisioning
     * `inference/apply` runs ONCE after the seat loop. Absent = today's flow,
     * byte-identical. See lib/inference-provisioning.ts.
     */
    inference: InferenceInputSchema.optional(),
  })
  .strict();

/**
 * Mode exclusivity runs on the RAW body, before the object schema applies its
 * defaults: `apps`, `monthly_budget_tokens` and `workspace_role` all carry
 * defaults, so a refinement on the parsed value could not tell "the caller sent
 * apps" from "zod filled them in". `workspace_role` has no schema default at all:
 * the trailing transform gives it its mode-specific default (`member` for an
 * existing tenant, `admin` otherwise) after the mode is known.
 */
export const ProvisionUserBody = z.preprocess((raw, ctx) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = raw as Record<string, unknown>;
  const hasId = body.tenant_id !== undefined;
  const hasSlug = body.tenant_slug !== undefined;
  if (hasId === hasSlug) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasId ? 'tenant_id' : 'tenant_slug'],
      message: hasId
        ? 'send exactly one of tenant_slug (new tenant) or tenant_id (existing tenant), not both'
        : 'one of tenant_slug (new tenant) or tenant_id (existing tenant) is required',
    });
  }
  if (!hasId) return raw;
  for (const field of EXISTING_TENANT_REFUSED_FIELDS) {
    if (body[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message:
          `${field} is not accepted with tenant_id: adding a member to an existing tenant ` +
          'mints no licence, budget or seat (the tenant already holds them)',
      });
    }
  }
  return raw;
}, ProvisionUserObject).transform((body) => ({
  ...body,
  workspace_role: body.workspace_role ?? (body.tenant_id !== undefined ? ('member' as const) : ('admin' as const)),
}));

export type ProvisionUserInput = z.output<typeof ProvisionUserBody>;

/** A parsed body in new-tenant (slug) mode. */
export type SlugProvisionInput = ProvisionUserInput & { tenant_slug: string; tenant_id?: undefined };

/** A parsed body in existing-tenant (member) mode. */
export type ExistingTenantProvisionInput = ProvisionUserInput & { tenant_id: string; tenant_slug?: undefined };

export function isExistingTenantInput(body: ProvisionUserInput): body is ExistingTenantProvisionInput {
  return typeof body.tenant_id === 'string';
}

export const DeprovisionUserBody = z
  .object({
    email: z.string().email(),
    tenant_slug: z
      .string()
      .regex(
        /^[a-z0-9-]{2,40}$/,
        'tenant_slug must be 2-40 chars of [a-z0-9-]',
      ),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type DeprovisionUserInput = z.infer<typeof DeprovisionUserBody>;

/** POST /api/admin/super-admin/resend-set-password-email (routes/admin/super-admin-resend.ts). */
export const ResendSetPasswordEmailBody = z
  .object({ user_id: z.string().uuid().transform((s) => s.toLowerCase()) })
  .strict();
export type ResendSetPasswordEmailInput = z.infer<typeof ResendSetPasswordEmailBody>;
