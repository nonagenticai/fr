// src/lib/project-access.ts
//
// Shared tenant-scoped project resolution for project SUB-RESOURCE handlers
// (provision, github-token, status, patch, repositories, comments, documents,
// metrics). The canonical project read/delete (handleGetProject /
// handleDeleteProject) already scope by active tenant via this filter; these
// helpers let every sub-resource use the IDENTICAL gate so the super-admin
// X-Active-Tenant switcher behaves predictably across the whole surface and
// the lookup self-protects against a future multi-tenant-per-user model.
//
// Tenant scope is derived via projects.dept_id → departments.workspace_id (the
// workspace IS the tenant — see schema.ts §workspaces comment). Projects with
// NULL dept_id are legacy rows from before Foundation Plan 2 — they're only
// visible in the user's JWT-home tenant so the switcher stays predictable. A
// dedicated projects.tenant_id column would be cleaner but isn't required;
// see migration 036 note.
//
// Callers pass their own `db` handle (the production singleton or the
// transaction they are already inside).
import { db, projects, departments } from '../db/client';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ctxTenantId, setProjectId, tryGetRequestContext } from '../middleware/request-context';
import { isSuperAdmin } from './super-admin-gate';
import { isSuperAdminSwitchedInto } from './super-admin-switch';
import { guardProjectId } from './project-owner-guard';
import { NotFoundError } from '../utils/errors';
import { isUuidShape } from './uuid-shape';
import { assertProjectNotArchived } from './project-live-status';
import type { User } from '../types/api';

type DbHandle = typeof db;
// `roles` is optional: callers that lack it (a few sub-resource paths build a
// minimal {id, tenantId} subject) simply never qualify for the super-admin
// switched view — isSuperAdmin returns false for an undefined roles list.
type ScopeUser = Pick<User, 'id' | 'tenantId'> & {
  roles?: readonly string[];
  authKind?: User['authKind'];
};

/**
 * ⭐ THE LICENCE LANE (George 2026-10-10, G3). A licence caller (`authKind ===
 * 'licence'`, tenant PINNED by lib/licence-introspect.ts, no realm roles) is a
 * customer's n8n acting for its WHOLE tenant, not a person who owns projects —
 * so it reaches ANY project whose own tenant tag equals the licence's tenant,
 * regardless of owner, on every project-scoped route.
 *
 * Spread the result into `tenantScopedProjectFilter`'s opts at every call site
 * that has a `user`: `{}` for every non-licence caller, so a Keycloak JWT's
 * predicate is byte-identical to before.
 */
export function licenceProjectScope(
  user: { authKind?: User['authKind']; tenantId: string },
): { licenceTenantId?: string } {
  return user.authKind === 'licence' ? { licenceTenantId: user.tenantId } : {};
}

// The project's real tenant association in practice. The Foundation-model
// dept_id→departments.workspace_id join is unpopulated in production (every
// projects row has dept_id = NULL), so the authoritative tenant tag is the
// `project_data.keycloak_tenant_id` written at creation time.
export const PROJECT_KC_TENANT = sql`${projects.project_data}->>'keycloak_tenant_id'`;

/**
 * SQL predicate: a Planka-backed `projects` row belongs to `tenantId` via EITHER
 * visibility lane — the Foundation-model `dept_id → departments.workspace_id`
 * join, OR the `project_data.keycloak_tenant_id` tag (the authoritative tag in
 * production, where `dept_id` is NULL). Mirrors the switched-view branch of
 * `tenantScopedProjectFilter`, so the inline kanban override queries
 * (`handleListBoards` / `handleGetBoard`) scope identically to the project
 * list/get handlers. Callers must `leftJoin(departments, …)` so
 * `departments.workspace_id` is in scope.
 */
export function plankaProjectTenantMatch(tenantId: string) {
  return or(
    eq(departments.workspace_id, tenantId),
    eq(PROJECT_KC_TENANT, tenantId),
  );
}

/**
 * True when the requester is a super-admin who has switched (via the
 * X-Active-Tenant header) into a workspace other than their JWT home tenant.
 * In that case project scoping must (a) drop the owner filter and (b) match by
 * the real tenant tag, so the whole switched workspace is visible. Computed
 * off the active request frame (`activeTenantSource`), so sub-resource readers
 * stay consistent with the list/get handlers.
 */
export function isSuperAdminSwitchedView(
  user: { roles?: readonly string[]; tenantId: string },
  activeTenantId: string,
): boolean {
  const ctx = tryGetRequestContext();
  return (
    ctx?.activeTenantSource === 'header' &&
    activeTenantId !== user.tenantId &&
    isSuperAdmin(user)
  );
}

/**
 * True when a super-admin is operating in their home/default view (no active
 * X-Active-Tenant header override) — the SAME branch `assertBoardTenantAuthorized`
 * (board-tenant-access.ts) uses to grant an omniscient cross-tenant board read.
 * ⛔ fr row 14d: the approvals lanes (list/get/decide) and the deliveries
 * list NO LONGER use this — every approvals lane is `approvals.tenant_id =
 * <active tenant>` for a super-admin too. It remains the project read lane's
 * identity gate (tag == active, fr row 14b).
 *
 * Under a header override a super-admin is scoped to the switched tenant like
 * everyone else (matches the board gate + `isSuperAdminSwitchedView`).
 */
export function isSuperAdminHomeView(
  user: { roles?: readonly string[]; tenantId: string },
): boolean {
  const ctx = tryGetRequestContext();
  const headerOverride =
    ctx?.activeTenantSource === 'header' &&
    !!ctx.tenantId &&
    ctx.tenantId !== user.tenantId;
  return isSuperAdmin(user) && !headerOverride;
}

/**
 * True when the caller's SIGNED realm claim carries the `aa-orchestrator` role
 * (env-overridable name, same as request-context.ts). This is the machine
 * identity of the AA system seat — the JWT twin of the shared n8n webhook
 * secret — used by the system-driver lanes (`PATCH /api/projects/:id/phase`,
 * card-phase-lease). It answers "is this the system seat", never
 * "may it reach this project": every caller still scopes the project to the
 * active tenant itself. ⛔ fr#1437/fr#1527: the seat's X-Tenant-Id cross-tenant
 * override is GONE (request-context.ts refuses it 403
 * `orchestrator_tenant_override_removed`), so the seat only ever acts in its
 * own JWT tenant and there is no orchestrator cross-tenant view any more.
 */
export function holdsOrchestratorRole(user: { roles?: readonly string[] }): boolean {
  const role = process.env.AA_ORCHESTRATOR_ROLE || 'aa-orchestrator';
  return user.roles?.includes(role) ?? false;
}

/**
 * G4 (George 2026-10-10): the conveyor-pull seat on the routes whose shared-secret
 * door was removed (card-phase-lease). Either the AA system seat
 * (`aa-orchestrator`) or a LICENCE caller — a customer's own n8n, which IS that
 * tenant's conveyor. Both are still tenant-pinned by each route's own check; a
 * licence caller's tenant is pinned by lib/licence-introspect.ts and it carries
 * no realm role, so this never widens who holds `aa-orchestrator`.
 */
export function holdsConveyorSeat(user: { roles?: readonly string[]; authKind?: User['authKind'] }): boolean {
  return holdsOrchestratorRole(user) || user.authKind === 'licence';
}

export function tenantScopedProjectFilter(
  userId: string,
  activeTenantId: string,
  homeTenantId: string,
  opts?: { includeAllOwners?: boolean; crossTenantReadOnly?: boolean; licenceTenantId?: string },
) {
  // ⭐ LICENCE LANE (G3) — see `licenceProjectScope`. Evaluated FIRST so no
  // other relaxation can combine with it. The predicate is the project's own
  // tenant tag ONLY: ⛔ no owner filter (the point), ⛔ no `isNull(dept_id)`
  // legacy fallback and no `departments.workspace_id` lane (dept_id is NULL on
  // every production row, so either would be "every project"), and a NULL /
  // blank tag never matches (`projectTaggedForTenant` fails closed). If the
  // active tenant a caller passes is not the licence's own tenant, nothing
  // matches — a licence can never be pointed at another workspace.
  if (opts && 'licenceTenantId' in opts) {
    const licenceTenant = opts.licenceTenantId;
    if (
      typeof licenceTenant !== 'string' ||
      !licenceTenant.trim() ||
      licenceTenant.toLowerCase() !== String(activeTenantId ?? '').toLowerCase()
    ) {
      return sql`false`;
    }
    return projectTaggedForTenant(activeTenantId);
  }
  // ⭐ SUPER-ADMIN HOME VIEW — the FIND half of the find-vs-decide asymmetry,
  // one surface over from the one approvals.ts already closed.
  //
  // ⚠️ HISTORICAL (fr row 14d removed it): `isSuperAdminHomeView` used to drop
  // `approvals.tenant_id` for the approvals LIST/GET/PUT lanes and the cockpit, so an un-switched super-admin is shown — and
  // may decide — every tenant's approvals. The PROJECT gate never adopted the
  // same relaxation: in home view `activeTenantId === homeTenantId`, so the
  // branch below pins BOTH `owner_id = user.id` and the project's own tenant
  // tag. Measured on this SHA: a super-admin lists a cross-tenant project's 31
  // pending approvals while `GET /api/projects/:id` 404s that same project, and
  // the cockpit's "NEEDS YOU" widget — which calls
  // `GET /api/projects/:projectId/approvals` — therefore renders zero rows.
  //
  // ⛔ THE FLAG IS NOT DECIDED HERE. This function takes no `user` and reads no
  // frame; every caller derives the flag from `isSuperAdminHomeView`, which is
  // the ONLY super-admin decision point in this file and is itself backed by
  // `lib/super-admin-gate.ts` (`super_admin` realm role off the signed
  // `realm_access.roles` claim, fail-closed on an absent/undefined roles list).
  // A subject with a minimal `{id, tenantId}` shape carries no roles and can
  // therefore never set this.
  //
  // ⛔ READ LANES ONLY, and the name says so. Exactly TWO places set it:
  // `resolveProject({ crossTenantRead: true })` — reachable only via
  // `findProjectForRead` / `loadProjectForRead` — and `handleGetProject`, which
  // has its own inline query. It is NOT set by the shared
  // `findTenantScopedProject` / `loadTenantScopedProject` seam, so every
  // mutating sub-resource (patch-project, github-token, provision,
  // attach/detach/promote repository, create/delete comment, upload document,
  // create approval, asset-scope `canMutateProject`) is untouched — MEASURED,
  // not assumed: the emitted SQL of the mutating lane was rendered against
  // origin/main for all four subject classes (super-admin home, super-admin
  // switched, ordinary cross-tenant, ordinary own-tenant) and is identical in
  // all four. `handleDeleteProject`, the metrics aggregate, the comment-delete
  // owner subquery, the approvals list lane and `routes/cards/project.ts` do
  // not set it either.
  //
  // ⚠️ CORRECTED 2026-09-24 — `handleListProjects` DID belong on that list and
  // has been moved off it. It is a READ lane, so the gap was not "deliberate
  // caution", it was the live defect: a home-view super-admin got the
  // owner-scoped fallback below (`owner_id = user.id`) from `GET /api/projects`
  // while `GET /api/projects/:id` already handed the SAME identity any project
  // by id via `crossTenantReadOnly`. `relationDirectory.ts`'s project picker
  // and `AssetDetail.svelte`'s relation-label resolver both read `GET
  // /api/projects` as their only directory, so the mismatch surfaced as an
  // empty picker AND a bare-uuid detail render from one query, not two.
  //
  // ⛔ fr row 14b (owner ruling "the system never reads customer data"): this
  // lane USED to be `sql\`true\`` — any project in the estate, by id or by
  // list, for an un-switched super-admin. It is now bounded by the project's
  // OWN tenant tag: the home view of a super-admin shows the projects of that
  // home workspace (every owner — that is still the relaxation), and nothing
  // tagged for any other tenant. Reaching another workspace's projects is the
  // SWITCHED view below (X-Active-Tenant), whose predicate is already tag-based.
  if (opts?.crossTenantReadOnly) {
    return projectTaggedForTenant(activeTenantId);
  }
  const isHomeTenant = activeTenantId === homeTenantId;
  // Super-admin viewing a SWITCHED tenant: every project in that workspace,
  // matched by the real tenant tag (kc tenant) — the dept→workspace join would
  // match nothing since dept_id is NULL in practice. No owner filter. Purely
  // additive: the home/default path below is byte-identical to before, so
  // regular users and the owner's home view are unaffected.
  if (opts?.includeAllOwners && !isHomeTenant) {
    return or(
      eq(PROJECT_KC_TENANT, activeTenantId),
      eq(departments.workspace_id, activeTenantId),
    );
  }
  // ⭐ P1-TEAM-a (George 2026-10-15): THE TENANT-MEMBER LANE. "All members of a
  // tenant [get] access to all projects of the tenant … all actions are able to
  // be done by all members of the tenant." The `owner_id = user` pin that stood
  // here is GONE: any member whose active tenant is T reaches every project
  // tagged for T, whoever created it.
  //
  // ⛔ What did NOT move: the project's own tag must still equal the ACTIVE
  // tenant (fr row 14b — a NULL/blank tag fails closed, so no project is ever
  // reached from another workspace), and the dept conditions are unchanged.
  // The one narrowing hook George asked for (the later "selection function") is
  // `tenantMemberProjectScope` — see there.
  //
  // ⛔ MEMBERSHIP IS OF THE CALLER'S OWN TENANT. An active tenant that is NOT the
  // caller's home is reached only through a lane that says so: the licence lane
  // above, or the super-admin switched view (`includeAllOwners`). Here — no such
  // lane — the caller is not a member of the active tenant, so nothing matches.
  // (Before P1-TEAM-a this branch was `owner AND tag AND dept.workspace = active`;
  // with the owner pin gone, keeping the dept lane would hand ANY caller carrying
  // a foreign frame that workspace's dept-linked projects. Fail closed instead.)
  if (!isHomeTenant) return sql`false`;
  return and(
    tenantMemberProjectScope(userId, activeTenantId),
    or(eq(departments.workspace_id, activeTenantId), isNull(projects.dept_id)),
  );
}

/**
 * ⭐ THE SELECTION-FUNCTION HOOK (P1-TEAM, George 2026-10-15: "later we can put a
 * selection function to reduce this list"). THE ONE place a member's
 * tenant-wide project set will be narrowed. It is AND-ed into the tenant-member
 * lane of `tenantScopedProjectFilter` — which is the project list, the read gate
 * and the write gate alike — and into every tenant-member loader outside it, so
 * narrowing here narrows every surface at once.
 *
 * ⛔ A NO-OP TODAY, deliberately: it returns `undefined`, which drizzle's `and()`
 * drops. Do not build the selection here without a ruling; do not add a second
 * hook elsewhere.
 */
export function projectSelectionForMember(
  _userId: string,
  _tenantId: string | null | undefined,
): SQL | undefined {
  return undefined;
}

/**
 * ⭐ THE TENANT-MEMBER PROJECT PREDICATE (P1-TEAM-a). `tag = tenantId` AND the
 * selection hook. Replaces the owner-only `ownedProjectInTenant` everywhere a
 * member's project is looked up outside the shared filter (agui `status.summary`,
 * `kanban.create_card`). Fails closed exactly like `projectTaggedForTenant`: a
 * missing tenant matches nothing.
 *
 * ⛔ `tenantId` must be the caller's RESOLVED tenant (the request frame's, else
 * the JWT's) — never a value a caller supplied.
 */
export function tenantMemberProjectScope(userId: string, tenantId: string | null | undefined) {
  return and(projectTaggedForTenant(tenantId), projectSelectionForMember(userId, tenantId))!;
}

/**
 * ⭐ EXPLICIT DESTRUCTIVE-ACTION GATE: who may ARCHIVE a project
 * (`DELETE /api/projects/:id`, `handleDeleteProject`). P1-TEAM-a: any member of
 * the project's tenant ("all actions … by all members"). Spelled as its own
 * predicate so the archive decision is a named choice, never an accidental
 * inheritance from a read lane.
 *
 * ⛔ NEVER A LICENCE CALLER. A licence (the tenant's conveyor seat) is not a
 * member and never archives; the route allowlist refuses it before the handler
 * (`lib/licence-route-allowlist.ts`), and this predicate refuses it AGAIN on its
 * own, so the gate does not depend on that list staying as it is.
 *
 * ⛔ NOT the read lane: no super-admin home-view relaxation (`crossTenantReadOnly`
 * is never set), no switched-view `includeAllOwners`. A member of ANOTHER tenant
 * matches nothing (the tag must equal the active tenant).
 */
export function projectArchivableByTenantMember(user: ScopeUser, activeTenantId: string) {
  if (user.authKind === 'licence') return sql`false`;
  return tenantScopedProjectFilter(user.id, activeTenantId, memberHomeFor(user, activeTenantId));
}

/**
 * The "home" a member-lane predicate is evaluated against. A super-admin
 * SWITCHED into `activeTenantId` (George 2026-10-27, lib/super-admin-switch.ts)
 * acts there as a tenant-admin, i.e. AS a member of it, so the member lane is
 * evaluated with the active tenant as home (tag = active tenant, exactly the
 * member predicate). Everyone else: their own JWT tenant, unchanged.
 */
function memberHomeFor(user: ScopeUser, activeTenantId: string): string {
  return isSuperAdminSwitchedInto(user, activeTenantId) ? activeTenantId : user.tenantId;
}

/**
 * ⭐ EXPLICIT DESTRUCTIVE-ACTION GATE: on whose projects may a caller delete
 * ANOTHER person's comment (`DELETE /api/comments/:id`). P1-TEAM-a: any member of
 * the project's tenant (the author may always delete their own). Same predicate
 * as the archive gate, named separately so either can be narrowed alone.
 *
 * ⛔ NEVER A LICENCE CALLER — refused here explicitly, not only by the route
 * allowlist (same reasoning as `projectArchivableByTenantMember`).
 * ⛔ NOT the read lane; a member of another tenant matches nothing.
 */
export function projectCommentsDeletableByTenantMember(user: ScopeUser, activeTenantId: string) {
  if (user.authKind === 'licence') return sql`false`;
  return tenantScopedProjectFilter(user.id, activeTenantId, memberHomeFor(user, activeTenantId));
}

/**
 * ⭐ THE VISIBILITY RULE OF `GET /api/projects/:id`, as a predicate — the ONE
 * definition. `selectProjectVisibleToGetProject` (routes/projects.ts) builds its
 * WHERE from this, and so does every surface that hands a caller a project id
 * to navigate to (fr-agui SPEC §7.5: the kanban board list's `frProjectId`, the
 * card's `fr_project_id`, an agent thread's `projectId`). Those ids drive a
 * redirect INTO `/projects/P/…`; an id the caller cannot GET lands them on a
 * 404 project shell, and the board page used to read that 404 as "not linked to
 * a board — re-create the project". So they are emitted only when this
 * predicate admits the row — never under a parallel rule.
 *
 * ⛔ READ-ONLY: it sets `crossTenantReadOnly` for a super-admin in home view,
 * exactly as the GET does. Never gate a mutation on it.
 *
 * Callers must `leftJoin(departments, eq(projects.dept_id, departments.id))`.
 * `activeTenantId` defaults to the request frame's tenant (what the GET uses);
 * a caller with no Keycloak frame (the fr-agent token lane) passes its own.
 */
export function projectReadableAsGetProjectFilter(
  user: ScopeUser,
  activeTenantId: string = ctxTenantId(user.tenantId),
) {
  return tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
    // Super-admin switched view (X-Active-Tenant): every owner in that tenant.
    includeAllOwners: isSuperAdminSwitchedView(user, activeTenantId),
    ...licenceProjectScope(user),
    // Super-admin HOME view: the read-only, tag-bounded relaxation (fr row 14b).
    crossTenantReadOnly: isSuperAdminHomeView(user),
  });
}

/**
 * The subset of `projectIds` this caller can `GET /api/projects/:id`, under
 * `projectReadableAsGetProjectFilter` (the same predicate, not a copy). Non-uuid
 * and blank ids are dropped before the query (a uuid column 22P02s on them). A
 * missing tenant fails closed to the empty set.
 */
export async function projectIdsReadableAsGetProject(
  user: ScopeUser,
  projectIds: readonly (string | null | undefined)[],
  opts: { activeTenantId?: string | null } = {},
): Promise<Set<string>> {
  const ids = [...new Set(projectIds.filter((id): id is string => typeof id === 'string' && isUuidShape(id)))];
  if (ids.length === 0) return new Set();
  const activeTenantId =
    'activeTenantId' in opts ? opts.activeTenantId : ctxTenantId(user.tenantId);
  if (typeof activeTenantId !== 'string' || !activeTenantId.trim()) return new Set();
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(and(inArray(projects.id, ids), projectReadableAsGetProjectFilter(user, activeTenantId)));
  return new Set(rows.map((r) => r.id));
}

/**
 * SQL predicate: the project's own tenant tag (`project_data.keycloak_tenant_id`)
 * equals `tenantId`. fr row 14b — the ONE tag predicate every owner-based
 * loader shares (the home branch + super-admin home lane of
 * `tenantScopedProjectFilter`, and the loaders that sit outside it:
 * admin/assets/projects.ts, agui-threads.ts, agui status/kanban-card actions).
 *
 * FAIL CLOSED: a NULL tag compares NULL (never true), a blank tag can never
 * equal a real tenant id, and a missing/blank `tenantId` is `false` outright —
 * an unknown active tenant must not match the blank-tag rows.
 */
export function projectTaggedForTenant(tenantId: string | null | undefined) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) return sql`false`;
  return eq(PROJECT_KC_TENANT, tenantId);
}

/**
 * The self-protecting WHERE (#402) of a project UPDATE behind
 * `loadTenantScopedProject`: `id AND tag = tenant` — the project's own tenant
 * tag, no owner pin, for a member acting in its OWN tenant. A licence caller is
 * pinned to its licence tenant (G3). A JWT caller whose active tenant is not its
 * own (a super-admin switched view) keeps the pre-P1-TEAM owner pin.
 *
 * P1-TEAM-a (George 2026-10-15): this was `id AND owner_id = user` for JWT
 * callers. Any tenant member may now act on any project of the tenant, so an
 * owner pin here would silently 404 every write the gate just admitted for a
 * non-owner member.
 */
export function projectWriteSelfScope(
  user: { id: string; tenantId: string; roles?: readonly string[]; authKind?: User['authKind'] },
  projectId: string,
) {
  if (user.authKind === 'licence') {
    return and(eq(projects.id, projectId), projectTaggedForTenant(user.tenantId))!;
  }
  const activeTenantId = ctxTenantId(user.tenantId);
  // ⛔ A caller acting OUTSIDE its own tenant (a super-admin switched view) is
  // not a member there: its write scope stays exactly what it was before
  // P1-TEAM-a — its OWN rows only, tagged for the active tenant. The widening is
  // for members of their own tenant.
  if (callerActsOutsideOwnTenant(user)) {
    return and(eq(projects.id, projectId), eq(projects.owner_id, user.id), projectTaggedForTenant(activeTenantId))!;
  }
  return and(eq(projects.id, projectId), projectTaggedForTenant(activeTenantId))!;
}

/**
 * True when a NON-licence caller's active tenant (the request frame's — a
 * super-admin's accepted `X-Active-Tenant`) is not its own JWT tenant: it acts
 * OUTSIDE its own tenant, where it is not a member. A licence caller is pinned
 * to its licence tenant, so it never is.
 */
export function callerActsOutsideOwnTenant(user: {
  id?: string;
  tenantId: string;
  roles?: readonly string[];
  authKind?: User['authKind'];
}): boolean {
  if (user.authKind === 'licence') return false;
  const active = ctxTenantId(user.tenantId);
  if (active === user.tenantId) return false;
  // ⭐ George 2026-10-27: a super-admin SWITCHED into the active tenant acts
  // there as a tenant-admin (lib/super-admin-switch.ts), so it is NOT outside:
  // no owner pin, the member rules apply. Any other foreign frame still is.
  return !isSuperAdminSwitchedInto(user, active);
}

/**
 * ⭐ THE SWITCHED-VIEW OWNER PIN (P1-TEAM-a), for the writes that CALL this on
 * the row `findTenantScopedProject` / `loadTenantScopedProject` returned. A
 * member acting in its OWN tenant may write any project the seam returned (the
 * ruling). A caller acting OUTSIDE its own tenant — a super-admin switched view,
 * whose seam lane (`includeAllOwners`) returns every project of the switched
 * tenant — is held to its own rows. The same rule as `projectWriteSelfScope`
 * (PATCH /api/projects/:id) and as the membership provider's switched-view
 * `viewer` role (agent project-member writes), so those cannot drift.
 *
 * ⚠️ NOT EVERY switched-view write. Callers today: `routes/cards/priority.ts`
 * and `routes/asset-scope/can-mutate-project.ts`. The other writes that resolve
 * their project through `loadTenantScopedProject` and do NOT call this —
 * `documents.ts`, `comments.ts`, `project-repositories.ts`, `approvals.ts`
 * create, `assets/kag.ts`, the `services/project-quality.ts` analyze — keep
 * the PRE-EXISTING switched-view semantics: `includeAllOwners` admits every
 * project tagged for the switched tenant, owner or not (unchanged by P1-TEAM-a).
 */
export function projectWritableByCaller(
  user: { id: string; tenantId: string; roles?: readonly string[]; authKind?: User['authKind'] },
  project: { owner_id: string | null },
): boolean {
  return !callerActsOutsideOwnTenant(user) || project.owner_id === user.id;
}

/**
 * The shared resolver body. NOT exported — the two public entry points below
 * differ in exactly one thing, and that thing is a boundary, so it is spelled
 * at the entry point rather than inferred here.
 *
 * ⛔ `crossTenantRead` MUST be false for every mutating caller. See
 * `findProjectForRead` for the whole argument; the short version is that a
 * read fix must not arrive carrying a write widening.
 */
async function resolveProject(
  db: DbHandle,
  user: ScopeUser,
  projectId: string,
  opts: { crossTenantRead: boolean },
) {
  // Shape-check BEFORE the query, at the single seam BOTH resolvers funnel
  // through. `projects.id` is a `uuid` column (schema.ts:72), so a non-UUID
  // never reached a row — it reached Postgres, which raised 22P02 `invalid
  // input syntax for type uuid` and escaped as a bare 500. Measured in
  // production: the project cockpit and `/approvals` both 500'd on
  // `stream:9b9fc446-…`, an id fr's OWN `GET /api/projects` hands out for the
  // synthetic continuous-stream cards (routes/projects.ts:1338).
  //
  // `undefined` is the honest answer and needs no special case downstream:
  // "the active tenant cannot reach it" is exactly true of an id that can
  // never name a row, so `loadTenantScopedProject` throws this file's existing
  // don't-leak-existence `NotFoundError` unchanged, and the OR-authorization
  // callers of the non-throwing variant fall through to their other lane
  // instead of exploding. Deciding it here rather than in each caller is the
  // whole lesson of `lib/uuid-shape.ts`: the guard existed on 2026-09-01, it
  // just was not applied at every seam, so this one inherited the defect.
  //
  // `isUuidShape`, deliberately NOT `isValidUuid` (utils/tenant): that one also
  // pins the version nibble to 1-8 and the variant to [89ab], so it rejects
  // strings Postgres accepts as legal `uuid` literals — which would 404 a row
  // that genuinely exists. Censused production 2026-09-04 before choosing:
  // 0 of 246 projects, 0 of 2663 approvals and 0 of 18 streams carry such an
  // id, so that risk is latent rather than live — but shape-only is all the
  // column needs.
  if (!isUuidShape(projectId)) return undefined;

  const activeTenantId = ctxTenantId(user.tenantId);
  const includeAllOwners = isSuperAdminSwitchedView(user, activeTenantId);
  // ⭐ TWO independent conditions, AND-ed, and BOTH are load-bearing.
  // `crossTenantRead` is the caller's declaration that this lane cannot mutate;
  // `isSuperAdminHomeView` is the identity gate. Neither alone may set this:
  // the caller cannot grant itself the identity, and the identity cannot grant
  // itself a write lane. When `crossTenantRead` is false — every mutating
  // caller, i.e. everything reached through `findTenantScopedProject` /
  // `loadTenantScopedProject` — this is false for EVERY subject, the early
  // return in `tenantScopedProjectFilter` is not taken, and the emitted SQL is
  // the pre-change predicate.
  const crossTenantReadOnly = opts.crossTenantRead && isSuperAdminHomeView(user);
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        eq(projects.id, projectId),
        tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
          includeAllOwners,
          crossTenantReadOnly,
          ...licenceProjectScope(user),
        }),
      ),
    );
  const project = rows[0]?.project;
  // Publish a GUARD-VALIDATED project id onto ALS so any billing-relevant
  // outbound call later in this request (X-Project-Id via http-client.ts,
  // the metering span's project_id via services/metering-emit.ts) can
  // attribute to it. This is the SINGLE seam BOTH `findTenantScopedProject`
  // and `findProjectForRead` funnel through, so wiring the guard here —
  // rather than at each sub-resource call site — is what makes it "ONE
  // shared guard" in practice, not just in name. See
  // lib/project-owner-guard.ts for why the SQL-level scope above
  // (owner_id / dept workspace / KC tag for the switched-view branch) is not
  // itself a substitute: the home-tenant branch trusts `owner_id` without
  // ever reading the KC tag, so a legacy or mis-tagged row can reach here
  // despite disagreeing with the caller's actual active tenant.
  //
  // ⭐ `crossTenantReadOnly` is threaded in as the guard's THIRD argument
  // (fr#1214). It does NOT change the guard's verdict — it labels the count
  // `lane="cross_tenant_read"` vs `lane="own_tenant"`. Without it the counter
  // cannot tell the deliberate super-admin home-view read lane introduced by
  // fr#1193 (where `foreign` is expected, because
  // `tenantScopedProjectFilter` returned `sql`true`` above and ANY project by
  // id resolves) from a genuinely mis-tagged row or a wrong-tenant caller —
  // which is the case `FrProjectOwnerGuardForeign` exists for, and is why that
  // alert fired on correct behaviour at 07:57Z on 2026-09-25.
  if (project) {
    const { projectId, allowed } = guardProjectId(project, activeTenantId, crossTenantReadOnly);
    // ⛔ fr row 14b: the guard now DENIES, it does not only label. A `foreign`
    // or `untagged` row is answered exactly like a filter miss — `undefined`,
    // which `loadTenantScopedProject` / `loadProjectForRead` turn into this
    // file's don't-leak-existence 404. The SQL predicate above already
    // excludes both classes for every non-switched lane; this is the second,
    // independent barrier (and the one that covers the switched view's
    // `departments.workspace_id` lane, which is not tag-based).
    if (!allowed) return undefined;
    setProjectId(projectId);
  }
  return project;
}

/**
 * Non-throwing tenant-scoped project resolver. Returns the full `projects`
 * row (byte-identical shape to `db.select().from(projects)`) when the active
 * tenant can reach it, else `undefined`. Use for OR-authorization paths
 * (e.g. comment delete: author OR tenant-scoped project owner).
 *
 * ⛔ THE DEFAULT, AND THE ONE EVERY MUTATING CALLER USES. Its behaviour is
 * unchanged for all four subject classes (super-admin home, super-admin
 * switched, ordinary cross-tenant, ordinary own-tenant): `crossTenantRead` is
 * hard-coded false, so `crossTenantReadOnly` is false regardless of identity.
 */
export async function findTenantScopedProject(
  db: DbHandle,
  user: ScopeUser,
  projectId: string,
) {
  return resolveProject(db, user, projectId, { crossTenantRead: false });
}

/**
 * ⭐ READ-ONLY lane: same resolver, plus the super-admin home-view cross-tenant
 * relaxation. `findTenantScopedProject` above is the default and stays narrow.
 *
 * WHY THIS IS A SEPARATE FUNCTION RATHER THAN A FLAG INSIDE THE SEAM. The
 * defect it fixes is entirely about READING work that is already visible: an
 * un-switched super-admin is shown — and may already DECIDE — every tenant's
 * approvals (HISTORICAL — until fr row 14d `isSuperAdminHomeView` dropped
 * `approvals.tenant_id` in `handleListAllApprovals`, `loadReachableApproval`,
 * `handleUpdateApproval` and the project cockpit; every lane is now tenant-pinned),
 * yet `GET /api/projects/:id` 404s the project those rows hang off, so the
 * cockpit is unreachable and the "NEEDS YOU" widget renders zero rows.
 *
 * ⛔ Putting the relaxation in the shared seam ALSO grants that seat
 * cross-tenant WRITE on patch-project, github-token, provision, attach/detach/
 * promote repository, create/delete comment, upload document, create approval
 * and `asset-scope/override.ts canMutateProject` — none of which the defect
 * requires. "A super-admin can already do X elsewhere" argues for consistency,
 * not for widening a boundary as the side effect of a read fix. If cross-tenant
 * write in home view is wanted it gets its own change and its own reasoning.
 *
 * ⚠️ CALL THIS ONLY FROM A HANDLER THAT CANNOT MUTATE. The current callers are
 * enumerated and tested — all GET, none of them writes:
 *   `handleGetProject`, `handleListApprovals` (GET /api/projects/:id/approvals
 *   — what NeedsYouQueue fires), `handleGetProjectCockpit` (the cockpit page's
 *   ONLY endpoint), `handleGetProjectMetrics`, `handleProjectActivity`,
 *   `handleGetProjectStatus`, `handleGetProjectPhase`, `handleListComments`,
 *   `handleListProjectDocuments`, `handleListProjectRepositories`,
 *   `handleGetProjectKanban`.
 * The last six were added after the first cut: a project page that finally
 * opens for a super-admin whose every sub-tab then 404s is half a fix. They
 * take the identical two-condition guard; the WRITE boundary did not move.
 */
export async function findProjectForRead(
  db: DbHandle,
  user: ScopeUser,
  projectId: string,
) {
  return resolveProject(db, user, projectId, { crossTenantRead: true });
}

/**
 * ⭐ THE TENANT-ADMIN ADMINISTRATION LANE. A THIRD lane, deliberately separate
 * from the two above, and narrower than either.
 *
 * ── THE PROBLEM IT SOLVES ───────────────────────────────────────────────────
 * (⚠️ HISTORICAL since P1-TEAM-a, George 2026-10-15: the member lane no longer
 * pins `owner_id`, so any member — admin or not — reaches every project of their
 * tenant through `findTenantScopedProject`. This lane is kept for its callers.)
 * `findTenantScopedProject` pinned `owner_id = user.id` in the home-tenant branch
 * (see `tenantScopedProjectFilter`), so a workspace ADMIN who did not personally
 * own a project could not reach it at all — and `findProjectForRead`'s relaxation is
 * gated on `super_admin`, a different axis entirely (see
 * services/user-roles.ts's ⛔ note on why `super_admin` is not a stronger
 * workspace role). Neither lane can express "an admin of this workspace may
 * administer this workspace's projects", which is exactly what maintaining a
 * project's knowledge-area allocation after the project has started requires.
 *
 * ── THE TWO CONDITIONS, AND WHY BOTH ARE LOAD-BEARING ───────────────────────
 * 1. The CALLER must already have been proven a workspace-admin OF `tenantId` —
 *    by `requireWorkspaceAdmin` (routes/workspace/members.ts), which is the only
 *    sanctioned caller. This function does NOT check that and must never be
 *    called without it; the parameter is named `adminTenantId` to make a call
 *    site that passes something else read as wrong.
 * 2. The PROJECT's own tenant tag must equal that same tenant.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * ⛔ NO owner filter — that is the entire point, and it is bounded by (2).
 * ⛔ NO `isNull(projects.dept_id)` legacy fallback, and NO
 *    `departments.workspace_id` lane. The dept join is unpopulated in production
 *    (⚠️ RE-MEASURED 2026-09-27 on the prod primary: 0 of 133 rows have a
 *    non-null `dept_id`, so this is still true), so including the legacy branch
 *    would mean "any project with a NULL dept_id is in your tenant" — i.e. every
 *    project in the estate.
 *
 *    ⚠️ CORRECTED 2026-09-27 — this said `lib/project-owner-guard.ts` "measured
 *    `keycloak_tenant_id` tag coverage at ~93%, so roughly 7% of projects are
 *    UNTAGGED". That guard's figure dates from 2026-09-16 and is STALE BY ~9×,
 *    in the direction that overstates what this resolver refuses. MEASURED on the
 *    prod primary (worker4, direct, `BEGIN READ ONLY`, 2026-09-27): 133 projects,
 *    132 tagged, 1 untagged = **0.8% untagged / 99.2% coverage** (the 132 tagged
 *    reads are the non-zero control for the JSON expression). This resolver
 *    returns `undefined` for that one row: an administration write on a project
 *    whose tenant cannot be established REFUSES rather than guesses. That refusal
 *    is the correct outcome at 0.8% for the same reason it was at 7% — the
 *    population size is not the justification — and the caller reports it as a
 *    404, on the same don't-leak-existence contract as the rest of this file.
 * ⛔ It does not call `guardProjectId` / `setProjectId`. The predicate REQUIRES
 *    the tag to equal the active tenant, so the guard's "foreign row" verdict is
 *    unreachable by construction — the query cannot return one. There is no
 *    outbound billable call on this lane to attribute either.
 *
 * WRITE-CAPABLE, and named so. Do not widen it, and do not route the other two
 * resolvers through it.
 */
export async function findProjectForWorkspaceAdmin(
  db: DbHandle,
  adminTenantId: string,
  projectId: string,
) {
  // Same shape check, same reason, as `resolveProject`: `projects.id` is a uuid
  // column, so a non-uuid reaches postgres as 22P02 and escapes as a bare 500.
  if (!isUuidShape(projectId)) return undefined;
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(PROJECT_KC_TENANT, adminTenantId)));
  return rows[0]?.project;
}

/**
 * ⭐ THE CONVEYOR PRIORITY LANE. A FOURTH lane, narrower than every other.
 *
 * The dedicated conveyor priority identity (lib/conveyor-identity.ts
 * isConveyorActor) carries no tenant_id claim and owns no projects, so neither
 * owner-pinned lane can ever reach a card for it. This resolves the project by
 * id WITHIN `platformTenantId` REGARDLESS OF OWNER.
 *
 * ⛔ The caller MUST already have proven BOTH: isConveyorActor(user) AND
 *    isPlatformTenant(platformTenantId) (lib/priority-change.ts
 *    conveyorTenantFromHeader). This function checks neither.
 * ⛔ ONLY the two priority writes call it (routes/cards/priority.ts,
 *    routes/projects.ts handlePatchProject's conveyor branch). Nothing else.
 * Same predicate as `findProjectForWorkspaceAdmin`: the KC tenant tag only, no
 * dept lane, no legacy NULL-dept fallback (that would be every project).
 * ⛔ Returns ONLY a row whose tag is a non-blank string EQUAL to the platform
 *    tenant. An UNTAGGED row (tag absent / blank) cannot be proven to belong to
 *    that tenant, so for the conveyor it is indistinguishable from a
 *    nonexistent project: the SAME 404 as another tenant's row or a random id
 *    (strict tenant separation; no existence oracle). Do NOT widen this to
 *    return untagged rows so the conveyor can see 409 `project_tenant_unknown`
 *    — that 409 is for HUMAN owners only (fr#1418), who can already see the row.
 */
export async function loadProjectForConveyor(
  db: DbHandle,
  platformTenantId: string,
  projectId: string,
) {
  if (!isUuidShape(projectId)) throw new NotFoundError('Project not found');
  // A blank tenant can never be "proven"; refuse it the same way (404), so an
  // empty header can never match an empty tag.
  if (typeof platformTenantId !== 'string' || platformTenantId.trim() === '') {
    throw new NotFoundError('Project not found');
  }
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .where(conveyorProjectScope(platformTenantId, projectId));
  const project = rows[0]?.project;
  if (!project) throw new NotFoundError('Project not found');
  // fr#1499: every caller is a conveyor WRITE — an archived project is a 409,
  // never a silent success (AFTER the scoped lookup, so foreign ids still 404).
  assertProjectNotArchived(project);
  return project;
}

/** The conveyor's WRITE scope (UPDATE / FOR UPDATE WHERE): id + tag == its platform tenant. Never admits an untagged row. */
export function conveyorProjectScope(platformTenantId: string, projectId: string) {
  return and(eq(projects.id, projectId), eq(PROJECT_KC_TENANT, platformTenantId));
}

/** Throwing variant of `findProjectForRead`. Read-only callers only. */
export async function loadProjectForRead(
  db: DbHandle,
  user: ScopeUser,
  projectId: string,
) {
  const project = await findProjectForRead(db, user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  return project;
}

/**
 * Throwing variant: same 404-for-everything contract as handleGetProject —
 * never leak which ids exist across tenants/owners. Returns the full project
 * row so callers that read project fields afterward keep working.
 *
 * A non-UUID id lands here as a 404 too, via the shape check in
 * `findTenantScopedProject` — not as the 22P02-driven 500 that broke the
 * project cockpit and `/approvals` in production. Same answer for
 * "syntactically impossible", "another tenant's" and "genuinely missing", which
 * is the point of the contract.
 */
export async function loadTenantScopedProject(
  db: DbHandle,
  user: ScopeUser,
  projectId: string,
  opts: { allowArchived?: boolean } = {},
) {
  const project = await findTenantScopedProject(db, user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  // fr#1499: this is the MUTATING lane, so an archived project is a 409
  // `project_archived` by DEFAULT. A caller that only reads through this lane
  // (and must keep working on an archived project) opts in explicitly with
  // `allowArchived: true` — never the other way round.
  if (!opts.allowArchived) assertProjectNotArchived(project);
  return project;
}
