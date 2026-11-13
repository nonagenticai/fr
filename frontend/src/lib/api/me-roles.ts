// src/lib/api/me-roles.ts
//
// Typed client for the fr backend's `/api/me/dept-roles` endpoint.
//
// ⚠️ CORRECTED — this header used to be a "wire contract (for the Wave-3 backend
// agent to match)". The endpoint SHIPPED: `backend/src/routes/me/dept-roles.ts`
// (`handleListMyDeptRoles`), routed at `backend/src/server.ts` as
// `GET /api/me/dept-roles`. The contract below is now a description of a live
// route, not a request to a future one — and reading the live route turned up
// two ways this client was wrong.
//
// ⛔ DEFECT 1, live and silent: the route answers `jsonResponse({ data: out })`,
// so the body is `{"data":{"<dept_id>":"<role>"}}`. This client did
// `(await r.json()) as Record<string, DeptRole>` and returned the ENVELOPE, so
// `auth._deptRoles` was `{ data: {...} }` and every `hasDeptRole(deptId, …)`
// lookup read `_deptRoles[deptId]` → `undefined` → false. Every dept-scoped
// gate in the app was therefore closed for everyone, with no error anywhere:
// the fetch succeeded, the cast satisfied TypeScript, and the only symptom was
// permissions that quietly never applied. Its test was green because its
// fixture returned the BARE map — a shape the service has never sent.
//
// ⛔ DEFECT 2: 404/501 were swallowed as "endpoint not yet deployed". It IS
// deployed, so a 404 today means the route is missing from a running build or
// the request never reached fr — a real fault, and returning `{}` for it
// manufactures "this user belongs to no department" out of an outage. It now
// throws like any other non-2xx. The auth store still catches and falls back to
// `{}` (fail-closed is right for a permission gate), but the failure is LOGGED
// instead of being indistinguishable from a genuine empty membership.
//
// Live contract:
//   GET /api/me/dept-roles
//   Auth: Bearer JWT (Keycloak access token, via auth-fetch)
//   200 OK
//     Body: { data: Record<string /* department_id */, DeptRole> }
//     Example: { "data": { "dept-eng": "dept-admin", "dept-ops": "dept-member" } }
//     `{ "data": {} }` is VALID and means zero memberships.
//   Any non-2xx (401/403/404/5xx)
//     Throws `Error('listMyDeptRoles: <status>')`.
//
// Source of truth on the backend: the `department_members` table joined to the
// JWT-resolved `user_id`. One row per (user_id, dept_id).

import { authFetch } from './auth-fetch';

export type DeptRole = 'dept-admin' | 'dept-manager' | 'dept-member' | 'dept-viewer';

const DEPT_ROLES = new Set<string>([
  'dept-admin',
  'dept-manager',
  'dept-member',
  'dept-viewer',
]);

/**
 * Pull the role map out of the response body.
 *
 * Reads `data` when present and falls back to the bare object otherwise. The
 * fallback is NOT hedging about which shape is real — `{ data }` is what the
 * route sends — it keeps the client working against a body that has already
 * been unwrapped by a caller or a proxy, without which a single envelope change
 * silently empties every permission map again.
 *
 * Values are filtered to the four known roles: an unrecognised string is not a
 * role this app can rank, and admitting it would let `hasDeptRole` compare
 * against `undefined` in the rank table.
 */
function extractRoleMap(body: unknown): Record<string, DeptRole> {
  if (!body || typeof body !== 'object') return {};
  const outer = body as Record<string, unknown>;
  const inner =
    outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
      ? (outer.data as Record<string, unknown>)
      : outer;
  const out: Record<string, DeptRole> = {};
  for (const [deptId, role] of Object.entries(inner)) {
    if (typeof role === 'string' && DEPT_ROLES.has(role)) {
      out[deptId] = role as DeptRole;
    }
  }
  return out;
}

export async function listMyDeptRoles(): Promise<Record<string, DeptRole>> {
  const r = await authFetch('/api/me/dept-roles');
  if (!r.ok) {
    // ⚠️ No 404/501 exemption. The route exists; a 404 is a fault to report,
    // not a deployment stage to absorb. See DEFECT 2 above.
    throw new Error(`listMyDeptRoles: ${r.status}`);
  }
  return extractRoleMap(await r.json());
}
