// src/middleware/internal-tenant-only.ts
//
// The reserved canonical tenants and the tenant sets built from them.
//
//   system    → cross-tenant system assets (Plan 4 seed target)
//   execution → George's canonical working / demo tenant
//   kata      → the ONE internal workspace whose projects run as a kata
//
// The three v3 improvement tenants (workflow-improvement, prompt-improvement,
// procedure-improvement) were deleted 2026-11-03 with the v3 improvement loop
// (kata-super-admin §7, migration 230); the kata replaced them.
//
// ⛔ THE IDS THEMSELVES ARE NO LONGER IN THIS FILE, OR IN THIS REPOSITORY. They
// are environment-supplied (`FR_*_TENANT_ID`) and read through
// `src/lib/tenant-config.ts`. This module keeps the AUTHORISATION rules built on
// top of them — the sets, the predicates and the 404 gates.
//
// Internal-only routes respond 404 to any other tenant — 404 (not 403) so the
// existence of the surface stays private from regular tenants.

import { getCorrelationId, getTenantId } from '../integrations/_lib/context';
import { canonicalTenantNames, internalTenantIds, platformTenantIds } from '../lib/tenant-config';
import { IntegrationError } from '../integrations/_lib/errors';

export {
  aaConveyorTenantId,
  canonicalTenantNames,
  executionTenantId,
  internalSystemTenantId,
  internalTenantIds,
  kataTenantId,
  platformTenantIds,
  v4ConveyorTenantId,
} from '../lib/tenant-config';

// ── The three tenant sets, side by side ─────────────────────────────────────
//
// They DIFFER on purpose; never collapse one into another:
//   * internalTenantIds()   — the reserved system tenant + kata.
//   * isRepoPlatformTenant — services/repo-access.ts: system + EXECUTION.
//     Kata is excluded: coding-github's platform set does not hold it, and a
//     kata project carries no repository.
//     Who may put an internal-owner (`nonagenticai`) repo into fr. The AA
//     conveyor tenant is deliberately ABSENT: coding-github refuses it for
//     platform repos, so admitting it here would let fr store a repo that
//     every downstream clone then refuses.
//   * platformTenantIds()  — system + kata + EXECUTION + the AA conveyor tenant
//     + the v4 conveyor tenant.
//     Who may see system-owned rows at all, and the tenants the conveyor
//     priority identity may name via X-Tenant-Id (routes/cards/priority.ts).
// Pinned by tests/unit/middleware/tenant-sets.test.ts.

// ⛔ THE PLATFORM SET IS DERIVED (platformTenantIds() in tenant-config), not
// restated here: internal (system + kata) + execution + both conveyor tenants.
// Tenants that may see system-owned rows at all. Owner ruling 2026-09-30:
// system data is NEVER visible to any other tenant. The upstreams enforce the
// same set; this is fr's second layer so a customer never sees a system row
// even if an upstream regresses.

export function isPlatformTenant(tenantId: string | null | undefined): boolean {
  return typeof tenantId === 'string' && platformTenantIds().has(tenantId);
}

/**
 * id → name for the canonical tenants. `routes/tenants.ts` builds its
 * `CANONICAL_TENANTS` display list (which also carries `is_system`) from this
 * map so there is one place a name is spelled.
 *
 * ⭐ ALSO A DIAGNOSTIC. These uuids are WORKSPACE ids, and a producer that puts
 * one in a `project_id` field gets a truthful "not found" that reads as a
 * missing row. Measured 2026-09-10: `/api/webhooks/n8n/execution-event` and
 * `GET /api/projects/:id` were both refusing
 * the `prompt-improvement` workspace id, which is a TENANT id — a
 * tenant, and therefore an id that can never match a `projects` row under any
 * tenant. `canonicalTenantName` lets a refusal SAY that instead of leaving the
 * reader to guess between "deleted", "other tenant" and "wrong entity kind".
 */
// ⛔ Derived (canonicalTenantNames() in tenant-config) — only CONFIGURED roles
// appear. An unset role has no name to report.

/**
 * The canonical tenant's name if `id` is one, else null.
 *
 * ⛔ Deliberately NOT a `workspaces` lookup. This module is imported by
 * request-path middleware that is unit-tested without a database, and a
 * five-entry constant answers the question that actually matters — "is this a
 * reserved tenant id someone has mistaken for a row id" — without a query on an
 * error path. A caller that needs the full workspace set must query it itself.
 */
export function canonicalTenantName(id: string | null | undefined): string | null {
  if (!id) return null;
  return canonicalTenantNames()[id] ?? null;
}

export function isInternalTenant(tenantId: string | null | undefined): boolean {
  return typeof tenantId === 'string' && internalTenantIds().includes(tenantId);
}

/**
 * Refuse with the standard opaque 404 — and RECORD which tenant was refused.
 *
 * ⚠️ TELEMETRY ONLY, never the response. The 404 these gates return is
 * deliberately indistinguishable from "no such route" so a regular tenant
 * cannot probe which internal surfaces exist. Naming the tenant in the
 * client-facing body would hand back exactly the fact the 404 exists to hide.
 * The operator needs it; the caller must not have it.
 *
 * WHY THIS EXISTS. Without it a refusal recorded NOTHING — not the tenant that
 * was rejected, not the set that would have been admitted — so the logs of a
 * refused call and of a route that does not exist were byte-identical.
 *
 */
function refuseTenant(
  gate: string,
  service: string,
  tenant: string | undefined,
  admitted: readonly string[],
): never {
  try {
    console.error(
      JSON.stringify({
        telemetry: 'internal_tenant_refused',
        gate,
        service,
        tenant_id: tenant ?? null,
        admitted,
        correlation_id: getCorrelationId() ?? null,
      }),
    );
  } catch {
    // Recording a refusal must never itself become a failure.
  }
  throw new IntegrationError({
    code: 'UPSTREAM_NOT_FOUND',
    message: 'Not found',
    service,
    // The `internal_tenant_refused` line above already recorded this, with more
    // detail than the generic converter can produce (which gate, which tenant,
    // which set was admitted). Without this flag the converter emits a SECOND
    // line claiming an upstream named `fr-streams` returned NOT_FOUND — no
    // upstream was contacted, which is why `path`/`upstream_status` were null.
    // Measured 2026-09-04: 13 of 38 integration_error rows on the current
    // binary were these refusals, i.e. a third of the production defect ranking
    // was a gate doing its job. The 404 is unchanged.
    alreadyReported: true,
  });
}

/**
 * Resolve the request's internal tenant — system INCLUDED — or throw 404.
 *
 * Admits exactly the membership of `isInternalTenant` (system), and therefore
 * 404s the execution tenant and every customer tenant. `POST /api/notifications/dispatch` is
 * the motivating caller: it only pushes a message at an already-registered
 * channel, and its active n8n callers all pin the system tenant (two of
 * them via a `system-workflow-operator` token whose Keycloak `tenant_id`
 * claim IS the system tenant — see that route's header for the measured
 * per-workflow detail).
 *
 * `service` is surfaced in the 404 response body by
 * `integrationErrorResponse`, so callers pass their own name.
 */
export function requireAnyInternalTenant(service: string): string {
  const tenant = getTenantId();
  if (!isInternalTenant(tenant)) {
    refuseTenant('requireAnyInternalTenant', service, tenant, internalTenantIds());
  }
  // `isInternalTenant` narrows to `string | null | undefined`; a refusal above
  // has already thrown for anything that is not a configured internal tenant.
  return tenant as string;
}

/**
 * Refuse a surface that no tenant may reach any more (its only tenants were the
 * deleted improvement tenants) with the same opaque, recorded 404.
 */
export function refuseRetiredInternalSurface(gate: string, service: string): never {
  refuseTenant(gate, service, getTenantId(), []);
}

// ----- Plan 7 Stage 0a — asset card_type allowlist -------------------------
//
// card_types whose stream substrate is per-tenant (kind ∈
// principle/requirement/decision) and therefore acceptable from ANY
// authenticated tenant. Every other card_type is refused (its improvement
// tenants were deleted 2026-11-03).
//
// `change_principle_development` and `change_decision_development` are fr card
// types the RM default PM catalogue (requirements_management) does not define:
// their card group is '' (routes/cards/improvement.ts). Keep
// this set in lock-step with `assetStreamKindForCardType` below — drift
// between the two is surfaced as `unknown_asset_card_type` from
// routes/cards/improvement.ts (intentionally loud, not silent).

const ASSET_AUTHORING_CARD_TYPES = new Set<string>([
  'principle_development',
  'requirement_development',
  'decision_development',
  'change_principle_development',
  'change_requirement_development',
  'change_decision_development',
]);

export function isAssetAuthoringCardType(cardType: string | undefined): boolean {
  return cardType !== undefined && ASSET_AUTHORING_CARD_TYPES.has(cardType);
}

// ----- Scoring half — governor-emitted asset STATISTICS analysis cards ------
//
// The observability sweep (governor) emits `{principle,requirement,decision}_
// statistics_analysis` improvement cards for the per-kind asset library, the
// asset-side analogue of `procedure_performance_statistics_analysis`. They are
// NOT authoring cards (no human authors them) but they target the SAME per-kind
// asset stream substrate, which the `streams_kind_tenant_check` admits on any
// tenant — so they take the same lazy asset-stream branch in the create route
// (NO new tenant, NO migration). Kept in lock-step with `assetStreamKindForCardType`.

const ASSET_ANALYSIS_CARD_TYPES = new Set<string>([
  'principle_statistics_analysis',
  'requirement_statistics_analysis',
  'decision_statistics_analysis',
]);

export function isAssetAnalysisCardType(cardType: string | undefined): boolean {
  return cardType !== undefined && ASSET_ANALYSIS_CARD_TYPES.has(cardType);
}

/**
 * Any asset-stream card_type (authoring OR governor-emitted analysis). The
 * create route uses this to pick the per-tenant lazy asset-stream branch.
 */
export function isAssetCardType(cardType: string | undefined): boolean {
  return isAssetAuthoringCardType(cardType) || isAssetAnalysisCardType(cardType);
}

/**
 * Map a card_type to the asset stream kind it should write to. Returns
 * null for non-asset card_types. Covers authoring (*_development) AND the
 * governor-emitted analysis (*_statistics_analysis) card_types.
 */
export function assetStreamKindForCardType(
  cardType: string,
): 'principle' | 'requirement' | 'decision' | null {
  switch (cardType) {
    case 'principle_development':
    case 'change_principle_development':
    case 'principle_statistics_analysis':
      return 'principle';
    case 'requirement_development':
    case 'change_requirement_development':
    case 'requirement_statistics_analysis':
      return 'requirement';
    case 'decision_development':
    case 'change_decision_development':
    case 'decision_statistics_analysis':
      return 'decision';
    default:
      return null;
  }
}
