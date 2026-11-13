// src/routes/admin/licenses-admin-schemas.ts
//
// The request-body schemas of the super-admin licensing console
// (routes/admin/licenses-admin.ts), moved verbatim (fr-agui P4c part 3) so the
// capability declarations (capabilities/admin/licensing.ts) describe the SAME
// contract the handlers enforce. Side-effect free: zod + lib/admin-token-limits.

import { z } from 'zod';

import { ADMIN_TOKEN_TYPES, MAX_ADMIN_TOKEN_EXPIRES_DAYS } from '../../lib/admin-token-limits';

export const BYO_MODES = ['local_allowed', 'byo_required', 'platform_only'] as const;

// ---------------------------------------------------------------------------
// Schemas — `.strict()` so a typo'd field is a 422, not a silent no-op
// ---------------------------------------------------------------------------

export const CreateAppBody = z
  .object({
    // Mirrors the registry's app_key shape. license-authz compares app_key
    // literally, so an underscore/hyphen slip mints licenses that look valid
    // but fail closed at the edge (see licenses migration 015, which had to
    // rename `skill_builder` -> `skill-builder` for exactly this reason).
    key: z
      .string()
      .min(1)
      .max(255)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'key must be lowercase alphanumeric + hyphen (never underscore — the edge compares app_key literally)',
      ),
    name: z.string().min(1).max(255),
    description: z.string().max(4000).nullable().optional(),
  })
  .strict();

// ⛔ `rate_limit_rpm` / `rate_limit_burst` BELOW ARE ACCEPTED AND FORWARDED,
// AND ENFORCED BY NOTHING — measured 2026-09-26, fr#1046.
//
// Whole-tree grep of `origin/main` @ 34acdf7f: every occurrence outside tests
// is a write schema (here), a pass-through type (`services/licenses.ts`
// 156-157 / 730-731 / 876-877 / 889-890, and the mirrored frontend types), or
// a frontend display/edit surface. NOT ONE is a comparison. Positive control
// for that zero — the identical grep shape finds a real enforcing read
// elsewhere in this same tree: `routes/client-errors.ts:237`
// (`if (bucket.count >= RATE_LIMIT_MAX)`), so "no comparison" is a
// measurement, not a broken pattern.
//
// ⭐ THE SHARPEST CONTROL IS IN THIS FILE. `handleUpdatePlan` below (see its
// doc comment, and `if ('quota_monthly' in patch)`) detects a change to the
// SIBLING field `quota_monthly` and re-applies it to every live license
// through provisioning, because billing snapshots the plan value at grant time
// and would otherwise "carry the OLD value" — the handler's own words. A plan
// field that an enforcer consumes needs exactly that propagation. There is no
// equivalent block for `rate_limit_rpm`, and there is nothing to propagate it
// TO. Same handler, same PATCH, two fields: one reaches an enforcer, the other
// reaches nobody.
//
// ⭐ THE REASON IT IS LABELLED RATHER THAN ENFORCED IS NOT "fr cannot count".
// The two request-path guards, `lib/require-fr-license.ts` and
// `lib/require-kag-license.ts`, call `GET /licenses/active` and read
// active/inactive only; THE PLAN OBJECT CARRYING THESE FIELDS IS NEVER FETCHED
// ON A REQUEST PATH. There is nothing to enforce against, whatever counter you
// bring.
//
// ⚠️ CORRECTED 2026-09-26 (same day, first draft of this block): this said
// "the three limiters fr does have". There are FOUR, and the fourth refutes the
// "new subsystem, not a reuse" framing — `lib/decision-rate-limit.ts` is
// enforced against `approval_decisions.decided_at` for the same `approver_id`,
// "keyed on the DECIDER's identity, not on the request path" and "against the
// DB rather than in memory so it holds across pods, restarts and channels
// alike" (its words), shared by `routes/approvals.ts` and the telegram /
// signal / teams webhooks. A cross-pod, cross-seat counter already ships here.
// The other three (`routes/client-errors.ts`, `routes/me/licenses.ts`
// REGEN_BUCKETS, `routes/tools/kag.ts` RATE_LIMIT_MAX_CONCURRENT) are
// per-route, in-process and read module constants — under multiple replicas
// they already permit N× their nominal rate, which is a fact about those three
// routes and not about fr's capability.
//
// ⭐ DELIBERATELY NOT FIXED BY MUTATING THE RESPONSE. This file is a thin
// proxy on purpose (see the header): annotating the proxied plan shape with an
// fr-invented `rate_limit_enforced` flag would create exactly the second
// source of truth the header forbids. The honesty is applied where the value
// is shown to a human instead — `frontend/src/lib/admin/rate-limit-enforcement.ts`
// carries the full finding, and the admin screens render "(not enforced)".
// The fields stay accepted: a value an operator already set is data, and
// fr#1046 lists five open business questions (scope, null semantics, subject,
// bulk-caller behaviour, cross-replica counter location) that enforcement must
// settle before any limiter is built.
export const CreatePlanBody = z
  .object({
    app_id: z.string().uuid(),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    description: z.string().max(4000).nullable().optional(),
    region_id: z.string().uuid().nullable().optional(),
    duration_days: z.number().int().positive().nullable().optional(),
    rate_limit_rpm: z.number().int().nonnegative().nullable().optional(),
    rate_limit_burst: z.number().int().nonnegative().nullable().optional(),
    quota_monthly: z.number().int().nonnegative().nullable().optional(),
    token_budget_monthly: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const UpdatePlanBody = z
  .object({
    name: z.string().min(1).max(255).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    duration_days: z.number().int().positive().nullable().optional(),
    rate_limit_rpm: z.number().int().nonnegative().nullable().optional(),
    rate_limit_burst: z.number().int().nonnegative().nullable().optional(),
    quota_monthly: z.number().int().nonnegative().nullable().optional(),
    token_budget_monthly: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const CreateRegionBody = z
  .object({
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(255),
    active: z.boolean().optional(),
  })
  .strict();

export const CreateLicenseBody = z
  .object({
    app_id: z.string().uuid(),
    plan_id: z.string().uuid(),
    region_id: z.string().uuid().nullable().optional(),
    starts_at: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

/**
 * The tenant name shape, shared by create and rename.
 *
 * One definition on purpose: a rename that accepted a name `createTenant`
 * rejects would let an operator walk a tenant into a name the edge cannot
 * match (licence-authz compares tenant names literally), and no create-path
 * test would ever see it.
 */
export const TenantName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'tenant name must be lowercase alphanumeric + hyphen');

export const CreateTenantBody = z
  .object({
    name: TenantName,
    keycloak_realm: z.string().max(255).nullable().optional(),
    // fr's own stable id for the tenant. Licences (migration 050) makes
    // `POST /tenants` idempotent on (owning app, external_ref) — the ONLY
    // idempotent path now that a name is no longer one.
    external_ref: z.string().min(1).max(255).nullable().optional(),
  })
  .strict();

/**
 * Rename only. `.strict()` so a `keycloak_realm` slipped in here is a 422.
 *
 * `keycloak_realm` IS SETTABLE AT CREATE AND IMMUTABLE AFTERWARDS — BY DESIGN,
 * stated here because the absence of an update path is otherwise indistinguishable
 * from an oversight, and the next reader's instinct will be to "finish" the CRUD.
 *
 * A tenant's realm is where its identities live. Re-pointing an existing tenant at
 * a different realm does not migrate anything: every user, role grant and session
 * stays in the old realm while fr starts resolving against the new one, so the
 * tenant keeps its licences and budgets and loses its people. That is a
 * re-homing operation with a data-migration story, not a field edit — and it has
 * no caller. The read-back path exists (`TenantRecord.keycloak_realm`, rendered on
 * both the tenant list and the detail page), which is what an operator actually
 * needs: to SEE which realm a tenant is bound to.
 *
 * If a genuine re-homing requirement appears, it wants its own endpoint that moves
 * the identities too — not a widened PATCH body.
 */
export const RenameTenantBody = z.object({ name: TenantName }).strict();

/**
 * Archive/restore. `archived` is REQUIRED and boolean — not optional-defaulting
 * to true — so `PATCH {}` cannot archive a tenant by accident, and a restore is
 * always an explicit `false` rather than an omission.
 */
export const ArchiveTenantBody = z.object({ archived: z.boolean() }).strict();

export const ByoModeBody = z.object({ byo_mode: z.enum(BYO_MODES) }).strict();

/**
 * Zero a tenant's consumed counters (billing `POST /api/budget/reset/{tenant_id}`).
 *
 * `reason` is REQUIRED and nullable, not optional: this is a destructive
 * operator action that hands a tenant its whole allowance back, and the
 * billing-side audit trail is the only record of why. A caller that has no
 * reason must say so explicitly with `null` rather than omit the field.
 */
export const ResetTenantBudgetBody = z
  .object({
    reason: z.string().max(2000).nullable(),
  })
  .strict();

/**
 * Per-licence budget override (licences `PATCH /licenses/{license_id}/budget`).
 *
 * `token_budget_override: null` is a real instruction — CLEAR the override and
 * fall back to the plan's `token_budget_monthly` — so the field is required and
 * nullable, never omitted: an omission would be indistinguishable from a clear.
 * A negative allowance is meaningless, so it is refused here rather than passed
 * to an upstream that would have to decide what it means.
 */
export const LicenseBudgetBody = z
  .object({
    token_budget_override: z.number().int().nonnegative().nullable(),
    reason: z.string().max(2000).nullable().optional(),
  })
  .strict();

/**
 * Revoke EITHER a whole license (`license_id`, killing all its tokens) OR a
 * single raw token. Exactly one — upstream accepts both fields and silently
 * prefers one; making that ambiguity a 422 here keeps the operator's intent
 * unambiguous on a destructive call.
 */
export const RevokeBody = z
  .object({
    license_id: z.string().uuid().optional(),
    token: z.string().min(1).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.license_id) !== Boolean(b.token), {
    message: 'provide exactly one of license_id or token',
  });

// fr#1372: `expires_days` (not an ISO `expires_at`) is what upstream accepts,
// and only as a query parameter — `adminMintToken` moves it there. Omitted means
// DEFAULT_ADMIN_TOKEN_EXPIRES_DAYS, never perpetual.
export const MintTokenBody = z
  .object({
    token_type: z.enum(ADMIN_TOKEN_TYPES).optional(),
    expires_days: z.number().int().min(1).max(MAX_ADMIN_TOKEN_EXPIRES_DAYS).optional(),
  })
  .strict();

/**
 * Offering shape is passed through largely as-is: it is a commercial policy
 * object the licenses service owns and validates (markup/surcharge/access
 * price/allowance), and re-specifying every field here would just create a
 * second contract to drift. We pin the identity + posture fields we route on.
 */
export const CreateOfferingBody = z
  .object({
    app_key: z.string().min(1),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    byo_mode: z.enum(BYO_MODES),
  })
  .passthrough();
