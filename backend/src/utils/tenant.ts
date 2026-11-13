// src/utils/tenant.ts
//
// Tenant-id contract (going forward):
//   * `tenant_id` MUST be a UUID — UUIDv7 in production once the Keycloak
//     realm session lands the claim migration. The all-zero UUID is the
//     system/bootstrap tenant used by AUTH_BYPASS dev paths and the
//     env-var-driven admin bootstrap (see services/user-roles.ts).
//   * `tenant_name` is the legible display string ("gerard-dev", etc).
//     Optional. Carried alongside `tenant_id` in JWT claims and on the
//     `user_roles.tenant_name` column (migration 024).
//
// Legacy / transition behaviour:
//   * Older Keycloak users still carry a non-UUID `tenant_id` claim
//     (e.g. "gerard-dev"). Until the realm migration ships, those values
//     flow through `deriveTenantId` unchanged — but DB-backed callers
//     (services/user-roles.ts) gracefully degrade to "no DB-backed admin"
//     instead of throwing PostgresError on the bad cast. The `roles`
//     claim path (Keycloak `admin` role) keeps working for those users.
//
// All exports are pure: zero I/O, no side effects.

/**
 * Strict UUID v1–v8 regex. Mirrors the shape produced by
 * `node:crypto.randomUUID` (RFC 9562). Used by `isValidUuid` and
 * `normalizeTenantId` to detect legacy non-UUID claims before they hit
 * a PostgreSQL `uuid` column.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bootstrap / system tenant pattern: an all-zero UUID prefix (version +
 * variant nibbles both `0`) with an arbitrary 12-hex suffix. Matches the
 * Nil UUID (`…000`, the AUTH_BYPASS dev tenant) and the small set of
 * reserved-namespace tenants prod uses for system rows (`…001`, `…002`,
 * etc.). Strictly speaking these are not RFC 9562 v1–v8 UUIDs (they have
 * version=0), but they ARE valid PostgreSQL `uuid` literals and shipped
 * in production tables before this validator existed. Accepting them here
 * keeps the DB-backed admin gate (`services/user-roles.ts:hasRole`)
 * reachable in those tenants instead of silently denying every check.
 */
const BOOTSTRAP_UUID_RE = /^00000000-0000-0000-0000-[0-9a-f]{12}$/i;

/**
 * True iff `value` is a syntactically valid UUID safe to send at a
 * PostgreSQL `uuid` column. Two acceptable shapes:
 *   1. RFC 9562 v1–v8 UUID (the `node:crypto.randomUUID` shape).
 *   2. Bootstrap/system tenant — `00000000-0000-0000-0000-XXXXXXXXXXXX`
 *      where the last 12 hex are arbitrary. Used by AUTH_BYPASS dev
 *      paths and pre-existing prod system rows.
 */
export function isValidUuid(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (BOOTSTRAP_UUID_RE.test(value)) return true;
  return UUID_RE.test(value);
}

/**
 * Derive a tenant identifier from a JWT claims object.
 *
 * Resolution order (mirrors the w2v pattern at `0ba87d4`):
 *   1. `tenant_id` custom claim (when the IdP has been wired to emit one)
 *   2. `sub` (Keycloak user UUID) as the per-user fallback
 *   3. `null` when neither is present — this function does NOT invent a tenant
 *
 * Why `null` and not the old `"anonymous"` literal: a request carrying no
 * verified claims at all already resolves to no tenant — `tenantFromClaims`
 * (middleware/request-context.ts) yields `undefined` and
 * `integrations/_lib/http-client.ts` only sets `X-Tenant-Id` when the value is
 * truthy — so the header is simply omitted and each upstream applies its own
 * default. `"anonymous"` made the *other* unauthenticated path behave
 * differently: it fabricated a tenant that is neither a UUID nor any
 * registered tenant name. Since 2026-08-25 worker_management stores
 * `tenant_id` in a real Postgres `uuid` column and answers `400
 * INVALID_TENANT` to anything that is not a canonical lowercase UUID or one of
 * its six known tenant names, so that fabricated value is now a hard reject.
 * Returning `null` makes both unauthenticated paths omit the header instead.
 *
 * Note this deliberately does NOT narrow case 1: a legacy non-UUID
 * `tenant_id` claim (e.g. "gerard-dev") still flows through unchanged, because
 * such names still resolve at several upstreams. Narrowing that is a separate
 * decision.
 *
 * Callers that must talk to the database (e.g. `user_roles.tenant_id` is
 * `uuid`) should run a non-null result through `normalizeTenantId` and treat a
 * `null` tenantId as "skip the DB-backed admin gate" rather than 500ing on a
 * cast failure.
 *
 * Pure function: no I/O, no side effects.
 */
export function deriveTenantId(
  claims: Record<string, unknown>,
): string | null {
  const tenantId = claims.tenant_id;
  if (typeof tenantId === 'string' && tenantId.length > 0) {
    return tenantId;
  }
  const sub = claims.sub;
  if (typeof sub === 'string' && sub.length > 0) {
    return sub;
  }
  return null;
}

/**
 * True iff the claims belong to a Keycloak SERVICE ACCOUNT (a client-credentials
 * token), not a human user. Keycloak names every service-account user
 * `service-account-<clientId>` in `preferred_username`, and the client-
 * credentials session stamps a `client_id` (older realms: `clientId`) claim.
 *
 * ⚠️ `azp` alone is NOT a signal: every Keycloak token carries `azp` (the
 * client the token was issued to), user tokens included.
 *
 * Pure function: no I/O, no side effects.
 */
export function isServiceAccountClaims(claims: Record<string, unknown>): boolean {
  const username = claims.preferred_username;
  if (typeof username === 'string' && username.startsWith('service-account-')) {
    return true;
  }
  const clientId = claims.client_id ?? claims.clientId;
  return typeof clientId === 'string' && clientId.length > 0;
}

/**
 * True iff `deriveTenantId` would hand back a SERVICE ACCOUNT's `sub` as the
 * tenant — i.e. the token is a service account AND carries no `tenant_id`
 * claim, so the `sub` fallback fires. A service account's `sub` is its
 * Keycloak user id, never a tenant (TENANCY_AND_IMPROVEMENT.md §2.4: fr stamped
 * the fr-backend SA sub `6d5a9a20-…` as a tenant on three streams). Writes that
 * create tenant-owned rows must refuse this case.
 */
export function isServiceAccountSubjectTenant(claims: Record<string, unknown>): boolean {
  const tenantId = claims.tenant_id;
  if (typeof tenantId === 'string' && tenantId.length > 0) return false;
  return isServiceAccountClaims(claims);
}

/**
 * Derive the legible tenant name from a JWT claims object. Optional —
 * Keycloak only emits this once the realm migration lands; until then
 * callers see `null` and must rely on `deriveTenantId` alone.
 */
export function deriveTenantName(
  claims: Record<string, unknown>,
): string | null {
  const tenantName = claims.tenant_name;
  if (typeof tenantName === 'string' && tenantName.length > 0) {
    return tenantName;
  }
  return null;
}

/**
 * Normalise a raw tenant claim value into something safe to send at a
 * PostgreSQL `uuid` column. Returns `{ tenantId: <value> }` when `value`
 * is a valid UUID; otherwise `{ tenantId: null }` so callers can detect
 * the legacy non-UUID path and skip DB-backed work without throwing.
 *
 * Intentionally tiny so DB-touching code paths can do:
 *
 *     const { tenantId } = normalizeTenantId(user.tenantId);
 *     if (tenantId === null) return false; // graceful no-admin
 */
export function normalizeTenantId(
  value: string,
): { tenantId: string | null } {
  return { tenantId: isValidUuid(value) ? value : null };
}
