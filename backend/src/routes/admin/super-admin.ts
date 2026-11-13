// src/routes/admin/super-admin.ts
//
// Spec 2 Task 4 — super-admin user provisioning HTTP surface.
//
//   GET  /api/me/super-admin                        — `{ is_super_admin: bool }`
//   POST /api/admin/super-admin/provision-user      — onboard
//   POST /api/admin/super-admin/deprovision-user    — offboard
//
// FULL-UNIFY Phase 2b
// -------------------
// This endpoint used to re-implement provisioning in TypeScript: it minted its
// own tenant uuid, called Keycloak createUser/setPassword/sendUpdatePasswordEmail
// itself, inserted the `workspaces` row, and minted a license + regenerated a
// token per app straight against the licenses service. It never registered the
// plan's monthly quota with billing — so every operator-provisioned license had
// NOTHING for license-authz to enforce at HTTP 402. That is the money gap Phase 2
// closed for the licensing console; this closes it for the operator console.
//
// The Python `provisioning` service is now the single engine for the whole
// identity+entitlement lifecycle. fr calls `POST /api/provision` and keeps only
// what provisioning does not own:
//
//   * the fr-LOCAL role grant (`user_roles`: workspace-admin / workspace-member)
//   * the manual metering TOKEN budget (a spend cap — a different axis from the
//     request quota provisioning registers with billing)
//   * the `provisioning_audit` row
//   * surfacing the one-time secrets to the operator
//
// ⚠️ `workspace_role` is two different things — see services/provisioning.ts
// `provisionUser()`. fr's admin/member value is a LOCAL DB role and is NEVER
// forwarded as provisioning's realm role.
//
// The audit row still opens `pending` first so a hard crash mid-orchestration
// leaves a trail; success/partial transitions are unchanged.
//
// Authorization model
// -------------------
// Both endpoints call `validateAuth`. The provision-user endpoint then gates
// on the `super_admin` Keycloak realm role (via `isSuperAdmin`). The GET
// endpoint reads the same gate, so a logged-in user always gets a 200 with a
// boolean — the frontend uses it to show/hide the super-admin nav entry.
//
// Note on the audit row: we INSERT a `pending` row first so a hard crash
// mid-orchestration still leaves a trail. On success we transition it to
// `success` with a populated `result` blob; on any thrown error we tag it
// `partial` (some downstream side effects may have already landed) with the
// error message captured in `error`. We do NOT roll back Keycloak / licenses
// /budget side effects on a downstream failure — the operator inspects the
// audit row and decides whether to retry or revoke.
//
// (`action` is constrained by migration 056 to
// provision_user | revoke_user | reissue_token, so the offboard audits as
// `revoke_user` — the closest existing value — with the finer intent recorded
// in `payload.operation`.)
//
// Metering priority semantic (verified against
//   ~/metering_service/src/services/budget.py:445-448):
//   ORDER BY (expires_at ASC NULLS LAST, priority ASC, starts_at ASC)
// ⇒ LOWER priority drains FIRST. The licenses-service auto-provisioned
// budget uses the metering default `priority=100`; we use `priority=50` for
// the manual override so it drains before the auto-budget.

import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { AppError, BadRequestError } from '../../utils/errors';
// `IntegrationError` is no longer CONSTRUCTED here: the old orchestration threw
// it by hand for "no such app key" / "no active plan", checks that now live in
// provisioning and reach us as real upstream statuses via services/provisioning.
import {
  isIntegrationError,
  integrationErrorResponse,
  type IntegrationError,
} from '../../integrations/_lib/errors';
import { db, provisioningAudit } from '../../db/client';
import { keycloakIdentityOps } from '../../services/signup/identity';
import { userRolesService } from '../../services/user-roles';
import { keycloak } from '../../services/keycloak';
import { deleteUser as deleteUserRealmUser, mergeUserAttributes } from '../../services/keycloak-admin';
import { prepareInUserRealm, type PreparedIdentity } from '../../services/user-realm-provision';
import { auditIdentityLedger } from '../../services/provisioning-identity-ledger';
import { syncTenantAdminGrant, type GrantSync } from '../../services/tenant-admin-sync';
import { isValidUuid } from '../../utils/tenant';
import { ensureWorkspace } from '../../services/workspaces';
import {
  deprovisionUser as deprovisionUserUpstream,
} from '../../services/provisioning';
import { createBudget, getBudgetStatus } from '../../services/metering-admin';
import { applyTenantInference } from '../../services/provisioning';
import { importPmCatalogueDefaults } from '../../integrations/pm-catalogue';
import { invalidateTenantCatalogue } from '../../services/catalogue/tenant-catalogue';
import {
  buildApplyRequest,
  inferenceFlags,
  inferenceOutcomeForAudit,
  newApplyIdempotencyKey,
  normaliseApplyResult,
  ownerPortalToken,
  redactInferenceForAudit,
  type InferenceOutcome,
} from '../../lib/inference-provisioning';

// ---------------------------------------------------------------------------
// GET /api/me/super-admin
// ---------------------------------------------------------------------------

// The super-admin gate lives in `src/lib/super-admin-gate.ts` so the
// middleware (which runs on every request) can consult it without pulling
// the rest of this module's heavy import graph.
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { notPersonAppDetail, selectAppsNotFrPersonApps } from '../../lib/fr-issuable-apps';
import { FR_APP_KEY } from '../../lib/fr-app-key';
import {
  adminListApps,
  adminListPlans,
  LICENCES_OWNERSHIP_REFUSALS,
  licencesRefusalCode,
  type AppRecord,
  type PlanRecord,
} from '../../services/licenses';
import { emitSpan } from '../../telemetry/spans';
import {
  DeprovisionUserBody,
  ProvisionUserBody,
  isExistingTenantInput,
  type DeprovisionUserInput,
  type ProvisionUserInput,
  type SlugProvisionInput,
} from './super-admin-schemas';
import { provisionMemberIntoTenant } from './super-admin-member';
import type { User } from '../../types/api';

export async function handleGetSuperAdminStatus(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { status?: number; statusCode?: number }).statusCode
      ?? (e as { status?: number }).status
      ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }
  const is_super_admin = isSuperAdmin(user);
  return jsonResponse({ is_super_admin });
}

// ---------------------------------------------------------------------------
// POST /api/admin/super-admin/provision-user
// ---------------------------------------------------------------------------

/**
 * The apps a HUMAN can be provisioned onto — the enforcement half.
 *
 * The registry holds 47 apps; 7 are end-user products. The rest are internal
 * platform modules whose licences are held by SERVICES, or n8n custom-node
 * action packages held by automation. `seed_apps.py` says it outright: fr
 * drives kanban/n8n/kag/requirements on the user's behalf and "those need no
 * per-user license".
 *
 * Why this is enforced HERE and not in `GET /api/admin/licenses/apps`: that
 * endpoint also backs the grants console, the offerings editor and
 * per-(tenant,app) BYO mode, all of which legitimately operate on platform
 * apps. Narrowing the shared list would break them. Provisioning a PERSON is
 * the only place the distinction bites.
 *
 * Rejecting here is not merely cosmetic. Provisioning is NOT transactional
 * (`orchestration.py` records `status="partial"` and re-raises without
 * compensating), so an app that cannot succeed must be refused BEFORE the run
 * starts. Measured 2026-08-26: a run aborted 10.8s in on
 * `meta_prompt_core_actions` and left five already-minted licences orphaned.
 *
 * The classification is DATA now: `app.audience` in the licences service
 * (migration 022, values human | platform | automation). Two hardcoded copies
 * used to live here and in the frontend page-helpers, pinned by a drift test.
 * They are gone — a judgement about another service's data belongs with that
 * data, not in two copies here.
 *
 * The refusal moved with it. It used to be a synchronous zod `.refine()` on
 * the request body, which is why the list had to be a literal: a zod refine
 * cannot await a catalogue read. It now lives in the pre-flight below, which
 * was already fetching the catalogue for the active-plan check — so this costs
 * no extra round-trip.
 */

// MAX_ADDITIONAL_SEATS, ProvisionUserBody and ProvisionUserInput live in
// ./super-admin-schemas.ts (side-effect free, shared with the capability
// declarations in capabilities/admin/provisioning.ts); re-exported here.
export { MAX_ADDITIONAL_SEATS, type ProvisionUserInput, type DeprovisionUserInput } from './super-admin-schemas';
// POST /api/admin/super-admin/resend-set-password-email — explicit recovery, ./super-admin-resend.ts.
export { handleResendSetPasswordEmail } from './super-admin-resend';


/**
 * Outcome of ONE additional seat, reported per person.
 *
 * ⚠️ A failed seat does NOT fail the request and does NOT roll anything back.
 * Three measured reasons, not a convenience:
 *
 *   1. Provisioning is NOT transactional — `orchestration.py` records
 *      `status="partial"` and re-raises without compensating. There is nothing to
 *      roll back WITH. Failing the whole request would return a 5xx over a state
 *      where the primary user and the earlier seats are fully, correctly onboarded.
 *   2. The seats are INDEPENDENT people. Seat 4's typo'd address is not a reason
 *      to refuse seats 1-3, and "undoing" them would mean deprovisioning accounts
 *      and destroying licences the operator did not ask to destroy.
 *   3. Each seat is idempotent on its own (email, tenant_slug) key, so the honest
 *      repair is to re-send the request: the succeeded seats replay and the failed
 *      one is retried. That is only true if we do not destroy them first.
 *
 * So every seat is reported with its own status and its own error text, and the
 * caller is expected to render the failures rather than a single green tick.
 */
export interface ProvisionSeatResult {
  email: string;
  /**
   * `provisioned` — this call created/completed the run.
   * `replayed`    — an identical (email, tenant_slug) run already succeeded, so
   *                 ids came back but NO one-time secrets (see below).
   * `failed`      — nothing usable for this person; `error` says why. The other
   *                 seats and the primary user are unaffected.
   */
  status: 'provisioned' | 'replayed' | 'failed';
  /** Present only on `failed`: the upstream sentence, not a generic wrapper. */
  error?: string;
  /** Keycloak user id — absent on `failed`. */
  user_id?: string;
  /** True when the Keycloak account already existed (no password was rotated). */
  already_existed?: boolean;
  /**
   * The seat's one-time secrets, carried for the SAME reason the primary user's
   * are: provisioning yields them exactly once and a later replay returns
   * `null`/`{}` forever. Dropping them here would strand the seat holder with a
   * licence whose token nobody can ever read — the password is recoverable via
   * the magic link, a licence token is not.
   *
   * `temporary_password` is `null` (never `''`) when none was minted: an existing
   * account's password is deliberately not rotated, and a replay mints nothing.
   */
  temporary_password?: string | null;
  magic_link_sent?: boolean;
  /** app key → one-time licence token. Empty on a replay. */
  tokens?: Record<string, string>;
  /** app key → licence id (audit / revoke handle). */
  license_ids?: Record<string, string>;
  warnings?: string[];
  partial_failures?: string[];
}

/**
 * The tenant's PM catalogue seeding at provisioning (design: fr consumes RM
 * vocabulary — "no seeding by fr except via import-defaults at provisioning").
 * RM's import is idempotent by name and never overwrites, so a replayed
 * provision re-runs it harmlessly. `failed` is REPORTED (audit `partial`),
 * never rolled back: the identity, licences and quota already exist, and the
 * import is re-runnable from POST /api/admin/tenants/:tenantId/catalogue/import-defaults.
 */
type CatalogueImportOutcome =
  | { status: 'imported'; result: unknown }
  | { status: 'failed'; error: string };

export interface ProvisionUserResult {
  /** The tenant's PM catalogue import (RM import-defaults) — see CatalogueImportOutcome. */
  catalogue: CatalogueImportOutcome;
  user_id: string;
  /**
   * Keycloak realm `tenant_admin` write-through outcome (fr#1289). Present
   * only when the fr-local grant was `workspace-admin`.
   */
  keycloak_sync?: GrantSync;
  tenant_id: string;
  already_existed: boolean;
  /**
   * Plain-text temporary password — surfaced ONCE, or `null`.
   *
   * `null` is a REAL state, not an error: provisioning deliberately does not
   * rotate an already-existing user's password (rotating on every retry resets
   * a live portal credential out from under the person), and an idempotent
   * replay yields no one-time secrets at all. It used to be typed `string` and
   * fr minted a fresh temp password on EVERY call including the already-exists
   * branch — that password was set on the account, so the old behaviour was a
   * silent credential rotation on every operator retry.
   *
   * Consumers MUST NOT render `null` as an empty credential box: use
   * `already_existed` / `replayed` / `magic_link_sent` to say what actually
   * happened and what the recovery path is.
   */
  temporary_password: string | null;
  /** Keycloak's non-destructive UPDATE_PASSWORD magic link was sent. */
  magic_link_sent: boolean;
  /**
   * True when this hit an already-successful provisioning run for the same
   * (email, tenant_slug): identity ids are returned, one-time secrets are NOT.
   */
  replayed: boolean;
  /** Map of app key → freshly-minted license token. Shown ONCE. Empty on a replay. */
  tokens: Record<string, string>;
  /** Map of app key → license id (for future audit / revoke). */
  license_ids: Record<string, string>;
  /**
   * The manual TOKEN budget's id, or `null` when the request carried
   * `inference` — an EUR-budgeted tenant gets no manual token budget (its money
   * budget is written by provisioning's apply, see `inference`).
   */
  budget_id: string | null;
  /**
   * Present only when the request carried `inference`: provisioning apply's
   * steps and the per-tier smoke. A tier is `verified` ONLY when provisioning
   * reported its IR ledger read-back matched — never on an HTTP 200 alone.
   */
  inference?: InferenceOutcome;
  /** provisioning's own status: success | succeeded_with_warnings | partial. */
  provisioning_status: string;
  /** COSMETIC degradations (e.g. the magic-link email failed). */
  warnings: string[];
  /** MATERIAL degradations (e.g. the billing quota registration failed). */
  partial_failures: string[];
  /**
   * Per-person outcome for every `additional_seats` entry, in request order.
   * ALWAYS an array (empty when none were asked for) so a consumer never has to
   * distinguish "no seats" from "the field is missing". A `failed` entry here is
   * a real, reportable failure inside an otherwise 201 response — see
   * `ProvisionSeatResult`.
   */
  seats: ProvisionSeatResult[];
  /**
   * Echo of the plan choice this run actually SENT, so the response is
   * self-describing and the operator can see which plan each app was minted
   * against. `null` when none was supplied (engine default: first non-revoked).
   */
  app_plans: Record<string, string> | null;
}

/**
 * Which of `appKeys` have no grantable plan right now.
 *
 * An unknown key is NOT reported here — the engine already answers that with
 * an UPSTREAM_NOT_FOUND naming the available keys, and duplicating catalog
 * membership would be a second source of truth. This checks one thing only:
 * a known app whose plans are all missing or revoked.
 */
export type Preflight =
  | { ok: true; withoutActivePlan: string[]; notForPeople: string[] }
  | { ok: false; reason: 'catalogue_unreadable' | 'catalogue_missing_audience' };

/**
 * Both pre-flight questions, from ONE catalogue read.
 *
 * ⚠️ The two checks degrade in OPPOSITE directions, and that asymmetry is the
 * point:
 *
 *   * "no active plan" falls THROUGH on a degraded read. The catalogue is a
 *     guard there, not the authority — the engine raises its own 404, so
 *     blocking provisioning on a flaky read would be worse than the thing the
 *     check prevents.
 *   * "not for people" must REFUSE on a degraded read. It is the only thing
 *     standing between an operator and granting a person a licence for a
 *     service-to-service module. Falling through admits exactly what the guard
 *     exists to stop, and there is no second line behind it now that the
 *     hardcoded set is gone. Fail closed.
 *
 * The missing-`audience` case is separate from "nothing is human": a licences
 * deployment older than migration 022 omits the field on every row, and
 * treating that as "no app qualifies" would refuse every provision with a
 * message blaming the operator's app selection.
 */
async function preflightApps(appKeys: string[]): Promise<Preflight> {
  let apps: AppRecord[];
  let plans: PlanRecord[];
  try {
    [apps, plans] = await Promise.all([adminListApps(), adminListPlans()]);
  } catch {
    return { ok: false, reason: 'catalogue_unreadable' };
  }
  if (apps.length > 0 && apps.every((a) => a.audience === undefined)) {
    return { ok: false, reason: 'catalogue_missing_audience' };
  }
  return {
    ok: true,
    withoutActivePlan: selectAppsWithoutActivePlan(appKeys, apps, plans),
    notForPeople: selectAppsNotForPeople(appKeys, apps),
  };
}

/**
 * Requested keys the catalogue says are not for people.
 *
 * An UNKNOWN key is not reported here — same reasoning as
 * `selectAppsWithoutActivePlan`: catalogue membership is the engine's answer to
 * give, and duplicating it would be a second source of truth. A known key with
 * any audience other than `human` is refused, so a value this code has never
 * heard of is refused too rather than admitted by omission.
 */
export function selectAppsNotForPeople(
  appKeys: string[],
  apps: Pick<AppRecord, 'key' | 'audience'>[],
): string[] {
  const audienceByKey = new Map(apps.map((a) => [a.key, a.audience]));
  return appKeys.filter((key) => {
    if (!audienceByKey.has(key)) return false; // unknown key -> the engine's business
    return audienceByKey.get(key) !== 'human';
  });
}

/**
 * The set math behind `appsWithoutActivePlan`, split out so it is testable
 * without standing up the licences service.
 *
 * A plan counts only when it is not revoked — production carries revoked plans
 * whose app still shows a non-zero plan count, so "has rows" is the wrong
 * question and "has an unrevoked row" is the right one.
 */
export function selectAppsWithoutActivePlan(
  appKeys: string[],
  apps: Pick<AppRecord, 'id' | 'key'>[],
  plans: Pick<PlanRecord, 'app_id' | 'revoked'>[],
): string[] {
  const activeByAppId = new Set(plans.filter((p) => !p.revoked).map((p) => p.app_id));
  const idByKey = new Map(apps.map((a) => [a.key, a.id]));
  return appKeys.filter((key) => {
    const id = idByKey.get(key);
    if (id === undefined) return false; // unknown key -> the engine's business
    return !activeByAppId.has(id);
  });
}

export async function handleProvisionUser(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { status?: number; statusCode?: number }).statusCode
      ?? (e as { status?: number }).status
      ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  if (!isSuperAdmin(user)) {
    return jsonResponse({ error: 'super-admin only' }, 403);
  }

  let body: ProvisionUserInput;
  try {
    const raw = await req.json();
    body = ProvisionUserBody.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse(
        { error: 'invalid request body', details: e.errors },
        422,
      );
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    throw e;
  }

  // EXISTING-TENANT mode (`tenant_id`): add a member to a tenant that already
  // exists. Mints no tenant, licence, budget or seat — none of the slug path
  // below (pre-flight, engine, budget, seats, inference, catalogue) applies, and
  // the schema has already refused every field that would feed it.
  if (isExistingTenantInput(body)) {
    const memberBody = body;
    return emitSpan(
      'fr.provision.member',
      {
        'user.id': user.id,
        'target.email': memberBody.email,
        'tenant.id': memberBody.tenant_id,
        'workspace.role': memberBody.workspace_role,
      },
      () => provisionMemberIntoTenant(user, memberBody),
    );
  }
  // Exactly one of tenant_slug / tenant_id is guaranteed by the schema.
  const slugBody = body as SlugProvisionInput;

  // Inference (PLAN §2.6). Both refusals run BEFORE anything is attempted.
  let ownerToken: string | undefined;
  if (slugBody.inference) {
    if (!inferenceFlags().enabled) {
      return jsonResponse(
        {
          error: 'inference_provisioning_disabled',
          detail:
            'this deployment does not provision tenant inference (FR_INFERENCE_PROVISIONING is off). ' +
            'Nothing was attempted. Re-send without `inference`.',
        },
        422,
      );
    }
    // provisioning relays the owner's OWN portal JWT to IR, which authorises
    // that human. A caller whose token is not a verified human super_admin
    // portal token (a service account, an fr-agent token) cannot drive it.
    ownerToken = await ownerPortalToken(req);
    if (!ownerToken) {
      return jsonResponse(
        {
          error: 'owner_portal_token_required',
          detail:
            'tenant inference is applied on behalf of the signed-in owner, and no verified ' +
            'super_admin portal token was presented. Nothing was attempted.',
        },
        403,
      );
    }
  }

  // Provisioning fans out across provisioning → licenses → Keycloak → metering
  // and routinely takes seconds. Before this span it emitted NOTHING: the live
  // 2026-08-26 failure logged one access line (`404 10841.2ms`) and no reason,
  // so the cause had to be recovered from the UPSTREAM service's logs instead.
  // `emitSpan` derives `outcome` and `http.status_code` from the returned
  // Response, so a 4xx is recorded as an error without the call site claiming
  // an optimistic `outcome: 'ok'` (see telemetry/spans.ts).
  return emitSpan(
    'fr.provision.user',
    {
      'user.id': user.id,
      'target.email': slugBody.email,
      'tenant.slug': slugBody.tenant_slug,
      // The app keys are the field most likely to explain a refusal — the live
      // 404 was caused by exactly one of them lacking an active plan.
      'apps.count': slugBody.apps.length,
      'apps.keys': slugBody.apps.join(','),
      'workspace.role': slugBody.workspace_role,
      // The plan choice and the seat fan-out are the two things that change how
      // much work this span covers, so a slow or failed run can be read without
      // re-deriving them from the audit payload.
      'apps.plans_chosen': Object.keys(slugBody.app_plans ?? {}).length,
      'seats.additional': slugBody.additional_seats?.length ?? 0,
    },
    () => provisionUserImpl(user, slugBody, ownerToken),
  );
}

/**
 * The provisioning run itself. Split out from `handleProvisionUser` so the
 * span can carry attributes derived from the validated body while keeping the
 * auth/gate/parse rejections (401/403/422) out of the span — those are not
 * provisioning attempts and would skew the error rate.
 */
async function provisionUserImpl(
  user: User,
  body: SlugProvisionInput,
  ownerToken?: string,
): Promise<Response> {
  // Seat-call fields for an inference provision; `{}` otherwise, so a legacy
  // request's wire body is byte-identical.
  const seatInference = body.inference
    ? { byoMode: body.inference.byo_mode, budgetCurrency: body.inference.budget_currency }
    : {};
  // 00. fr provisions ONLY its own platform context per person: the fr bundle's
  //     `fr` + `fr-frontend` (George, 2026-10-14 / 2026-10-21). Kanban and n8n are
  //     shared fr platform accounts — nothing per person. Any other key (another
  //     platform's app, a tenant-level module, an unknown future key) is refused
  //     here, before any upstream call: licences would refuse a foreign mint only
  //     when the run reached it, after earlier apps were minted (provisioning is
  //     not transactional). See lib/fr-issuable-apps.ts.
  const notPersonApps = selectAppsNotFrPersonApps(body.apps);
  if (notPersonApps.length > 0) {
    return jsonResponse(
      {
        error: 'apps_not_in_fr_bundle',
        apps: notPersonApps,
        detail: notPersonAppDetail(notPersonApps),
      },
      422,
    );
  }
  // Always the gate's key: without an active `fr` licence the workspace this run
  // founds is refused by fr's own gate (same reasoning as `signupApps()`).
  if (!body.apps.includes(FR_APP_KEY)) body = { ...body, apps: [...body.apps, FR_APP_KEY] };

  // 0a. A plan chosen for an app that was not requested is a CALLER ERROR, and it
  //     is refused here because the engine cannot refuse it: provisioning reads
  //     `(req.app_plans or {}).get(key)` once per key in `app_keys`, so an entry
  //     keyed on anything else is silently dropped. Accepting it would mean an
  //     operator picks "Enterprise" for an app, gets a 201, and that choice
  //     reached nothing — the exact failure mode the engine-side change (#37) was
  //     made to kill, reappearing one layer up. No I/O, so it runs before the
  //     catalogue reads.
  const plannedKeys = Object.keys(body.app_plans ?? {});
  const unrequestedPlanKeys = plannedKeys.filter((k) => !body.apps.includes(k));
  if (unrequestedPlanKeys.length > 0) {
    return jsonResponse(
      {
        error: 'app_plans_for_unrequested_apps',
        detail:
          `app_plans names apps that are not in 'apps': ` +
          `${unrequestedPlanKeys.join(', ')}. A plan can only be chosen for an app ` +
          `being provisioned — provisioning would ignore these entries entirely, so ` +
          `the choice would be silently discarded. Nothing was attempted. Either add ` +
          `these app keys to 'apps' or drop them from 'app_plans'.`,
      },
      422,
    );
  }

  // 0. PRE-FLIGHT: refuse an app with no active plan BEFORE anything is minted.
  //
  //    provisioning walks the requested apps in order, minting a licence and a
  //    token for each, and raises 404 on the first one whose app has no active
  //    plan. It does NOT compensate — `orchestration.py` records
  //    `status="partial"` and re-raises. Measured 2026-08-26: a run died on
  //    app 6 of 6 and left five licences and five API tokens behind for a user
  //    who was never successfully provisioned. Re-running reuses the licences
  //    but mints ADDITIONAL tokens, so every retry deepens the mess.
  //
  //    Two catalog reads (not one per app) are cheap next to that.
  const pre = await preflightApps(body.apps);
  if (!pre.ok) {
    // Fail CLOSED. See `preflightApps` for why the audience check cannot fall
    // through the way the plan check does.
    return jsonResponse(
      {
        error: pre.reason,
        detail:
          pre.reason === 'catalogue_missing_audience'
            ? `the licences catalogue returned apps but none carry an 'audience'. ` +
              `That service predates migration 022, so fr cannot tell which apps ` +
              `may be granted to a person. Nothing was attempted. Deploy licences first.`
            : `the licences catalogue could not be read, so fr cannot tell which ` +
              `apps may be granted to a person. Nothing was attempted — retry once ` +
              `the licences service is reachable.`,
      },
      503,
    );
  }
  if (pre.notForPeople.length > 0) {
    return jsonResponse(
      {
        error: 'apps_not_for_people',
        detail:
          `not provisionable to a person: ${pre.notForPeople.join(', ')}. ` +
          `These are service-to-service or automation modules — fr drives them ` +
          `on the user's behalf and they need no per-user licence. Nothing was attempted.`,
      },
      422,
    );
  }
  // An app the caller chose an explicit plan for is NOT refused by the
  // no-active-plan guard. That guard answers "which plan would this app be minted
  // against?" — and an explicit `app_plans` entry IS the answer, so the question
  // it guards no longer applies.
  //
  // This cannot re-open the 2026-08-26 partial-mint hole the guard exists to
  // prevent, and that is measured rather than assumed: provisioning resolves
  // EVERY app's plan in its own `3a. PRE-FLIGHT` loop (orchestration.py) and
  // raises 400 `plan ... is not an active plan for licenses app ...` there, BEFORE
  // the mint loop runs. A bad explicit plan therefore aborts with nothing minted.
  //
  // It also avoids refusing a legitimate choice fr cannot see: the engine reads
  // plans TENANT-SCOPED (`list_plans(app_id, tenant_id=...)`) while fr's
  // `adminListPlans()` is the global view, so fr's catalogue is not authoritative
  // about what is grantable to THIS tenant. Keep the refusal for apps where no
  // plan was supplied AND none is active — there, fr's view is the only warning
  // the operator gets before a run that would abort part-way.
  const unplannedWithoutActivePlan = pre.withoutActivePlan.filter(
    (key) => !plannedKeys.includes(key),
  );
  if (unplannedWithoutActivePlan.length > 0) {
    return jsonResponse(
      {
        error: 'apps_without_active_plan',
        detail:
          `no active plan for: ${unplannedWithoutActivePlan.join(', ')}. ` +
          `Provisioning would mint licences for the other apps and then abort, ` +
          `so nothing was attempted. Create a plan for these apps first, or choose ` +
          `an existing plan explicitly via app_plans.`,
      },
      422,
    );
  }

  // 1. Open a `pending` audit row first so we always have a trail even if
  //    the orchestrator crashes mid-flight.
  const [auditRow] = await db
    .insert(provisioningAudit)
    .values({
      actor_user_id: user.id,
      action: 'provision_user',
      target_email: body.email,
      // Never the raw body once it can carry key material: `inference.byo_keys`
      // is reduced to provider names (lib/inference-provisioning).
      payload: (body.inference
        ? { ...body, inference: redactInferenceForAudit(body.inference) }
        : body) as unknown as Record<string, unknown>,
      result: {},
      status: 'pending',
    })
    .returning({ id: provisioningAudit.id });
  if (!auditRow) {
    throw new AppError(500, 'failed to open provisioning_audit row');
  }
  const auditId = auditRow.id;

  try {
    // 2. THE ENGINE, with the identity in fr's OWN realm (realm per app,
    //    2026-10-23 — services/user-realm-provision.ts): fr mints/resolves the
    //    Keycloak user in `config.keycloak.userRealm` and the engine adds the
    //    canonical tenant (registry-minted, idempotent by slug) + a license PER
    //    APP KEY with its plan's monthly quota REGISTERED with billing, for THAT
    //    identity (caller-owned: the engine creates no user and sends no email).
    //    Only after it lands does fr stamp `tenant_id`/`tenant_slug` (new
    //    account), issue the temp password and send the one magic link.
    //
    //    The idempotency key is deterministic on (email, tenant_slug): a retry
    //    replays instead of re-minting (upstream `regenerate_token` is NOT
    //    idempotent — a re-mint invalidates a token already handed out), and
    //    deprovision addresses this exact run by the same key.
    // ⛔ The account stays DISABLED and un-mailed until `prepared.activate()` — the LAST action
    //    of this route, after every step below (fail closed; one email, never two).
    const ledger = auditIdentityLedger(auditId);
    const prepared = await prepareInUserRealm({
      email: body.email,
      name: body.name,
      tenantSlug: body.tenant_slug,
      appKeys: body.apps,
      sendPasswordResetEmail: body.send_password_reset_email,
      // The operator's plan choice, forwarded verbatim. Absent/empty => the wire
      // body is byte-identical to before this field existed and the engine keeps
      // its first-non-revoked default.
      appPlans: body.app_plans,
      ...seatInference,
      // NOT body.workspace_role — that is fr's LOCAL role axis, granted below.
    }, ledger);
    const prov = prepared.prov;

    const tenantId = prov.tenant_id;
    const kcUserId = prov.keycloak_user_id;
    const warnings = [...prov.warnings];

    // 2b. Tenant-convergence check (the invariant fr#723 shipped, re-derived
    //     against the engine). provisioning stamps `tenant_id` on a user it
    //     CREATES, but Keycloak's 409 path never overwrites an existing user's
    //     attributes. So for an already-existing account the tenant the person's
    //     JWT derives (attribute, else `sub` — mirroring `deriveTenantId`) can
    //     differ from the registry tenant this slug resolves to; their license
    //     and quota would then sit in a tenant they never present.
    //
    //     We keep provisioning's tenant as canonical (it owns tenant identity,
    //     and it is where the license + quota actually live) and REPORT the
    //     divergence instead of silently writing a broken state. Do not "fix"
    //     this by re-tenanting the user — that fragments them away from the data
    //     they already own.
    if (prov.already_existed) {
      // ⚠️ A failed attribute read used to arrive here as `null`, which this
      // code reads as "no attribute, so the JWT tenant is the sub" — and then
      // reports a tenant DIVERGENCE that nobody measured. `getUserTenantId`
      // now throws instead, so an unread attribute is reported as unread.
      let attr: string | null = null;
      let attrRead = true;
      try {
        attr = await keycloak.getUserTenantId(kcUserId);
      } catch (err) {
        attrRead = false;
        warnings.push(
          `keycloak_tenant_unverified: could not read the existing account's ` +
            `Keycloak tenant attribute (${err instanceof Error ? err.message : String(err)}), ` +
            `so convergence with tenant ${tenantId} was NOT checked. This is not ` +
            `evidence of divergence — re-run the check once Keycloak answers.`,
        );
      }
      if (attrRead) {
        const effectiveJwtTenant = attr && isValidUuid(attr) ? attr : kcUserId;
        if (effectiveJwtTenant !== tenantId) {
          warnings.push(
            `keycloak_tenant_divergence: the existing account resolves to tenant ` +
              `${effectiveJwtTenant} from its Keycloak attributes, but tenant_slug ` +
              `'${body.tenant_slug}' resolves to ${tenantId}. The license and quota ` +
              `were provisioned under ${tenantId}; this user's JWT will not present it.`,
          );
        }
      }
    }

    // 2c. Phone attribute. provisioning's request shape carries no phone, so fr
    //     applies it itself — otherwise the console's optional `phone_e164` field
    //     would accept input and silently drop it. Fresh users only, mirroring
    //     the previous behaviour (Keycloak's create ignores attributes on the
    //     already-exists path, so an existing person's profile was never
    //     overwritten and must not start being overwritten now). Best-effort: a
    //     phone write must not fail an onboarding whose license already minted,
    //     but the failure IS reported rather than swallowed.
    if (body.phone_e164 && !prov.already_existed) {
      try {
        await mergeUserAttributes(kcUserId, { phone: [body.phone_e164] });
      } catch (phoneErr) {
        const detail =
          phoneErr instanceof Error ? phoneErr.message : String(phoneErr);
        console.warn(
          `[super-admin] phone attribute write failed for ${kcUserId}:`,
          detail,
        );
        warnings.push(`phone_attribute_write_failed: ${detail}`);
      }
    }

    // 3. fr-LOCAL role grant + workspace row. NOT provisioning's job:
    //    `user_roles` is fr's own table and `workspace-admin`/`workspace-member`
    //    are fr-local DB roles, a different axis from the Keycloak realm role
    //    provisioning assigns. The workspace row is fr's org root and shares its
    //    uuid with the tenant — so it must be the tenant PROVISIONING minted, not
    //    a locally-generated one (that was the fragmentation bug: a random uuid
    //    the user's JWT would never derive). `ensureWorkspace` is idempotent, so
    //    a retry that already owns the row is a no-op, not a duplicate-key 500.
    await ensureWorkspace(tenantId, body.tenant_slug);
    const role =
      body.workspace_role === 'admin' ? 'workspace-admin' : 'workspace-member';
    await userRolesService.grantRole(kcUserId, tenantId, role, user.id);
    // Keycloak write-through of realm `tenant_admin` (fr#1289). Never throws;
    // the DB grant stands on 'failed' and the outcome rides in the response.
    const keycloakSync: GrantSync | undefined =
      role === 'workspace-admin'
        ? await syncTenantAdminGrant(kcUserId, tenantId, user.id)
        : undefined;

    // 4. Licenses — already minted by the engine above, WITH their billing quota
    //    registered (the whole point of the repoint). Tokens are one-time: absent
    //    on an idempotent replay, so we only surface the ones we actually got
    //    rather than inventing entries for licenses whose token we cannot see.
    const tokens: Record<string, string> = {};
    const licenseIds: Record<string, string> = {};
    for (const grant of prov.licenses) {
      licenseIds[grant.app_key] = grant.license_id;
      if (grant.token != null) tokens[grant.app_key] = grant.token;
    }
    if (prov.partial_failures.length > 0) {
      // MATERIAL degradation (e.g. the billing quota registration failed → this
      // tenant may run with no enforced quota). provisioning records it; log it
      // here too and pass it to the operator in the response.
      console.warn(
        `[super-admin] provision ${prov.idempotency_key} degraded: ` +
          prov.partial_failures.join(', '),
      );
    }

    // 5. Manual budget override — IDEMPOTENT. Sits on top of the licenses-
    //    service's fire-and-forget auto-provisioned budget (priority=100,
    //    source='license_sync'). With LOWER-priority-drains-first ordering, our
    //    priority=50 manual budget is consumed BEFORE the auto-budget.
    //
    //    A retry of this provision — or a createBudget that COMMITTED at metering
    //    but timed out on the response — must NOT stack a second manual budget:
    //    per-tenant budgets MULTIPLY the period total. So reuse an existing
    //    manual monthly budget if one is already present and only create when
    //    there is none. (A truly concurrent double-provision of the same tenant
    //    still has a narrow create-create window; closing that needs a metering
    //    idempotency key — tracked as a follow-up.) Failure still aborts
    //    provisioning — the operator must see real metering errors.
    //
    //    SKIPPED when the request carries `inference`: that tenant is
    //    money-budgeted (provisioning's apply writes the money budget), and a
    //    manual token budget beside it would be a second, contradicting cap.
    let budget: { id: string } | null = null;
    if (!body.inference) {
      const existingBudget = await getBudgetStatus(tenantId);
      const priorManual = existingBudget.budgets.find(
        (b) => b.source === 'manual' && (b.period ?? 'monthly') === 'monthly',
      );
      budget =
        priorManual?.budget_id != null
          ? { id: priorManual.budget_id }
          : await createBudget({
              tenantId,
              budgetTokens: body.monthly_budget_tokens,
              period: 'monthly',
              source: 'manual',
              priority: 50,
            });
    }

    // 5b. ADDITIONAL SEATS. One more provisioning run per person, into the SAME
    //     tenant_slug, with the SAME apps and the SAME plan choice.
    //
    //     Why N runs and not one request with a quantity: a seat IS a licence row.
    //     billing counts active `license` rows to answer seat-count, and licences
    //     permits at most ONE active licence per (tenant, app, subject) — so the
    //     only way to hold N seats is to have N subjects each holding a licence.
    //     There is deliberately no seat-count field to keep in sync with that.
    //
    //     Each person's idempotency key is derived from (their email, tenant_slug),
    //     so these are distinct runs, not a collision — and re-sending the whole
    //     request replays the ones that already succeeded instead of re-minting.
    //
    //     SEQUENTIAL on purpose: provisioning is not transactional, and a
    //     concurrent fan-out would race on the shared tenant resolve/create and
    //     make a failure impossible to attribute to one person.
    //
    //     ⛔ A seat failure is REPORTED, never rolled back and never promoted to a
    //     request failure — see `ProvisionSeatResult` for the three reasons. The
    //     PRIMARY user's failure still fails the request (it throws out of this
    //     try block and tags the audit row `partial`), because without the primary
    //     there is no onboarding to report seats against.
    //
    //     ⚠️ NOT done per seat, and named rather than hidden: the 2b
    //     tenant-convergence check. An additional seat whose Keycloak account
    //     already existed may derive a DIFFERENT tenant from its own attributes
    //     than the one its licence was minted under, exactly as for the primary
    //     user — `already_existed` is surfaced per seat so the case is visible,
    //     but no per-seat Keycloak attribute read is performed here (it would be
    //     one extra round-trip per seat inside an already slow request). Do not
    //     read the absence of a seat warning as evidence of convergence.
    //
    //     Also deliberately NOT repeated per seat: the fr-LOCAL role grant and the
    //     metering token budget. The budget is PER TENANT and per-tenant budgets
    //     MULTIPLY the period total, so creating one per seat would silently
    //     inflate the tenant's spend cap by N. The `user_roles` grant is fr's own
    //     membership axis with its own surface (`POST /api/workspace/members`);
    //     the seat holder has identity + licence + quota, which is what a seat is.
    const seats: ProvisionSeatResult[] = [];
    // Each landed seat's activation, run at the very end (same fail-closed order as the primary).
    const seatActivations: Array<{ index: number; prepared: PreparedIdentity }> = [];
    for (const seat of body.additional_seats ?? []) {
      try {
        const seatPrepared = await prepareInUserRealm({
          email: seat.email,
          name: seat.name,
          tenantSlug: body.tenant_slug,
          appKeys: body.apps,
          sendPasswordResetEmail: body.send_password_reset_email,
          appPlans: body.app_plans,
          ...seatInference,
        }, ledger);
        const seatProv = seatPrepared.prov;
        seatActivations.push({ index: seats.length, prepared: seatPrepared });
        const seatTokens: Record<string, string> = {};
        const seatLicenseIds: Record<string, string> = {};
        for (const grant of seatProv.licenses) {
          seatLicenseIds[grant.app_key] = grant.license_id;
          if (grant.token != null) seatTokens[grant.app_key] = grant.token;
        }
        seats.push({
          email: seat.email,
          status: seatProv.replayed ? 'replayed' : 'provisioned',
          user_id: seatProv.keycloak_user_id,
          already_existed: seatProv.already_existed,
          // Verbatim, never `?? ''` — same rule as the primary user's.
          temporary_password: seatProv.temporary_password,
          magic_link_sent: seatProv.magic_link_sent,
          tokens: seatTokens,
          license_ids: seatLicenseIds,
          warnings: seatProv.warnings,
          partial_failures: seatProv.partial_failures,
        });
        if (seatProv.partial_failures.length > 0) {
          console.warn(
            `[super-admin] seat ${seat.email} provisioned with MATERIAL degradation: ` +
              seatProv.partial_failures.join(', '),
          );
        }
      } catch (seatErr) {
        // Carry the upstream sentence, which for an IntegrationError already
        // contains provisioning's own `detail` (e.g. "plan ... is not an active
        // plan for licenses app ..."). A generic "seat failed" would make a
        // per-seat report worthless.
        const detail = seatErr instanceof Error ? seatErr.message : String(seatErr);
        console.warn(
          `[super-admin] seat ${seat.email} FAILED (the request continues):`,
          detail,
        );
        seats.push({ email: seat.email, status: 'failed', error: detail });
      }
    }
    // A failed seat does not fail the RESPONSE (201, with the failure named per
    // seat), but it must not leave the audit row reading clean either: an operator
    // scanning `status` for anything other than `success` would otherwise never
    // find it, and the response that carried the per-seat detail is gone. `partial`
    // is exactly this row's existing meaning — some side effects landed and some
    // did not — so the seat failures ride it with a summary in `error`.
    let failedSeats = seats.filter((s) => s.status === 'failed');

    // 5c. TENANT INFERENCE — once per tenant, after every seat (PLAN §1.0 r7:
    //     tenant-level steps run once, after the engine commits, outside the
    //     seat loop). provisioning runs licences byo_mode/currency/bundle →
    //     billing money budget/markup/quote → IR policy → a 1-token smoke per
    //     tier proved by an IR ledger read-back.
    //
    //     A failure here is REPORTED, never promoted to a request failure and
    //     never rolled back: the seats exist and are correct; the apply is
    //     resumable/re-runnable from the tenant's Inference section.
    let inference: InferenceOutcome | undefined;
    if (body.inference && ownerToken) {
      const key = newApplyIdempotencyKey(tenantId);
      try {
        const raw = await applyTenantInference({
          tenantId,
          ownerPortalToken: ownerToken,
          body: buildApplyRequest(body.inference, key) as unknown as Record<string, unknown>,
        });
        inference = normaliseApplyResult(raw, key);
      } catch (applyErr) {
        const detail = applyErr instanceof Error ? applyErr.message : String(applyErr);
        console.warn(`[super-admin] tenant inference apply FAILED for ${tenantId}:`, detail);
        inference = {
          status: 'failed',
          policy_version: null,
          idempotency_key: key,
          replayed: false,
          steps: [],
          smoke: [],
          error: detail,
        };
      }
    }
    // 5d. PM CATALOGUE — once per tenant, after every seat. The tenant's
    //     vocabulary (phases, project types, card types, …) lives in RM; a
    //     tenant without it is `catalogue_not_initialised` everywhere in fr.
    let catalogue: CatalogueImportOutcome;
    try {
      catalogue = { status: 'imported', result: await importPmCatalogueDefaults(tenantId, undefined) };
    } catch (catErr) {
      const detail = catErr instanceof Error ? catErr.message : String(catErr);
      console.warn(`[super-admin] PM catalogue import-defaults FAILED for ${tenantId}:`, detail);
      catalogue = { status: 'failed', error: detail };
    } finally {
      invalidateTenantCatalogue(tenantId);
    }
    const catalogueProblem =
      catalogue.status === 'failed' ? `catalogue_import_failed: ${catalogue.error}` : null;

    const inferenceProblem =
      inference && inference.status !== 'success'
        ? `inference_apply_${inference.status}: ` +
          (inference.error ??
            inference.steps
              .filter((s) => s.status === 'failed')
              .map((s) => s.name)
              .join(', '))
        : null;

    // 5e. ⛔ ACTIVATION — the LAST action (George 2026-10-23, fail closed). Every step above
    //     landed, so only now are the fr-realm accounts enabled and the one set-password email
    //     sent (never a second: the ledger records it). A failure anywhere above left the
    //     accounts DISABLED with nothing mailed. The primary's activation failing throws (the
    //     row goes partial, the operator retries); a seat's is reported on that seat.
    const primaryActivation = await prepared.activate();
    warnings.push(...primaryActivation.warnings);
    for (const { index, prepared: seatPrepared } of seatActivations) {
      const seatRow = seats[index]!;
      try {
        const act = await seatPrepared.activate();
        seatRow.magic_link_sent = act.magicLinkSent;
        seatRow.warnings = [...(seatRow.warnings ?? []), ...act.warnings];
      } catch (actErr) {
        const detail = actErr instanceof Error ? actErr.message : String(actErr);
        console.warn(`[super-admin] seat ${seatRow.email} activation FAILED (left disabled):`, detail);
        seats[index] = { email: seatRow.email, status: 'failed', error: `activation_failed: ${detail}` };
      }
    }
    failedSeats = seats.filter((s) => s.status === 'failed');

    // 6. Build the result and close the audit row — `success`, or `partial` when
    //    the primary user landed but a seat did not (see `failedSeats` above).
    const result: ProvisionUserResult = {
      catalogue,
      user_id: kcUserId,
      tenant_id: tenantId,
      already_existed: prov.already_existed,
      // Passed through verbatim. NEVER `?? ''` — provisioning returns null when
      // it did not mint a password (existing account, or a replay), and an empty
      // string rendered in a credential box is a lie.
      temporary_password: prov.temporary_password,
      magic_link_sent: primaryActivation.magicLinkSent,
      replayed: prov.replayed,
      tokens,
      license_ids: licenseIds,
      budget_id: budget?.id ?? null,
      provisioning_status: prov.status,
      warnings,
      partial_failures: prov.partial_failures,
      seats,
      app_plans: body.app_plans ?? null,
      ...(keycloakSync !== undefined ? { keycloak_sync: keycloakSync } : {}),
      ...(inference !== undefined ? { inference } : {}),
    };

    const closeResult: Record<string, unknown> = {
          user_id: kcUserId,
          tenant_id: tenantId,
          license_ids: licenseIds,
          budget_id: budget?.id ?? null,
          already_existed: prov.already_existed,
          replayed: prov.replayed,
          provisioning_idempotency_key: prov.idempotency_key,
          provisioning_status: prov.status,
          warnings,
          partial_failures: prov.partial_failures,
          // The plan choice, so the audit row answers "which plan was this tenant
          // actually sold?" without re-reading the licence rows. `null` = the
          // engine's first-non-revoked default, which is a different fact from
          // "nobody recorded it".
          app_plans: body.app_plans ?? null,
          // Per-seat outcomes, INCLUDING the failed ones — the response is
          // ephemeral and an operator reading this row later must be able to see
          // that seat 4 never landed. Mirrors how the row already records
          // `license_ids` and NOT the one-time tokens/password: secrets stay out
          // of the audit trail, so each seat carries ids and status only.
          seats: seats.map((s) => ({
            email: s.email,
            status: s.status,
            user_id: s.user_id ?? null,
            already_existed: s.already_existed ?? null,
            license_ids: s.license_ids ?? {},
            warnings: s.warnings ?? [],
            partial_failures: s.partial_failures ?? [],
            error: s.error ?? null,
          })),
          // Ids + verdicts only: no key, no token, no step detail.
          ...(inference !== undefined ? { inference: inferenceOutcomeForAudit(inference) } : {}),
          catalogue: catalogue.status === 'imported' ? { status: 'imported' } : catalogue,
        };
    await db
      .update(provisioningAudit)
      .set({
        target_user_id: kcUserId,
        tenant_id: tenantId,
        // MERGED into the row, never replacing it: `result.identities` is the identity ledger
        // (auditIdentityLedger) and must survive the close.
        result: sql`coalesce(${provisioningAudit.result}, '{}'::jsonb) || ${JSON.stringify(closeResult)}::jsonb`,
        status: failedSeats.length > 0 || inferenceProblem || catalogueProblem ? 'partial' : 'success',
        error:
          [
            failedSeats.length > 0
              ? `additional_seats_failed: ` +
                failedSeats.map((s) => `${s.email}: ${s.error}`).join(' | ')
              : null,
            inferenceProblem,
            catalogueProblem,
          ]
            .filter((x): x is string => x !== null)
            .join(' || ') || null,
        updated_at: new Date(),
      })
      .where(eq(provisioningAudit.id, auditId));

    return jsonResponse(result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db
        .update(provisioningAudit)
        .set({
          status: 'partial',
          error: message,
          updated_at: new Date(),
        })
        .where(eq(provisioningAudit.id, auditId));
    } catch (logErr) {
      console.error(
        '[super-admin] failed to update provisioning_audit row',
        auditId,
        logErr,
      );
    }

    // A provisioning 409 is answered as an explicit 409 naming the reason. Since
    // licences migration 050 tenant names are unique PER OWNING APP and
    // `POST /tenants` no longer returns an existing tenant by name, so a clash
    // on `tenant_slug` is a real refusal to show the operator — not something
    // to retry or paper over.
    if (provisioningConflict(err)) {
      return provisioningConflictResponse(err, body.tenant_slug);
    }
    if (isIntegrationError(err)) {
      return integrationErrorResponse(err);
    }
    if (err instanceof AppError) {
      return jsonResponse(
        { error: err.message, details: err.details },
        err.statusCode,
      );
    }
    if (err instanceof BadRequestError) {
      return jsonResponse({ error: err.message }, 400);
    }
    console.error('[super-admin] provisioning failed:', err);
    return jsonResponse(
      { error: 'provisioning failed', detail: message },
      500,
    );
  }
}

/** A 409 from the provisioning engine (its own, or licences' passed through). */
function provisioningConflict(err: unknown): err is IntegrationError {
  return isIntegrationError(err) && err.service === 'provisioning' && err.upstreamStatus === 409;
}

/**
 * The 409 body for a refused onboarding. `code` is licences' refusal code when
 * provisioning passed one through (e.g. `tenant_name_taken`), else
 * `provisioning_conflict`; the upstream body rides along for the operator.
 */
function provisioningConflictResponse(err: IntegrationError, tenantSlug: string): Response {
  const refusal = licencesRefusalCode(err.upstreamBody);
  const explained = refusal ? LICENCES_OWNERSHIP_REFUSALS[refusal] : undefined;
  return jsonResponse(
    {
      error: {
        code: explained ? refusal : 'provisioning_conflict',
        message: explained
          ? `provisioning refused tenant_slug '${tenantSlug}': ${explained}`
          : `provisioning refused the onboarding of tenant_slug '${tenantSlug}' (409)`,
        service: 'provisioning',
        upstream: { status: 409, body: err.upstreamBody },
      },
    },
    409,
  );
}

// ---------------------------------------------------------------------------
// POST /api/admin/super-admin/deprovision-user
// ---------------------------------------------------------------------------

// DeprovisionUserBody / DeprovisionUserInput: ./super-admin-schemas.ts.


export interface DeprovisionUserResult {
  /** The Keycloak account was deleted (false = it was already gone). */
  keycloak_user_deleted: boolean;
  /** How many of that run's licenses were deleted. */
  licenses_deleted: number;
  tenant_id: string | null;
  /**
   * ALWAYS true. The licenses registry exposes no tenant-DELETE — a tenant is a
   * shared registry entity that other subjects may still hold licenses in — so
   * offboarding a person never destroys the tenant. Surfaced, not hidden.
   */
  tenant_retained: boolean;
  /** True only when a billing quota config could NOT be removed (billing down). */
  billing_quota_retained: boolean;
  /** True on an idempotent replay: this run was already reversed, nothing happened now. */
  already_deprovisioned: boolean;
  /**
   * fr-local state this call deliberately did NOT touch, so the UI can say so
   * instead of implying a full erase.
   */
  fr_local_retained: string[];
}

/**
 * Offboard: reverse the provisioning run for (email, tenant_slug).
 *
 * Addressed by the SAME deterministic idempotency key the provision used — that
 * is provisioning's only handle on a prior run. A 404 therefore means "there is
 * no run to reverse" (e.g. the account predates the FULL-UNIFY repoint, or the
 * slug is wrong), and it is reported as exactly that: nothing was deleted.
 *
 * What it destroys: the Keycloak ACCOUNT and the licenses that run minted, and
 * it deregisters their billing quota. What it keeps: the shared registry tenant,
 * and every fr-local artefact (the `workspaces` row, `user_roles` grants, the
 * metering token budget, and this audit trail) — the workspace may be shared
 * with other people, so nuking it from a single person's offboard would be
 * destructive beyond the ask. The UI copy must match this list.
 */
// ---------------------------------------------------------------------------
// The last-member guard: a person's deprovision never strands a tenant's tenant-level licences.
// ---------------------------------------------------------------------------

/**
 * The tenant an early-access SIGNUP founded on this slug (its row not removed), or null. Only such
 * a tenant is guarded: it has a removal action that takes the whole workspace down. A tenant
 * provision-user made has none, so its last member keeps today's deprovision.
 */
async function resolveSignupTenant(tenantSlug: string): Promise<{ tenantId: string; signupId: string; status: string } | null> {
  const rows = (await db.execute(
    sql`SELECT id::text AS signup_id, tenant_id::text AS tenant_id, status FROM signup_approvals
         WHERE tenant_slug = ${tenantSlug} AND tenant_id IS NOT NULL AND status <> 'removed'
         ORDER BY created_at DESC LIMIT 1`,
  )) as unknown as Array<{ signup_id: string; tenant_id: string; status: string }>;
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, signupId: r.signup_id, status: r.status } : null;
}

/**
 * The 409 body when deprovisioning `email` would remove the LAST member of a tenant an early-access
 * signup founded, else null. "Member" = an fr role grant (`user_roles`) on the tenant, as the signup
 * removal's blockers count them. Any other tenant (provision-user's, an unknown slug) is unchanged.
 */
async function lastMemberRefusal(email: string, tenantSlug: string): Promise<Record<string, unknown> | null> {
  const founded = await resolveSignupTenant(tenantSlug);
  if (!founded || !isValidUuid(founded.tenantId)) return null;
  const userId = (await keycloakIdentityOps.findUserByEmail(email))?.id ?? null;
  const others = (await db.execute(
    sql`SELECT count(*)::int AS n FROM user_roles
         WHERE tenant_id = ${founded.tenantId}::uuid AND (${userId}::text IS NULL OR user_id <> ${userId}::text)`,
  )) as unknown as Array<{ n: number }>;
  if ((others[0]?.n ?? 0) > 0) return null;
  return {
    error: 'last_tenant_member',
    detail:
      `${email} is the last member of early-access workspace '${tenantSlug}' (tenant ${founded.tenantId}). Deprovisioning ` +
      "only them would leave the tenant's tenant-level licences (the conveyor bundle), the licences tenant and the " +
      'workspace live. Remove the whole workspace instead: Admin → Early access → Remove workspace, i.e. ' +
      `POST /api/signup-approvals/${founded.signupId}/remove with {"confirm": "${tenantSlug}"} (signup is ${founded.status}).`,
    tenant_id: founded.tenantId,
    signup_id: founded.signupId,
  };
}

export async function handleDeprovisionUser(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { status?: number; statusCode?: number }).statusCode
      ?? (e as { status?: number }).status
      ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  if (!isSuperAdmin(user)) {
    return jsonResponse({ error: 'super-admin only' }, 403);
  }

  let body: DeprovisionUserInput;
  try {
    const raw = await req.json();
    body = DeprovisionUserBody.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse(
        { error: 'invalid request body', details: e.errors },
        422,
      );
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    throw e;
  }

  // ⛔ Refuse to remove a tenant's LAST member: the tenant-level licences (the conveyor bundle) would
  // be stranded live. Checked before anything upstream is called; a failed check refuses (fail closed).
  try {
    const refusal = await lastMemberRefusal(body.email, body.tenant_slug);
    if (refusal) return jsonResponse(refusal, 409);
  } catch (err) {
    return jsonResponse(
      {
        error: 'last_member_check_failed',
        detail: `Could not check whether ${body.email} is the workspace's last member, so nothing was deprovisioned: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }

  // Same audit discipline as provision: a `pending` row first, so a crash
  // mid-reversal still leaves a trail. Migration 056 constrains `action` to
  // provision_user | revoke_user | reissue_token, so the offboard rides
  // `revoke_user` with the finer intent in the payload.
  const [auditRow] = await db
    .insert(provisioningAudit)
    .values({
      actor_user_id: user.id,
      action: 'revoke_user',
      target_email: body.email,
      payload: {
        ...body,
        operation: 'deprovision_user',
      } as unknown as Record<string, unknown>,
      result: {},
      status: 'pending',
    })
    .returning({ id: provisioningAudit.id });
  if (!auditRow) {
    throw new AppError(500, 'failed to open provisioning_audit row');
  }
  const auditId = auditRow.id;

  try {
    const dep = await deprovisionUserUpstream({
      email: body.email,
      tenantSlug: body.tenant_slug,
      reason: body.reason ?? null,
    });

    // Realm per app: a run whose identity was caller-owned (minted by fr in its
    // user realm) is NOT deleted by the engine — it lives in fr's realm, so fr
    // deletes it here. Idempotent (404 = already gone), so a replay after a crash
    // between the two calls still converges.
    let keycloakUserDeleted = dep.keycloak_user_deleted;
    if (dep.keycloak_user_caller_owned && dep.keycloak_user_id) {
      keycloakUserDeleted = (await deleteUserRealmUser(dep.keycloak_user_id)) || keycloakUserDeleted;
    }

    const result: DeprovisionUserResult = {
      keycloak_user_deleted: keycloakUserDeleted,
      licenses_deleted: dep.licenses_deleted,
      tenant_id: dep.tenant_id,
      tenant_retained: dep.tenant_retained,
      billing_quota_retained: dep.billing_quota_retained,
      already_deprovisioned: dep.already_deprovisioned,
      fr_local_retained: [
        'workspace row',
        'fr role grants (user_roles)',
        'metering token budget',
        'provisioning audit trail',
      ],
    };

    await db
      .update(provisioningAudit)
      .set({
        tenant_id: dep.tenant_id && isValidUuid(dep.tenant_id) ? dep.tenant_id : null,
        result: result as unknown as Record<string, unknown>,
        status: 'success',
        updated_at: new Date(),
      })
      .where(eq(provisioningAudit.id, auditId));

    return jsonResponse(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db
        .update(provisioningAudit)
        .set({
          // A 404 (no such run) changed NOTHING, so it is an `error`, not a
          // `partial` — `partial` would imply side effects landed.
          status:
            isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND'
              ? 'error'
              : 'partial',
          error: message,
          updated_at: new Date(),
        })
        .where(eq(provisioningAudit.id, auditId));
    } catch (logErr) {
      console.error(
        '[super-admin] failed to update provisioning_audit row',
        auditId,
        logErr,
      );
    }

    if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') {
      return jsonResponse(
        {
          error: 'no provisioning run to reverse',
          detail:
            `provisioning has no run for ${body.email} in tenant_slug ` +
            `'${body.tenant_slug}'. Nothing was deleted. This account was not ` +
            `onboarded through the provisioning engine (e.g. it predates the ` +
            `FULL-UNIFY repoint), or the tenant slug does not match the one it ` +
            `was provisioned with. Revoke its licenses from the licensing ` +
            `console and remove the Keycloak account manually.`,
        },
        404,
      );
    }
    if (isIntegrationError(err)) {
      return integrationErrorResponse(err);
    }
    if (err instanceof AppError) {
      return jsonResponse(
        { error: err.message, details: err.details },
        err.statusCode,
      );
    }
    if (err instanceof BadRequestError) {
      return jsonResponse({ error: err.message }, 400);
    }
    console.error('[super-admin] deprovisioning failed:', err);
    return jsonResponse(
      { error: 'deprovisioning failed', detail: message },
      500,
    );
  }
}
