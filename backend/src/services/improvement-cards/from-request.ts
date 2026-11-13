// AA Card Substrate Phase 6 — map a validated CardGenerationRequest into
// the per-group customField value bag every Phase-3-provisioned board
// supports.
//
// Why context is a separate parameter: the requestor body carries
// stream_id/stream_slug/asset_id/asset_kind as OPTIONAL fields, but the
// route handler always knows them authoritatively (it just resolved the
// stream by slug + got the target list). Passing the resolved values via
// `context` lets the route override anything the body got wrong (e.g.
// caller submitted the wrong slug) while still falling back to body
// values for non-route call sites (Phase 7 detector workflow integration
// will mint requests outside the route entirely).
//
// `card_group` is also injected via context — the request schema does
// NOT carry it (workflows shouldn't have to know the AA spec's group
// catalog) and the route resolves it as the card type's RM capability.

import type { CardGenerationRequestT } from './request-schema';
import { indexed5, nonMetadataDefaults } from './relations-defaults';

export interface GroupFieldValues {
  Metadata: Record<string, string>;
  Relations: Record<string, string>;
  'Acceptance Criteria': Record<string, string>;
  Validation: Record<string, string>;
  Requirements: Record<string, string>;
  Principles: Record<string, string>;
  Decisions: Record<string, string>;
  Procedures: Record<string, string>;
}

export interface FromRequestContext {
  /** Resolved stream id (overrides req.stream_id when set). */
  stream_id?: string;
  /** Resolved stream slug (overrides req.stream_slug when set). */
  stream_slug?: string;
  /** Asset binding (overrides req.asset_id when set). */
  asset_id?: string;
  /** Asset kind (overrides req.asset_kind when set). */
  asset_kind?: string;
  /** The card type's RM capability name (tenant catalogue); '' if unknown. */
  card_group?: string;
  /**
   * Requesting tenant (X-Tenant-Id / activeTenantId), stamped into the Metadata
   * keycloak_tenant_id customField. Mirrors project-create (projects.ts). Without
   * it the n8n router's resolveBoardKeycloakTenant falls back to card.projectId —
   * a different id space — as the tenant for downstream emission.
   */
  keycloak_tenant_id?: string;
}

/**
 * Map a validated CardGenerationRequest + resolved context into the per-
 * group customField value bag. Populates every field that exists in Phase 3's
 * GROUP_FIELDS catalog — empty strings rather than missing keys (see `indexed5`
 * rationale). The one deliberate omission is `Metadata.stopwatch_timeout`: the
 * `stopwatch_policy` request field was retired 2026-09-27 (time is not a factor;
 * work is pulled on the WIP limit), so nothing stamps it any more. The catalog
 * slot is left in place so existing boards/cards keep their field definition.
 */
export function valuesFromRequest(
  req: CardGenerationRequestT,
  context: FromRequestContext = {},
): GroupFieldValues {
  const defaults = nonMetadataDefaults(req.card_type);
  return {
    Metadata: {
      work_type: req.card_type,
      card_group: context.card_group ?? '',
      priority: req.priority ?? '',
      scope_level: req.scope_level,
      requestor: req.requestor,
      creator_role: '',
      project_id: req.project_id,
      constraints: JSON.stringify(req.constraints ?? []),
      stream_id: context.stream_id ?? req.stream_id ?? '',
      stream_slug: context.stream_slug ?? req.stream_slug ?? '',
      card_type: req.card_type,
      asset_id: context.asset_id ?? req.asset_id ?? '',
      asset_kind: context.asset_kind ?? req.asset_kind ?? '',
      detector_severity: req.detector_severity ?? '',
      manual_trigger: req.manual_trigger ? 'true' : '',
      worker_name: req.worker_name ?? '',
      keycloak_tenant_id: context.keycloak_tenant_id ?? '',
    },
    Relations: {
      ...defaults.Relations,
      parent_card: req.parent_card_id ?? '',
      requires: JSON.stringify(req.dependencies ?? []),
    },
    // Override criterion slots with request values (indexed5 re-exported from
    // relations-defaults.ts — same logic as the shared helper, applied with
    // request acceptance_criteria items).
    'Acceptance Criteria': indexed5('criterion', req.acceptance_criteria),
    Validation: defaults.Validation,
    // Phase 6 leaves Requirements/Principles/Decisions empty (request
    // template doesn't expose them; later phases bind from the
    // requirements/principles/decisions assets table). Slots are still
    // written so readers never face a missing field.
    Requirements: defaults.Requirements,
    Principles: defaults.Principles,
    Decisions: defaults.Decisions,
    // Procedures names use `.` separator to match the procedures-service
    // regex `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (`::` is rejected). The seeder
    // (scripts/seed-procedure-bindings.ts) creates one entry per
    // `${card_type}.${phase}.action` for all 75 card_types.
    Procedures: defaults.Procedures,
  };
}
