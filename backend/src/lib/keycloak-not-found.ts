/**
 * Does this thrown value mean "Keycloak has no such user"?
 *
 * `keycloak.getUserTenantAndRoles` throws an IntegrationError carrying
 * `upstreamStatus: 404` for a missing user (services/keycloak.ts ::
 * identityLookupUnavailable). Structural checks only — matching the message
 * text would let an unrelated "not found" (a missing role, a bad realm)
 * masquerade as a deleted account and be silently skipped.
 *
 * Dependency-free on purpose: shared by the live write-through
 * (services/tenant-admin-sync.ts) and the backfill script, which must load
 * without a database or Keycloak config.
 *
 * ⚠️ Only meaningful on the result of a USER LOOKUP. A 404 from a role-mapping
 * write (assign/remove) is not proof the user is gone and must stay a failure.
 */
export function isKeycloakNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { upstreamStatus?: unknown; status?: unknown; statusCode?: unknown };
  return e.upstreamStatus === 404 || e.status === 404 || e.statusCode === 404;
}
