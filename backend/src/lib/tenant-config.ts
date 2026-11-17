// src/lib/tenant-config.ts
//
// The canonical tenant ids, read from the ENVIRONMENT.
//
// ⛔ WHY THEY ARE NOT LITERALS. This repository is public, and until 2026-11-16
// the reserved tenant uuids (system, execution, kata, the AA conveyor and the v4
// conveyor) were `as const` literals in `middleware/internal-tenant-only.ts`.
// That published the workspace map of the production estate — who is platform,
// which reserved id is which — to anyone reading the repo, and made every tenant
// rename a cross-repo edit.
//
// The values now live in gitops, on the Deployment, beside the Keycloak realm
// configuration that mints them.
//
// ⛔ EVERY ACCESSOR FAILS CLOSED. Unset means "not a tenant", never "a default":
//   * unset system/execution/kata/conveyor id → that role is absent from
//     `platformTenantIds()`, so `isPlatformTenant` answers false for it
//   * `internalTenantIds()` is empty, so `isInternalTenant` answers false
//   * `canonicalTenantNames()` is empty, so a diagnostic cannot name a tenant
// The app still BOOTS: a missing tenant id narrows access instead of taking the
// service down. That is the opposite of `requireDatabaseUrl()`, deliberately —
// this is an authorisation input, and refusing every caller is the safe failure.
//
// ⚠️ Read at CALL time (like `configuredDatabaseUrl`), not frozen at import, so
// a value set before first use is honoured and tests can vary it per case.

/** Thrown when an env value is not a canonical (8-4-4-4-12) non-nil uuid. */
export class TenantConfigError extends Error {
  constructor(envName: string, raw: string, why: string) {
    super(`[fr] ${envName}=${JSON.stringify(raw)} is not usable: ${why}`);
    this.name = 'TenantConfigError';
  }
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A single canonical tenant uuid from `envName`, or undefined when unset/blank.
 *
 * ⛔ A MALFORMED VALUE THROWS. Silently ignoring it would narrow access without
 * telling the operator — the failure mode looks exactly like "that tenant was
 * never platform", which is how a typo survives a deploy.
 */
export function configuredTenantId(envName: string): string | undefined {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (!CANONICAL_UUID.test(value)) {
    throw new TenantConfigError(envName, raw, 'expected a canonical 8-4-4-4-12 uuid');
  }
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new TenantConfigError(envName, raw, 'the nil uuid is never a tenant');
  }
  return value;
}

/** The RESERVED SYSTEM tenant — owner of system-written rows. Undefined when unset. */
export function internalSystemTenantId(): string | undefined {
  return configuredTenantId('FR_INTERNAL_SYSTEM_TENANT_ID');
}

/** George's canonical working/demo "execution" workspace. Undefined when unset. */
export function executionTenantId(): string | undefined {
  return configuredTenantId('FR_EXECUTION_TENANT_ID');
}

/** The ONE internal workspace whose projects run as a kata. Undefined when unset. */
export function kataTenantId(): string | undefined {
  return configuredTenantId('FR_KATA_TENANT_ID');
}

/** The n8n-dev / AA conveyor tenant. Undefined when unset. */
export function aaConveyorTenantId(): string | undefined {
  return configuredTenantId('FR_AA_CONVEYOR_TENANT_ID');
}

/** The v4 conveyor tenant. Undefined when unset. */
export function v4ConveyorTenantId(): string | undefined {
  return configuredTenantId('FR_V4_CONVEYOR_TENANT_ID');
}

/**
 * internalTenantIds(): the reserved system tenant + kata, in that order.
 *
 * Empty when neither is configured. A role whose env is unset is simply absent —
 * it does not fall back to another tenant, because a fallback here would admit a
 * tenant nobody configured.
 */
export function internalTenantIds(): readonly string[] {
  return [internalSystemTenantId(), kataTenantId()].filter(
    (id): id is string => typeof id === 'string',
  );
}

/**
 * platformTenantIds(): internal (system + kata) + execution + both conveyor
 * tenants.
 *
 * ⛔ DERIVED FROM THE ROLE ENVS, never a second list. worker_management mirrors
 * this set from its own `platformTenantIds()`; the drift test compares the two
 * deployed values, so there is exactly one place a role is declared.
 */
export function platformTenantIds(): ReadonlySet<string> {
  return new Set<string>([
    ...internalTenantIds(),
    executionTenantId(),
    aaConveyorTenantId(),
    v4ConveyorTenantId(),
  ].filter((id): id is string => typeof id === 'string'));
}

/**
 * id → name for the canonical tenants. `routes/tenants.ts` builds its
 * `CANONICAL_TENANTS` display list from this map, so there is one place a name
 * is spelled.
 *
 * ⚠️ ALSO A DIAGNOSTIC. These uuids are WORKSPACE ids; a producer that puts one
 * in a `project_id` field gets a truthful "not found" that reads as a missing
 * row. `canonicalTenantName` lets a refusal SAY that instead of leaving the
 * reader to guess between "deleted", "other tenant" and "wrong entity kind".
 *
 * Only configured roles appear. An unset role has no name to report.
 */
export function canonicalTenantNames(): Readonly<Record<string, string>> {
  const entries: Array<[string | undefined, string]> = [
    [internalSystemTenantId(), 'system'],
    [executionTenantId(), 'execution'],
    [kataTenantId(), 'kata'],
  ];
  const map: Record<string, string> = {};
  for (const [id, name] of entries) {
    if (id !== undefined) map[id] = name;
  }
  return map;
}
