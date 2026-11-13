// routes/tenant/members.ts
//
// THE MEMBER DIRECTORY AN ORDINARY MEMBER CAN READ.
//
// ── WHY THIS ROUTE HAD TO EXIST ──────────────────────────────────────────────
//
// The project request form asks who signs the work off. `approvers` must be
// USER IDs to seed anything (routes/projects.ts:659-691 writes
// project_stakeholders role execution_signoff), but the form collected free
// text — so a typed human name was filtered out by `explicitSignoffIds`,
// logged to a console.warn nobody reads, and `resolveSignoffStakeholderIds`
// silently fell back to the PROJECT OWNER. The roster the user believed they
// set never existed.
//
// The fix is a picker, and a picker needs a directory. MEASURED 2026-09-21 —
// all three existing doors are shut to a plain member:
//
//   GET /api/workspace/members  requireWorkspaceAdmin          -> 403
//   GET /api/kanban/users       Planka 403 swallowed to {items: []} -> always empty (route removed 2026-10-10)
//   GET /api/admin/users        isSuperAdmin                   -> 403
//
// ⛔ DO NOT "just relax the guard" ON workspace/members.ts. That file's ENTIRE
// surface is admin-gated — list, grant and revoke share `requireWorkspaceAdmin`
// — and loosening the gate there to serve a read would put a grant and a
// revoke behind a member-level check. A separate read-only file cannot make
// that mistake.
//
// ── THE INVARIANT, INHERITED DELIBERATELY ───────────────────────────────────
//
// ⛔ The tenant comes from the REQUEST CONTEXT, never from a body or a param.
// `routes/workspace/members.ts:16-23` states why: a caller-supplied tenant is
// a cross-tenant privilege escalation, and `routes/admin/users.ts` may accept
// `tenant_id` from a body ONLY because it is super-admin gated. This route is
// the least privileged of the three, so it is the one that can least afford a
// tenant parameter. If you ever add one, you have reintroduced that hole.
//
// Verified in middleware/request-context.ts: `X-Active-Tenant` is honoured only
// for the `super_admin` REALM ROLE, and then only for the reserved internal
// tenants, the execution tenant, or the caller's own JWT tenant. Everyone else
// falls back silently to the JWT-derived tenant. So `ctxTenantId` cannot be
// steered by an ordinary member — which is exactly what makes a member-level
// guard safe here.
//
// ── WHAT IT DELIBERATELY DOES NOT RETURN ────────────────────────────────────
//
// ⚠️ NOT `AdminUser`. That shape carries `workspaces[]` — every workspace a
// person holds a role in — and returning it to a plain member would disclose
// which OTHER tenants a colleague belongs to. That is a cross-tenant
// information leak dressed as a convenience field. This route returns four
// fields and cannot leak by construction, rather than relying on the caller
// having been scoped correctly.
//
// It also returns no role, no granted_at and no granted_by: who granted whom
// what, and when, is an administrative fact, not a directory one.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { userRolesService, type RoleGrant } from '../../services/user-roles';
import { keycloak } from '../../services/keycloak';
import { emitSpan } from '../../telemetry/spans';
import { knowledgeAreasService } from '../../services/knowledge-areas';

/** Same chunking discipline as the two admin listings. */
const RESOLVE_CHUNK = 50;

/** One person, as a picker needs them. Nothing else. */
export interface TenantMember {
  id: string;
  /** Null when Keycloak could not resolve the id — see `resolved`. */
  email: string | null;
  name: string | null;
  /**
   * False when the directory lookup did not return this id. The row is STILL
   * listed. An unresolvable grant is a dangling one (deleted account, wrong
   * realm); hiding it would hide real access, and a picker that silently drops
   * a person is how an approver gets chosen that nobody can explain later.
   * The UI must render it as an id, not as a nameless person.
   */
  resolved: boolean;
  /**
   * The member's KNOWLEDGE AREAS in this tenant (migration 135) — sorted, and
   * `[]` when none are recorded. An area says who to ask about what
   * ("for api questions member A"); it is NOT a role, NOT a permission and NOT
   * a job title. Authority still lives in `user_roles` and is still deliberately
   * absent from this response — see the file header.
   *
   * ⚠️ `[]` IS THE NORMAL CASE TODAY, NOT AN ERROR. Coverage starts at ZERO:
   * `user_roles` holds 13 grants across 13 tenants (one user each) and
   * `member_knowledge_areas` is brand new, so on every tenant in the estate
   * EVERY item currently carries `[]`. A consumer that ranks members by area
   * must treat "no item has any area" as a refusal to answer, not as an empty
   * result — `hasAnyCoverage` in lib/knowledge-areas.ts is that question. A
   * ranking over a property nobody has filled in suggests nothing, silently, and
   * looks exactly like a working feature.
   */
  knowledge_areas: string[];
}

/**
 * ⚠️ `{ items }` AND NOTHING ELSE, deliberately.
 *
 * fr's response-envelope convention holds new routes to one of four
 * shapes (`data`, `items+total`, `items`, `array`) because a MEASURED sweep of
 * fr's 60 GET routes found ~21 one-off bare objects and two sibling routes of
 * the same resource disagreeing. An earlier draft of this file returned
 * `{ items, tenant_id, directory_error }` and the guard refused it — correctly.
 *
 * Nothing is lost by complying. `tenant_id` tells the caller what they already
 * told us. And a directory outage is already visible: every entry comes back
 * `resolved: false`, so the UI renders ids either way. A total outage and a
 * tenant full of dangling grants are indistinguishable in this response — which
 * is honest, because they are also indistinguishable in what the user can DO
 * about them: pick from the ids, or go and fix the directory.
 */
export interface TenantMembersResponse {
  items: TenantMember[];
}

/**
 * Fold grant rows into one entry per person.
 *
 * Pure, so the de-duplication and the dangling-grant contract are testable
 * without a database or a Keycloak.
 *
 * ⚠️ De-duplication is load-bearing, not tidiness: `user_roles` is unique on
 * (user_id, tenant_id, ROLE), so one person holding two roles in the same
 * tenant is two rows. A picker listing them twice lets a user pick the same
 * approver twice and look at a roster that appears to need two sign-offs from
 * one human.
 */
export function toTenantMembers(
  grants: RoleGrant[],
  people: Record<string, { id: string; email: string | null; name: string }>,
  /**
   * user_id -> knowledge areas. OPTIONAL, defaulting to an empty map, so the two
   * pre-existing callers and their tests keep their exact behaviour.
   *
   * ⚠️ A member with no areas is ABSENT from this map, not present with `[]` —
   * `member_knowledge_areas` has no row to return for them. Hence the `?? []`
   * below. Do not "tidy" that into `areas.get(id)!`.
   */
  areas: ReadonlyMap<string, string[]> = new Map(),
): TenantMember[] {
  const seen = new Map<string, TenantMember>();
  for (const g of grants) {
    if (seen.has(g.user_id)) continue;
    const p = people[g.user_id];
    seen.set(g.user_id, {
      id: g.user_id,
      email: p?.email ?? null,
      name: p?.name ?? null,
      resolved: Boolean(p),
      knowledge_areas: areas.get(g.user_id) ?? [],
    });
  }
  // Stable order, so the picker does not reshuffle between reads.
  //
  // ⚠️ UNRESOLVED ENTRIES SORT LAST, not alphabetically among the names. Sorting
  // a raw uuid by locale collation drops it into the middle of the colleague
  // list ('Ada', '9f3c…', 'Zoe'), where it reads as a choice rather than as the
  // anomaly it is. A dangling grant must stay visible — hiding it would hide
  // real access — but it must not look like a person you meant to pick.
  return [...seen.values()].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
    return (a.name ?? a.email ?? a.id).localeCompare(b.name ?? b.email ?? b.id);
  });
}

/**
 * ⭐ EXPORTED so the project-allocation route reuses it instead of becoming a
 * FOURTH copy of this loop (the others are in routes/workspace/members.ts and
 * routes/admin/users.ts, both with the identical RESOLVE_CHUNK discipline).
 * Pure I/O against Keycloak, no authz decision of its own.
 */
export async function resolveTenantDirectory(
  ids: string[],
): Promise<Record<string, { id: string; email: string | null; name: string }>> {
  const out: Record<string, { id: string; email: string | null; name: string }> = {};
  for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
    Object.assign(
      out,
      await keycloak.resolveUsers(ids.slice(i, i + RESOLVE_CHUNK), RESOLVE_CHUNK),
    );
  }
  return out;
}

/**
 * GET /api/tenant/members
 *
 * Any authenticated member of the active tenant. No admin check — that is the
 * entire point of the route.
 */
export async function handleListTenantMembers(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const tenantId = ctxTenantId(user.tenantId);

  return emitSpan(
    'fr.tenant.members.list',
    { 'user.id': user.id, 'tenant.id': tenantId },
    async () => {
      const grants = await userRolesService.listGrantsForTenant(tenantId);
      const ids = [...new Set(grants.map((g) => g.user_id))];

      // A directory outage must not blank the picker. The grants ARE the
      // membership; names are decoration. Ids with `resolved:false` beat an
      // empty list — an empty picker reads as "you are alone in this tenant",
      // which is a false statement about access, and it is exactly what the
      // removed /api/kanban/users route did by swallowing a Planka 403 into
      // `{items: []}`.
      let people: Record<string, { id: string; email: string | null; name: string }> = {};
      try {
        people = await resolveTenantDirectory(ids);
      } catch (e) {
        // Logged, not returned — see the note on TenantMembersResponse. The
        // per-entry `resolved` flag is what the UI acts on.
        console.warn(
          `[tenant/members] identity resolution failed for tenant ${tenantId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      // Knowledge areas (migration 135). Fetched separately and folded in, on
      // the SAME degrade-don't-blank contract as the identity lookup above: an
      // areas read that throws must not empty the picker, because the GRANTS are
      // the membership and the areas are an annotation on it. A tenant full of
      // members with no areas and a failed areas query are indistinguishable in
      // this response — which is honest, because the table is EMPTY on every
      // tenant today (measured 2026-09-27), so the caller must handle the
      // all-empty case correctly either way.
      let areas: ReadonlyMap<string, string[]> = new Map();
      try {
        areas = await knowledgeAreasService.listAreasForTenant(tenantId);
      } catch (e) {
        console.warn(
          `[tenant/members] knowledge-area read failed for tenant ${tenantId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      return jsonResponse({ items: toTenantMembers(grants, people, areas) });
    },
  );
}
