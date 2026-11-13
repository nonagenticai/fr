// GET /api/admin/users — who has access to fr, and where.
//
// fr had no way to answer this. Keycloak's user search needs >=2 characters
// and cannot enumerate, so the only route to a person was a typeahead inside
// the licence-grants form: you could look someone up if you already knew their
// name, and could not ask "who are the admins?" at all. Eleven people hold
// `workspace-admin` in production and nothing listed them.
//
// `user_roles` is the authority here, not the directory. It is the table the
// backend actually gates on (`assets/_lib/gate.ts` -> `hasRole(user, tenant,
// 'workspace-admin')`), so a person with a Keycloak account and no row has no
// fr access, and a row whose Keycloak account is gone is a dangling grant
// worth seeing. Both are reported rather than hidden.

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { userRolesService, type RoleGrant } from '../../services/user-roles';
import { keycloak } from '../../services/keycloak';
import { emitSpan } from '../../telemetry/spans';

/** A workspace a person holds a role in. */
export interface AdminUserWorkspace {
  tenant_id: string;
  tenant_name: string | null;
  role: string;
  granted_at: string;
  granted_by: string | null;
}

export interface AdminUser {
  user_id: string;
  /** Null when Keycloak could not resolve the id — see `resolved`. */
  email: string | null;
  name: string | null;
  /**
   * False when the directory lookup did not return this id. The row is still
   * listed: an unresolvable grant is a DANGLING one (deleted account, wrong
   * realm) and hiding it would hide real access. The UI must not render it as
   * a nameless person, and must not silently drop it either.
   */
  resolved: boolean;
  workspaces: AdminUserWorkspace[];
}

/**
 * Fold grant rows into one entry per person.
 *
 * Pure, so the grouping and the dangling-grant contract are tested without a
 * database or a Keycloak. Workspaces are sorted by name so the list is stable
 * between reads; people are sorted by the best label they have.
 */
export function groupGrantsByUser(
  grants: RoleGrant[],
  people: Record<string, { id: string; email: string | null; name: string }>,
): AdminUser[] {
  const byUser = new Map<string, AdminUserWorkspace[]>();
  for (const g of grants) {
    const list = byUser.get(g.user_id) ?? [];
    list.push({
      tenant_id: g.tenant_id,
      tenant_name: g.tenant_name,
      role: g.role,
      granted_at: g.granted_at,
      granted_by: g.granted_by,
    });
    byUser.set(g.user_id, list);
  }

  const out: AdminUser[] = [];
  for (const [user_id, workspaces] of byUser) {
    const person = people[user_id];
    out.push({
      user_id,
      email: person?.email ?? null,
      name: person?.name ?? null,
      resolved: person !== undefined,
      workspaces: workspaces.sort(
        (a, b) =>
          (a.tenant_name ?? a.tenant_id).localeCompare(b.tenant_name ?? b.tenant_id) ||
          a.role.localeCompare(b.role),
      ),
    });
  }

  return out.sort((a, b) => {
    // Unresolved rows sort last: they are exceptions to chase, not people to
    // browse, and putting them first would bury the readable list.
    if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
    const al = a.email ?? a.name ?? a.user_id;
    const bl = b.email ?? b.name ?? b.user_id;
    return al.localeCompare(bl);
  });
}

/**
 * Resolve ids in chunks.
 *
 * `keycloak.resolveUsers` takes a `cap` and SLICES anything beyond it away
 * without a word. Handing it the whole id list and trusting the default would
 * silently render everyone past the cap as a raw UUID — indistinguishable from
 * a genuinely dangling grant, which is the one distinction this endpoint
 * exists to make.
 */
const RESOLVE_CHUNK = 50;

async function resolveAll(
  ids: string[],
): Promise<Record<string, { id: string; email: string | null; name: string }>> {
  const out: Record<string, { id: string; email: string | null; name: string }> = {};
  for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
    const chunk = ids.slice(i, i + RESOLVE_CHUNK);
    Object.assign(out, await keycloak.resolveUsers(chunk, RESOLVE_CHUNK));
  }
  return out;
}

export async function handleListAdminUsers(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!isSuperAdmin(user)) return jsonResponse({ error: 'super-admin only' }, 403);

  return emitSpan('fr.admin.users.list', { 'user.id': user.id }, async () => {
    const grants = await userRolesService.listAllGrants();
    const ids = [...new Set(grants.map((g) => g.user_id))];

    // A directory outage must not blank the access list. The grants ARE the
    // access; the names are decoration, and reporting ids with `resolved:false`
    // beats reporting nothing.
    let people: Record<string, { id: string; email: string | null; name: string }> = {};
    let directoryError: string | null = null;
    try {
      people = await resolveAll(ids);
    } catch (e) {
      directoryError = e instanceof Error ? e.message : String(e);
    }

    const users = groupGrantsByUser(grants, people);
    return jsonResponse({
      users,
      grant_count: grants.length,
      // Named so the UI can say "names unavailable" rather than implying every
      // row is a dangling grant.
      directory_error: directoryError,
    });
  });
}
