/**
 * fr#1385 Option 1 — does a VERIFIED portal token prove the effective tenant?
 *
 * Shared contract with worker_management: both sides grade the SAME vectors
 * (`tests/fixtures/tenant-membership/tenant_membership_vectors.json`, which must
 * stay byte-identical to worker_management's copy — its sha256 is pinned in
 * `tests/unit/middleware/tenant-membership.test.ts`).
 *
 * proven ⇔ `tenant_id` is a non-empty string AND
 *          (effective === tenant_id OR effective ∈ member_tenant_ids).
 *
 *  - `member_tenant_ids` is a signed, admin-managed Keycloak claim; it may be a
 *    single string or an array. Non-string entries are ignored.
 *  - Matching is EXACT: no trimming, no case-folding. A loose match here would
 *    forward a live user credential for a tenant the token does not name.
 *  - An empty / null / undefined effective tenant is never proven.
 *
 * `claims` MUST come from a verified token (JWKS + issuer). This function does
 * no verification of its own; it only grades claims it is handed.
 */
export function tokenProvesTenant(
  claims: Record<string, unknown> | null | undefined,
  effective: string | null | undefined,
): boolean {
  if (!claims || typeof effective !== 'string' || effective === '') return false;
  const home = claims.tenant_id;
  if (typeof home !== 'string' || home === '') return false;
  if (effective === home) return true;
  const members = claims.member_tenant_ids;
  if (typeof members === 'string') return members === effective;
  if (Array.isArray(members)) {
    return members.some((m) => typeof m === 'string' && m === effective);
  }
  return false;
}
