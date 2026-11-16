// Project type → owning tenant. ONE map, and ONE creatability rule behind it.
//
// (George 2026-09-28, five tenants; AA_IMPLEMENTATION/TENANCY_AND_IMPROVEMENT.md §3,
// trigger_registry.md. The improvement types kaizen / meta_prompt / meta_procedure and their
// three tenants were deleted 2026-11-03, kata-super-admin §7.) Execution work (program / it /
// feature) lives in EXECUTION (…0003) — or in a customer's own tenant. ⭐ TENANCY POLICY, NOT
// VOCABULARY (design: fr consumes RM vocabulary, George 2026-10-12): which project types EXIST
// is the tenant's RM catalogue (services/catalogue/tenant-catalogue.ts, checked in
// createSingleProject); this map only pins a type NAME to the tenant that owns it, so it stays
// in fr, keyed by name. A name not in the map is unpinned. SYSTEM (…0001) owns exactly one
// type, `system_ops`: a NON-ORCHESTRATED attribution project (movies-73 2026-10-08,
// George-approved system projects) — never a conveyor start (shouldOrchestrateProjectStart),
// super_admin-only (assertSystemOpsCreator).
//
// ⭐ `projectTypeCreatableOn` is the ONE rule. The create door asserts it (routes/projects.ts
// `assertProjectTypeTenant`, 400 `project_type_tenant_mismatch`) and the type picker / agent
// list publish it (`startable`), so a type the picker OFFERS can never be refused on create —
// that mismatch was live for `kata` in the conveyor workspace until 2026-11-07 (the picker
// keyed `startable` on the phase list alone).

import {
  executionTenantId,
  internalSystemTenantId,
  kataTenantId,
} from '../middleware/internal-tenant-only';

export const SYSTEM_OPS_PROJECT_TYPE = 'system_ops';

/**
 * Project type → the ROLE whose tenant it is pinned to.
 *
 * ⛔ A ROLE MAP, not a uuid map: the uuids are environment-supplied now, so the
 * map is resolved per call by :func:`projectTypeTenant`. A map of resolved uuids
 * would have to be rebuilt whenever the env changed, and would silently hold a
 * snapshot taken at import.
 */
const PROJECT_TYPE_TENANT_ROLE: Readonly<Record<string, () => string | undefined>> = {
  system_ops: internalSystemTenantId,
  program: executionTenantId,
  it: executionTenantId,
  feature: executionTenantId,
  // The kata tenant (migration 228) holds every kata project, and only kata projects
  // (services/katas/open.ts creates them; POST /api/katas is the only door).
  kata: kataTenantId,
};

/** Every project type with its CURRENT tenant (uuid `undefined` for an unconfigured role). */
export function projectTypeTenantMap(): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(PROJECT_TYPE_TENANT_ROLE).map(([type, role]) => [type, role()]),
  );
}

/** The tenant a project type is pinned to, or undefined for an unmapped / absent type. */
export function projectTypeTenant(projectType: string | undefined): string | undefined {
  if (!projectType) return undefined;
  // ⛔ OWN PROPERTIES ONLY. A bare index would answer for `toString`,
  // `constructor` and every other inherited key — `projectTypeTenant('toString')`
  // returned the string "[object Undefined]" before this guard, because the
  // inherited `Object.prototype.toString` was CALLED as a role accessor.
  const role = Object.hasOwn(PROJECT_TYPE_TENANT_ROLE, projectType)
    ? PROJECT_TYPE_TENANT_ROLE[projectType]
    : undefined;
  return role ? role() : undefined;
}

/**
 * The canonical tenants that are NOT execution homes: SYSTEM and KATA. A project
 * on one of them must carry exactly the project type mapped to it (KATA accepts
 * only `kata`).
 * SYSTEM accepts only system_ops (non-orchestrated attribution projects; movies-73 2026-10-08,
 * George-approved system projects).
 */
function nonExecutionCanonicalTenants(): ReadonlySet<string> {
  return new Set(
    [internalSystemTenantId(), kataTenantId()].filter(
      (id): id is string => typeof id === 'string',
    ),
  );
}

/**
 * True when a project of `projectType` may be created on `tenantId`.
 *
 * Pinned type on its own tenant → yes. A NON-execution canonical tenant (SYSTEM, KATA) →
 * only its own type. An EXECUTION-pinned type elsewhere → yes (EXECUTION itself, or a
 * customer tenant running its own program/it). Unmapped types on EXECUTION / a customer
 * tenant are unaffected.
 */
export function projectTypeCreatableOn(
  projectType: string | undefined,
  tenantId: string,
): boolean {
  const expected = projectTypeTenant(projectType);
  if (expected !== undefined && tenantId === expected) return true;
  if (nonExecutionCanonicalTenants().has(tenantId)) return false;
  return !(expected !== undefined && nonExecutionCanonicalTenants().has(expected));
}
