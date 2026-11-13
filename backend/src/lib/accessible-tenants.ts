// src/lib/accessible-tenants.ts
//
// ONE enumeration of "every workspace this caller can act in", shared by
// every surface that presents such a list.
//
// WHY THIS IS SHARED, and not three near-identical local copies:
//
//   `/api/me/workspaces` (the header workspace switcher),
//   `/api/me/usage/by-tenant` (the "Super-admin view — every workspace you
//   can act in" table on /settings/usage) and
//   `/api/me/licenses/by-tenant` all answer the SAME question, so any
//   divergence between them is visible to one user, on one page, in one
//   session — and it was. Measured on production 2026-09-10 as the
//   super-admin `fr-test`: the switcher offered SIX workspaces, the usage
//   breakdown listed FOUR. The two missing rows were `EXEC · nonagentic-exec`
//   (the switcher's list carried `EXECUTION_TENANT_ID`, the usage copy's
//   hard-coded array did not) and `EXEC · fr-test` — the caller's OWN JWT
//   tenant, which the switcher synthesises for a user holding zero
//   `user_roles` rows and the usage copy had no equivalent of. The active
//   workspace was `EXEC · fr-test`, so the page's own headline figure was
//   scoped to a tenant its own table did not contain.
//
//   Each copy carried a comment explaining that it duplicated the switcher's
//   logic "because that route is owned by a parallel worktree". That
//   justification has expired (the switcher's file was last changed by #894,
//   long merged) — and an expired reason to duplicate is exactly how three
//   copies drift apart. Add a source here and all three surfaces gain it.
//
// THREE SOURCES, merged in this order:
//   1. Explicit `user_roles` memberships (the caller's real grants).
//   2. For super-admins, the canonical switchable set — the four reserved
//      internal tenants PLUS the execution tenant — even with no
//      `user_roles` row. Mirrors routes/tenants.ts CANONICAL_TENANTS and the
//      X-Active-Tenant switch gate in middleware/request-context.ts.
//   3. The caller's OWN workspace: their verified JWT `tenant_id` claim,
//      whenever (1) and (2) did not already produce it.
//
// DEDUP + ORDER (lifted unchanged from `/api/me/workspaces`, which is the
// surface currently producing the CORRECT six-row list):
//   * Dedup is by tenant id, FIRST SOURCE WINS. A tenant reachable both as a
//     real membership and as a super-admin scope keeps its real role — never
//     restamped, never emitted twice.
//   * Within source 1, when a user holds several `user_roles` rows in one
//     workspace, the highest-precedence role wins (`rolePrecedence`).
//   * The returned array is in MERGE order (memberships in query order, then
//     super-admin extras in `inArray` row order, then the own row). It is NOT
//     display-sorted: `/api/me/workspaces` applies its own kind-then-name sort
//     afterwards, which is idempotent over this order.
//
// ⭐ George 2026-10-27: the WORKSPACE PICKER uses `listPickerWorkspaces` (end of
// file), which adds every live workspace for an fr super-admin session. This
// list keeps its scope for the by-tenant fan-outs and the hints.
//
// Callers that only need `{id, name}` (the by-tenant fan-outs) ignore the
// `role` / `source` / `archived_at` fields; they exist so the switcher can
// build `MyWorkspaceEntry` without a second query.

import { eq, inArray, isNull } from 'drizzle-orm';
import { db, userRoles, workspaces } from '../db/client';
import { isSuperAdmin } from './super-admin-gate';
import {
  INTERNAL_SYSTEM_TENANT_ID,
  EXECUTION_TENANT_ID,
  AA_CONVEYOR_TENANT_ID,
  V4_CONVEYOR_TENANT_ID,
  KATA_TENANT_ID,
} from '../middleware/internal-tenant-only';
import { normalizeTenantId } from '../utils/tenant';
import { isRealmTenantAdminOf } from '../services/user-roles';
import { decideSwitchTarget, type SuperAdminSessionTrust } from './super-admin-switch-target';

/**
 * Synthetic `role` stamped on the caller's OWN workspace row (source 3).
 *
 * NEW VALUE — deliberately not one of the existing ones. `'super_admin_scope'`
 * would make the row indistinguishable from the internal tenants the caller
 * merely has visibility into, and a real spelling (`'workspace-member'`) would
 * claim a `user_roles` grant that does not exist and would make a genuine
 * member's row look identical to a synthesised one. The frontend switcher's
 * default-pick needs exactly this discriminator (see
 * `frontend/src/lib/stores/workspaces.svelte.ts`).
 *
 * Re-exported by `routes/me/workspaces.ts` — that is its historical import
 * path and existing tests use it.
 */
export const OWN_WORKSPACE_ROLE = 'own_workspace';

/** Synthetic `role` stamped on a workspace visible only via super-admin. */
export const SUPER_ADMIN_SCOPE_ROLE = 'super_admin_scope';

/**
 * Canonical workspaces a super-admin can switch into even without an explicit
 * `user_roles` row: the reserved system tenant PLUS the execution
 * tenant (George's nonagentic-exec working / demo workspace — where the demo
 * execution projects live). Mirrors routes/tenants.ts CANONICAL_TENANTS and
 * the X-Active-Tenant switch gate in middleware/request-context.ts. Without
 * the execution id here the switcher never offered it, so the demo execution
 * project was unreachable — and the `/settings/usage` per-tenant table, which
 * kept its own copy of this array without the execution id, silently omitted
 * that workspace's whole row.
 */
export const SUPER_ADMIN_SWITCHABLE_IDS = [
  INTERNAL_SYSTEM_TENANT_ID,
  EXECUTION_TENANT_ID,
  // fr row 14d: the X-Active-Tenant gate admits every PLATFORM tenant, so the
  // AA conveyor tenant is switchable too (its approvals were unreachable in
  // the UI before). Offered only when a `workspaces` row exists for it.
  AA_CONVEYOR_TENANT_ID,
  // v4 conveyor (George 10-14): super_admin decides its ask_fr approvals.
  // Its `workspaces` row is migration 193_v4_conveyor_workspace.
  V4_CONVEYOR_TENANT_ID,
  // The kata tenant (migration 228): every kata project lives here; a super-admin
  // reaches a kata's board by switching in.
  KATA_TENANT_ID,
] as const;

/** Which of the three sources produced a row. */
export type AccessibleTenantSource =
  | 'membership'
  | 'super_admin_scope'
  | 'own_workspace';

export interface AccessibleTenant {
  id: string;
  /**
   * Display name. From `workspaces.name` (NOT NULL, migration-backed) for
   * sources 1 and 2; for source 3 the JWT `tenant_name` claim falling back to
   * the id, because the caller's own tenant need not have a `workspaces` row
   * at all.
   */
  name: string;
  /**
   * The caller's explicit `user_roles` role, or one of the two synthetic
   * markers (`SUPER_ADMIN_SCOPE_ROLE`, `OWN_WORKSPACE_ROLE`). Neither
   * synthetic value confers anything: every backend gate reads `user_roles`
   * (or the realm `tenant_admin` arm, below).
   *
   * EXCEPTION — `'workspace-admin'` is stamped on the row whose id is the
   * caller's RAW `tenant_id` claim when they hold the Keycloak realm role
   * `tenant_admin` (`isRealmTenantAdminOf`), whatever source produced it. That
   * mirrors what every backend gate now answers for that tenant, so the
   * frontend shows admin navigation there. `source` is NOT changed, so the
   * switcher's "which row is mine" pick keys on `source`, not `role`.
   */
  role: string;
  source: AccessibleTenantSource;
  /** `null` for source 3 (no `workspaces` row is required). */
  archived_at: Date | null;
}

/**
 * The caller. `User`-shaped, but widened to the four fields this needs so
 * claims-derived callers and tests can pass a literal.
 */
export interface AccessibleTenantSubject {
  id: string;
  roles?: readonly string[];
  tenantId?: string | null;
  tenantName?: string | null;
  /** RAW `tenant_id` claim (`User.tenantClaim`) — the tenant_admin arm pins to it. */
  tenantClaim?: string;
}

/**
 * Highest-privilege role wins when a user holds multiple `user_roles` rows in
 * one workspace (e.g. admin + member). 'workspace-admin' > 'workspace-member' >
 * anything. A DB 'admin' row cannot exist (migration 104 CHECK), so it gets no
 * admin precedence.
 */
export function rolePrecedence(role: string): number {
  if (role === 'workspace-admin') return 100;
  if (role === 'workspace-member') return 50;
  return 10;
}

/**
 * Enumerate every workspace `user` can act in. See the file header for the
 * three sources and the dedup/order contract.
 *
 * Cost: one join, plus at most one `inArray` lookup of ≤5 ids for
 * super-admins. Source 3 costs no query at all.
 */
export async function listAccessibleTenants(
  user: AccessibleTenantSubject,
): Promise<AccessibleTenant[]> {
  // 1. Real memberships via user_roles → workspaces join.
  const memberRows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      archived_at: workspaces.archived_at,
      role: userRoles.role,
    })
    .from(userRoles)
    .innerJoin(workspaces, eq(workspaces.id, userRoles.tenant_id))
    .where(eq(userRoles.user_id, user.id));

  const memberByWorkspace = new Map<
    string,
    { name: string; role: string; archived_at: Date | null }
  >();
  for (const r of memberRows) {
    const existing = memberByWorkspace.get(r.id);
    if (!existing || rolePrecedence(r.role) > rolePrecedence(existing.role)) {
      memberByWorkspace.set(r.id, {
        name: r.name,
        role: r.role,
        archived_at: r.archived_at,
      });
    }
  }

  const out: AccessibleTenant[] = [];
  for (const [id, v] of memberByWorkspace) {
    out.push({
      id,
      name: v.name,
      role: v.role,
      source: 'membership',
      archived_at: v.archived_at,
    });
  }

  // 2. Super-admin extras: surface every canonical switchable workspace the
  //    user doesn't already hold a real role in.
  if (isSuperAdmin(user)) {
    const alreadyVisible = new Set(out.map((e) => e.id));
    const missingInternalIds = SUPER_ADMIN_SWITCHABLE_IDS.filter(
      (id) => !alreadyVisible.has(id),
    );
    if (missingInternalIds.length > 0) {
      const internalRows = await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          archived_at: workspaces.archived_at,
        })
        .from(workspaces)
        .where(inArray(workspaces.id, missingInternalIds as unknown as string[]));
      for (const r of internalRows) {
        out.push({
          id: r.id,
          name: r.name,
          role: SUPER_ADMIN_SCOPE_ROLE,
          source: 'super_admin_scope',
          archived_at: r.archived_at,
        });
      }
    }
  }

  // 3. The caller's OWN workspace — the verified JWT `tenant_id` claim.
  //
  //    Measured in the production fr Postgres 2026-08-28/30: the super-admin
  //    `fr-test` (32969c16-6ecd-49fe-a106-ba13e6640dc8) holds ZERO `user_roles`
  //    rows (positive control: the table has 13 rows and other users do have
  //    them), and their Keycloak `tenant_id` attribute is `0195f48b-…-0099` —
  //    NOT in SUPER_ADMIN_SWITCHABLE_IDS. Without this block their own
  //    workspace appears in no list at all, which made the switcher auto-pick
  //    and PERSIST somebody else's workspace and made the usage breakdown omit
  //    the very tenant its headline total was computed from.
  //
  //    Safety: `middleware/request-context.ts` accepts an `X-Active-Tenant`
  //    header only from a caller carrying the SIGNED `super_admin` realm role,
  //    and then only for INTERNAL_TENANT_SET, EXECUTION_TENANT_ID, **or
  //    `activeTenantHeader === jwtTenantId`** — and `jwtTenantId` is exactly
  //    the value `keycloak.validateToken` puts on `user.tenantId`. The row we
  //    add here therefore always carries an id that gate accepts.
  //    `normalizeTenantId` keeps a non-UUID legacy tenant claim out entirely:
  //    its accepted set is a strict subset of the request-context `UUID_RE`,
  //    so we never offer a chip the gate would discard.
  const { tenantId: ownTenantId } = normalizeTenantId(user.tenantId ?? '');
  if (ownTenantId && !out.some((e) => e.id === ownTenantId)) {
    out.push({
      id: ownTenantId,
      name: user.tenantName || ownTenantId,
      role: OWN_WORKSPACE_ROLE,
      source: 'own_workspace',
      archived_at: null,
    });
  }

  // 4. Realm `tenant_admin` of the claimed tenant → `workspace-admin` there.
  //    Pinned to the RAW claim (never `user.tenantId`, which falls back to
  //    `sub`), and only ever RAISES a role: a real higher-or-equal grant is
  //    left untouched. `source` is preserved — see `AccessibleTenant.role`.
  const claim = user.tenantClaim;
  if (claim) {
    for (const row of out) {
      if (
        row.id === claim &&
        isRealmTenantAdminOf({ roles: [...(user.roles ?? [])], tenantClaim: claim }, row.id) &&
        rolePrecedence(row.role) < rolePrecedence('workspace-admin')
      ) {
        row.role = 'workspace-admin';
      }
    }
  }

  return out;
}

/**
 * ⭐ The WORKSPACE PICKER's list (`GET /api/me/workspaces`) — George 2026-10-27:
 * a super_admin on an fr super-admin session is tenant-admin of every tenant it
 * switches into, so it is offered EVERY live workspace (by name).
 *
 * Deliberately a SEPARATE list from `listAccessibleTenants`, which keeps its
 * scope (memberships + platform set + own tenant) for the by-tenant usage /
 * licence fan-outs and the approval / project hints.
 *
 * `session` MUST be the request gate's own answer (the frame's
 * `callerIsFrSuperAdminSession`, computed by `buildRequestContext` with
 * `superAdminSessionTrustFromClaims`), and every row is filtered by the gate's
 * own rule (`decideSwitchTarget`), so the picker never offers a workspace the
 * X-Active-Tenant gate refuses. On an fr session every row but the caller's own
 * is stamped `workspace-admin` — exactly what the backend's tenant-admin gates
 * answer once the switch is accepted (`isRealmTenantAdminOf`'s switch arm), so
 * the UI's admin navigation never shows a control the backend refuses. The own
 * row keeps the realm arm's answer (step 4 above).
 */
export async function listPickerWorkspaces(
  user: AccessibleTenantSubject,
  session: SuperAdminSessionTrust,
): Promise<AccessibleTenant[]> {
  const base = await listAccessibleTenants(user);
  if (!isSuperAdmin(user)) return base;
  const { tenantId: ownId } = normalizeTenantId(user.tenantId ?? '');
  const rows: AccessibleTenant[] = [...base];
  if (session === 'fr') {
    const seen = new Set(rows.map((r) => r.id));
    const live = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(isNull(workspaces.archived_at));
    for (const w of live) {
      if (seen.has(w.id)) continue;
      rows.push({ id: w.id, name: w.name, role: SUPER_ADMIN_SCOPE_ROLE, source: 'super_admin_scope', archived_at: null });
    }
  }
  return rows
    .filter((t) => decideSwitchTarget(t.id, ownId, { archived_at: t.archived_at }, { session }).ok)
    .map((t) =>
      session !== 'fr' || t.source === 'own_workspace' || t.id === ownId ? t : { ...t, role: 'workspace-admin' },
    );
}
