// src/lib/project-owner-guard.ts
//
// ONE shared guard deciding whether a resolved project's id may ride an
// outbound billing-relevant call (the `X-Project-Id` header on every HTTP
// call through `integrations/_lib/http-client.ts`, and the `project_id` field
// on every metering span from `services/metering-emit.ts`).
//
// Prior rounds refused to persist a caller-supplied project id at all because
// ownership could not be validated. `projects.project_data->>'keycloak_tenant_id'`
// is fr's authoritative project→tenant tag (already used by
// `lib/project-access.ts` PROJECT_KC_TENANT, `lib/board-tenant-access.ts`
// resolveBoardTenant, and `lib/execution-signoff.ts` — the AA/approvals lane
// this file must NOT otherwise touch) — that tag is what makes validation
// possible AT THE EMITTER: compare it against the caller's active tenant
// (`ctxTenantId`) before the id goes anywhere.
//
// ⛔ Refuse, don't coerce. A mismatched or untagged project NEVER substitutes
// a different value (e.g. the caller's tenant id, or a blank string read as
// "no restriction") — it OMITS. Coercion here would let one tenant's outbound
// call carry an id that silently resolves to ANOTHER tenant's project on the
// billing side, which is a worse failure than sending nothing.
//
// ⛔ UNCONDITIONAL — NO MODE FLAG. An earlier revision gated this behind a
// `PROJECT_ID_EMIT_MODE=observe|enforce` env flag defaulting to `observe`,
// reasoning that ~93% `keycloak_tenant_id` tag coverage (measured 2026-09-16
// on worker4 `fr` db: total=258, tagged=240) was under some ~95% bar needed
// before gating. That reasoning was backwards: coverage of the TAG governs
// how often `owned` fires, not whether an unvalidated id is safe to send —
// an `untagged` or `foreign` row is exactly as unsafe to emit at 7% untagged
// as it would be at 30%. `observe` mode shipped `resolveEmission` returning
// the raw id unconditionally for `owned` / `foreign` / `untagged` alike,
// i.e. it sent a cross-tenant project id under a UNANIMOUSLY WRONG tenant's
// JWT whenever a project resolved at all — the exact
// `BillingProjectIdSeenUnderMultipleTenants` failure class this file exists
// to prevent, by default, in production. The mode flag is gone: once the
// only allowed emission is `owned`, `enforce` and `observe` compute the
// identical result, so a flag whose two values behave identically was
// deleted rather than kept as dead ceremony. If gating the REQUEST itself
// (not just the header/span) is ever wanted, that is a different, real
// feature — add a new flag for it then, don't resurrect this one.

import {
  recordProjectIdEmitOutcome,
  type ProjectIdEmitLane,
  type ProjectIdEmitOutcome,
} from './project-id-emit-metrics';
import { tryGetRequestContext } from '../middleware/request-context';

export type { ProjectIdEmitLane, ProjectIdEmitOutcome };

/** The minimal project shape the guard needs — a real `projects` row satisfies this. */
export interface OwnershipCandidateProject {
  id: string;
  project_data: unknown;
}

/**
 * JS-side twin of `project-access.ts`'s SQL predicate
 * `PROJECT_KC_TENANT = sql\`${projects.project_data}->>'keycloak_tenant_id'\``,
 * for callers holding an already-fetched row rather than building a query.
 * Deliberately NOT imported from `project-access.ts` — that module calls the
 * guard after resolving a project, so importing back from here would make the
 * two files circular. Same field name, same semantics, kept alongside
 * `recordProjectIdEmitOutcome` in one dependency-light file instead.
 *
 * Trimmed-non-empty, matching the fleet's `.trim() ? … : undefined` idiom
 * elsewhere (http-client.ts's `effectiveTenantId`) — a blank tag is the same
 * as no tag.
 */
export function projectKcTenantTag(
  project: Pick<OwnershipCandidateProject, 'project_data'> | null | undefined,
): string | undefined {
  const tag = (project?.project_data as { keycloak_tenant_id?: string } | null)
    ?.keycloak_tenant_id;
  return tag && tag.trim() ? tag.trim() : undefined;
}

/**
 * Classify how a resolved project relates to the caller's active tenant.
 * Pure — no counting, no mode awareness. Split out from `guardProjectId` so
 * the classification and the count-vs-gate decision can be tested
 * independently.
 *
 *   - `untagged` — project row exists but carries no `keycloak_tenant_id` tag
 *                  (a legacy row predating the tag; ~7% of projects today).
 *   - `foreign`  — tagged, but the tag names a DIFFERENT tenant than the
 *                  caller's active one.
 *   - `owned`    — tagged, and the tag matches the caller's active tenant.
 *
 * Both parameters are REQUIRED, not `| null | undefined`. There used to be a
 * fourth outcome, `absent`, for a missing project or caller tenant — but this
 * function's only caller (`guardProjectId`, itself called only from
 * `lib/project-access.ts resolveProject` inside `if (project) { … }` with an
 * `activeTenantId` that `ctxTenantId` guarantees is a real string or throws)
 * can never actually supply either as missing. Typing them as required turns
 * that guarantee into a compile-time one instead of a runtime branch that can
 * never be taken.
 */
export function classifyProjectOwnership(
  project: OwnershipCandidateProject,
  callerTenantId: string,
): ProjectIdEmitOutcome {
  const tag = projectKcTenantTag(project);
  if (!tag) return 'untagged';
  if (tag !== callerTenantId) return 'foreign';
  return 'owned';
}

/**
 * Emission decision for an already-classified outcome. Isolated from
 * `guardProjectId` so a mutation-control test can pin this precisely: mutate
 * it to also emit on `foreign` (or `untagged`) and the "never emits a
 * mismatched/unknown id" tests go red.
 *
 * ONLY `owned` ever emits. `foreign` and `untagged` OMIT rather than send a
 * project id the tag disagrees with (or can't confirm at all — an untagged
 * row is foreign-but-unknown, and "refuse, don't coerce" applies exactly the
 * same to unknown as to known-mismatched). Unconditional — there is no mode
 * that changes this outcome.
 */
function resolveEmission(projectId: string, outcome: ProjectIdEmitOutcome): string | undefined {
  return outcome === 'owned' ? projectId : undefined;
}

/**
 * Which read lane produced this decision (fr#1214). Pure, exported and tested
 * on its own so the mapping cannot be mutated silently: hard-coding either
 * branch reddens `project-owner-guard.test.ts`'s lane arms.
 *
 * The input is `project-access.ts resolveProject`'s `crossTenantReadOnly` —
 * `opts.crossTenantRead && isSuperAdminHomeView(user)`, i.e. BOTH the caller's
 * declaration that its lane cannot mutate AND the super-admin-home-view
 * identity gate. It is a boolean, so there are exactly two lanes and no room
 * for a third.
 */
export function projectIdEmitLane(crossTenantReadOnly: boolean): ProjectIdEmitLane {
  return crossTenantReadOnly ? 'cross_tenant_read' : 'own_tenant';
}

export interface GuardProjectIdResult {
  /** The value to place on X-Project-Id / the metering span's project_id, or
   * undefined to omit. */
  projectId: string | undefined;
  outcome: ProjectIdEmitOutcome;
  /** The lane the outcome was counted under. Returned (not just counted) so
   * the seam test can assert the label without reading the metrics Map. */
  lane: ProjectIdEmitLane;
  /**
   * fr row 14b — the ACCESS verdict. `true` only for `owned`: a `foreign` row
   * (tagged for another tenant) and an `untagged` row (tenant unknown) are
   * DENIED, never merely labelled. Ownership alone never grants cross-tenant
   * access. The caller (`resolveProject`) answers a denial exactly like a
   * filter miss.
   */
  allowed: boolean;
}

/**
 * The structured line the `FrProjectOwnerGuardForeign` runbook tells a
 * responder to look for. Before fr#1214 that instruction pointed at nothing:
 * `guardProjectId` emitted NO log line at all (measured 2026-09-25 — 2619
 * fr-backend log lines over 3h, zero matches for
 * `foreign|project-owner|guardProject|project_id_emit`), so the annotation
 * named a grep that could never hit.
 *
 * ⛔ `own_tenant` LANE ONLY, and that is the volume argument, not caution.
 * A refusal on the `cross_tenant_read` lane is the DESIGNED behaviour of every
 * super-admin cockpit page load — the 07:57Z burst alone was 5 in 35s, and a
 * super-admin browsing N projects would produce N — so logging that lane would
 * be a per-page-load line carrying no decision. The `own_tenant` lane is the
 * population the alert is for: a genuinely mis-tagged row (~7% of projects are
 * untagged, and an ordinary user only ever reaches their OWN tenant's rows) or
 * a wrong-tenant caller. That is rare by construction, and each line is
 * actionable because it names the row and both tenant ids.
 *
 * ⛔ NEVER THROWS and never changes a verdict — the emission decision is
 * already made above this call. Same contract, and the same deliberately silent
 * catch, as `reportBoardTenantGateRefusal`.
 *
 * ⛔ NO CREDENTIAL MATERIAL. `RequestContext` carries `bearerToken` one property
 * access away, so the context is read by EXPLICITLY NAMED fields only — there is
 * no `...ctx` spread here and must never be.
 */
function logProjectIdEmitRefusal(
  project: OwnershipCandidateProject,
  callerTenantId: string,
  outcome: ProjectIdEmitOutcome,
  lane: ProjectIdEmitLane,
): void {
  if (outcome === 'owned' || lane !== 'own_tenant') return;
  try {
    const ctx = tryGetRequestContext();
    console.error(
      JSON.stringify({
        telemetry: 'project_id_emit_refused',
        outcome,
        lane,
        project_id: project.id,
        project_tenant: projectKcTenantTag(project) ?? null,
        active_tenant: callerTenantId,
        // Explicitly named, never spread — see the ⛔ above.
        correlation_id: ctx?.correlationId ?? null,
        initiator: ctx?.initiator ?? null,
        channel: ctx?.channel ?? null,
      }),
    );
  } catch {
    // Deliberately silent: an instrument must not become the outage.
  }
}

/**
 * Validate a resolved project against the caller's active tenant and decide
 * what (if anything) may ride an outbound billing-relevant call. Always
 * counts the outcome (`fr_project_id_emit_total`) — the counter is how
 * tag-coverage gets re-measured live rather than by re-running the SQL query
 * by hand — independently of the (unconditional) emission decision above.
 *
 * All three parameters REQUIRED — see `classifyProjectOwnership`'s docblock for
 * why the one caller (`lib/project-access.ts resolveProject`) can never
 * supply the first two as missing, and `projectIdEmitLane` for why the third
 * has no default.
 *
 * ⚠️ `crossTenantReadOnly` LABELS, IT DOES NOT DECIDE. It feeds the `lane`
 * label and the log gate, and nothing else: `classifyProjectOwnership` and
 * `resolveEmission` never see it, so the deliberate cross-tenant read lane
 * still counts `foreign` and still refuses to emit a mismatched id. Making it
 * change either would be the suppression fr#1214 explicitly must not ship.
 */
export function guardProjectId(
  project: OwnershipCandidateProject,
  callerTenantId: string,
  crossTenantReadOnly: boolean,
): GuardProjectIdResult {
  const outcome = classifyProjectOwnership(project, callerTenantId);
  const lane = projectIdEmitLane(crossTenantReadOnly);
  recordProjectIdEmitOutcome(outcome, lane);
  logProjectIdEmitRefusal(project, callerTenantId, outcome, lane);
  const projectId = resolveEmission(project.id, outcome);
  return { projectId, outcome, lane, allowed: isProjectAccessAllowed(outcome) };
}

/**
 * fr row 14b — the access decision for an already-classified outcome. Same
 * shape as `resolveEmission`: ONLY `owned` passes; `foreign` and `untagged`
 * are denied (fail closed — an untagged row is foreign-but-unknown).
 */
export function isProjectAccessAllowed(outcome: ProjectIdEmitOutcome): boolean {
  return outcome === 'owned';
}
