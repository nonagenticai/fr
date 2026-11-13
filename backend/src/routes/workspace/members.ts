// routes/workspace/members.ts
//
// The TENANT-ADMIN counterpart to routes/admin/users.ts.
//
// `/api/admin/users` is fleet-wide and super-admin only: it answers "who has
// access to fr, anywhere". A workspace admin needs the same question answered
// for the one workspace they administer, and until now there was no way to ask
// it — managing members of your own workspace required a super-admin, because
// the only writers of `user_roles` were the provisioning flow and the
// super-admin-gated grant route.
//
// ⛔ THE INVARIANT THAT MATTERS: the tenant is taken from the REQUEST CONTEXT
// (`ctxTenantId`), never from the request body or a path parameter. A
// workspace admin is an admin of ONE workspace; accepting a caller-supplied
// tenant here would let them grant themselves — or anyone — access to another
// tenant, which is a cross-tenant privilege escalation. `routes/admin/users.ts`
// may take `tenant_id` from the body precisely BECAUSE it is super-admin only.
// If you ever add a tenant parameter to these handlers, you have reintroduced
// that hole.
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { userRolesService, type RoleGrant } from '../../services/user-roles';
import { keycloak } from '../../services/keycloak';
import { listTenantMemberRecipients } from '../../services/tenant-member-recipients';
import { classifyRosterMember } from '../../domain/engagement/approval-routing';
import { emitSpan } from '../../telemetry/spans';
import { groupGrantsByUser, type AdminUser, type AdminUserWorkspace } from '../admin/users';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import {
  isTenantAdminWriteThroughEnabled,
  syncTenantAdminGrant,
  syncTenantAdminRevoke,
} from '../../services/tenant-admin-sync';
import { isLiveAdminOf, wouldStrandWorkspace } from '../../services/last-workspace-admin-guard';
import {
  WorkspaceAdminRevokeBusy,
  withWorkspaceAdminRevokeLock,
  type WorkspaceAdminRevokeTx,
} from '../../services/workspace-admin-revoke-lock';
import { z } from 'zod';

// The role vocabulary and the STRICT grant body live in ./members-schemas (side-effect
// free), shared with the capability declaration (fr-agui P4b part 3,
// capabilities/account/workspace-members.ts). Re-exported: they ARE this route's contract.
import { GrantBody, WorkspaceRole } from './members-schemas';
export { GrantBody, WorkspaceRole };

/** Same chunking discipline as the super-admin list — see routes/admin/users.ts. */
const RESOLVE_CHUNK = 50;

async function resolveAll(
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
 * Resolves the caller and asserts they administer the ACTIVE workspace.
 * Returns the tenant id so no handler has to re-derive it — deriving it twice
 * is how a check and a write end up disagreeing about which tenant they mean.
 *
 * ⭐ EXPORTED, so the knowledge-area routes reuse THIS gate rather than growing a
 * second copy of it. A re-implementation would be one more place that has to
 * remember to take the tenant from the request CONTEXT, that `isWorkspaceAdminOf`
 * deliberately excludes `super_admin`, and that the 401/403 split is part of the
 * contract — and copies of a gate diverge in exactly the direction that opens it.
 * It is a READ of the caller's identity and returns a Response on refusal; it has
 * no side effects, so exporting it widens nothing.
 */
export async function requireWorkspaceAdmin(
  req: Request,
): Promise<{ user: { id: string; roles: string[] }; tenantId: string } | { response: Response }> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return { response: jsonResponse({ error: 'unauthorized' }, 401) };
  }
  const tenantId = ctxTenantId(user.tenantId);
  if (!(await userRolesService.isWorkspaceAdminOf(user, tenantId))) {
    return { response: jsonResponse({ error: 'workspace-admin role required' }, 403) };
  }
  return { user, tenantId };
}

/** Where a member's workspace-admin status comes from. */
export type AdminSource = 'db' | 'keycloak' | 'both';

interface WorkspaceMemberWorkspace extends Omit<AdminUserWorkspace, 'granted_at'> {
  /** Null for a realm-derived entry: there is no grant row, hence no grant time. */
  granted_at: string | null;
  /** 'keycloak' on an entry synthesised from realm `tenant_admin`; absent for DB rows. */
  source?: 'keycloak';
}

export interface WorkspaceMember extends Omit<AdminUser, 'workspaces'> {
  workspaces: WorkspaceMemberWorkspace[];
  /**
   * Present only on admins. 'keycloak' / 'both' mean the admin role is held via
   * the realm `tenant_admin` role. Removable through this API only when
   * `realm_admin_revocable` is true (Keycloak write-through enabled); otherwise
   * the revoke returns 409 `realm_tenant_admin_not_revocable_here`.
   */
  admin_source?: AdminSource;
}

interface WorkspaceMembersResponse {
  members: WorkspaceMember[];
  tenant_id: string;
  /** Non-null when identity resolution threw — names unavailable, grants intact. */
  directory_error: string | null;
  /**
   * True when the Keycloak realm-admin lookup failed: `members` is then the
   * `user_roles` view only and may be MISSING realm-only admins.
   */
  realm_admins_unavailable: boolean;
  /**
   * True when fr writes the realm `tenant_admin` role through to Keycloak
   * (fr#1289 part B), i.e. a realm admin's revoke control can be enabled.
   */
  realm_admin_revocable: boolean;
  /**
   * P1-TEAM-b (George 2026-10-15): every approval, question and notification of this
   * tenant now goes to EVERY member, on the channels each member configured. These are
   * the members it cannot PUSH to — `classifyRosterMember`'s verdict, the same one sign-off
   * routing uses: `passive_only` (only inapp/websocket enabled — never reached away from
   * fr) or `unknown` (no channel prefs at all). Members reachable by push are omitted.
   * Computed over ALL members (user_roles ∪ Keycloak `tenant_id`), not only `members`.
   */
  unreachable_members: UnreachableMember[];
  /** True when the Keycloak half of the member list could not be read (DB members only). */
  unreachable_members_partial: boolean;
}

export interface UnreachableMember {
  user_id: string;
  name: string | null;
  email: string | null;
  verdict: 'passive_only' | 'unknown';
}

/** The one `user_roles.role` value that makes its holder a workspace admin. */
const DB_ADMIN_ROLE = 'workspace-admin';

/** GET /api/workspace/members */
export async function handleListWorkspaceMembers(req: Request): Promise<Response> {
  const gate = await requireWorkspaceAdmin(req);
  if ('response' in gate) return gate.response;
  const { user, tenantId } = gate;

  return emitSpan(
    'fr.workspace.members.list',
    { 'user.id': user.id, 'tenant.id': tenantId },
    async () => {
      const grants: RoleGrant[] = await userRolesService.listGrantsForTenant(tenantId);
      const dbAdminIds = new Set(
        grants.filter((g) => g.role === DB_ADMIN_ROLE).map((g) => g.user_id),
      );

      // Realm `tenant_admin` holders are admins with no `user_roles` row
      // (fr#1287); without this they are invisible here. Fail SOFT: the DB list
      // is still the truth about DB grants, and a flag tells the UI the view is
      // partial rather than letting "could not ask" read as "nobody else".
      let realmIds: string[] = [];
      let realmUnavailable = false;
      try {
        realmIds = [...new Set(await keycloak.listRealmTenantAdminIds(tenantId))];
      } catch (err) {
        realmUnavailable = true;
        reportSwallowedFailure(err, {
          service: 'keycloak',
          method: 'GET',
          path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
          degradedTo: `workspace members for tenant ${tenantId} = user_roles only`,
        });
      }
      const realmSet = new Set(realmIds);

      const ids = [...new Set([...grants.map((g) => g.user_id), ...realmIds])];

      // A directory outage must not blank the member list. The grants ARE the
      // access; names are decoration. Reporting ids with `resolved:false` beats
      // reporting nothing — and is distinguishable from a dangling grant by the
      // `directory_error` field, which the UI turns into a banner.
      let people: Record<string, { id: string; email: string | null; name: string }> = {};
      let directoryError: string | null = null;
      try {
        people = await resolveAll(ids);
      } catch (e) {
        directoryError = e instanceof Error ? e.message : String(e);
      }

      const REALM_MARK = '\u0000realm';
      const tenantName = grants.find((g) => g.tenant_name)?.tenant_name ?? null;
      const synthetic: RoleGrant[] = realmIds
        .filter((id) => !dbAdminIds.has(id))
        .map((id) => ({
          user_id: id,
          tenant_id: tenantId,
          tenant_name: tenantName,
          role: 'workspace-admin',
          granted_at: REALM_MARK,
          granted_by: null,
        }));

      const members: WorkspaceMember[] = groupGrantsByUser([...grants, ...synthetic], people).map(
        (m) => {
          const inDb = dbAdminIds.has(m.user_id);
          const inRealm = realmSet.has(m.user_id);
          const out: WorkspaceMember = {
            ...m,
            workspaces: m.workspaces.map((w) =>
              w.granted_at === REALM_MARK
                ? { ...w, granted_at: null, source: 'keycloak' as const }
                : w,
            ),
          };
          if (inDb || inRealm) out.admin_source = inDb && inRealm ? 'both' : inRealm ? 'keycloak' : 'db';
          return out;
        },
      );

      // ── P1-TEAM-b: who CANNOT be reached ────────────────────────────────────────
      // Fail soft both ways: a member-list failure yields an empty, `partial` list (the
      // page still renders its grants); a prefs-read failure classifies `unknown`
      // (`classifyRosterMember`'s own contract), never `push`.
      let unreachable: UnreachableMember[] = [];
      let unreachablePartial = false;
      try {
        const all = await listTenantMemberRecipients(tenantId);
        unreachablePartial = all.realmError !== undefined;
        const missing = all.userIds.filter((id) => !(id in people));
        let extraPeople: typeof people = {};
        if (missing.length > 0 && directoryError === null) {
          try {
            extraPeople = await resolveAll(missing);
          } catch {
            extraPeople = {};
          }
        }
        for (const id of all.userIds) {
          const { verdict } = await classifyRosterMember(id, tenantId);
          if (verdict === 'push') continue;
          const person = people[id] ?? extraPeople[id];
          unreachable.push({
            user_id: id,
            name: person?.name || null,
            email: person?.email ?? null,
            verdict,
          });
        }
      } catch (err) {
        unreachable = [];
        unreachablePartial = true;
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `unreachable-members view for tenant ${tenantId} unavailable (empty, partial)`,
        });
      }

      const body: WorkspaceMembersResponse = {
        members,
        tenant_id: tenantId,
        directory_error: directoryError,
        realm_admins_unavailable: realmUnavailable,
        realm_admin_revocable: isTenantAdminWriteThroughEnabled(),
        unreachable_members: unreachable,
        unreachable_members_partial: unreachablePartial,
      };
      return jsonResponse(body);
    },
  );
}

/** POST /api/workspace/members/:userId/roles */
export async function handleGrantWorkspaceMemberRole(
  req: Request,
  userId: string,
): Promise<Response> {
  const gate = await requireWorkspaceAdmin(req);
  if ('response' in gate) return gate.response;
  const { user, tenantId } = gate;

  let body: z.infer<typeof GrantBody>;
  try {
    body = GrantBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'invalid request body', details: e.errors }, 422);
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    throw e;
  }

  return emitSpan(
    'fr.workspace.members.grant',
    {
      'user.id': user.id,
      'target.user_id': userId,
      'tenant.id': tenantId,
      'grant.role': body.role,
    },
    async () => {
      const existed = await userRolesService.hasRole(userId, tenantId, body.role);
      // `tenantId` is the context tenant, NOT anything the caller sent.
      await userRolesService.grantRole(userId, tenantId, body.role, user.id);
      // The DB grant stands whatever Keycloak answers: `user_roles` alone makes
      // them admin in fr. The outcome is reported, never promoted to a failure.
      if (body.role === 'workspace-admin') {
        const keycloakSync = await syncTenantAdminGrant(userId, tenantId, user.id);
        return jsonResponse({
          granted: !existed,
          user_id: userId,
          role: body.role,
          keycloak_sync: keycloakSync,
        });
      }
      return jsonResponse({ granted: !existed, user_id: userId, role: body.role });
    },
  );
}

/** DELETE /api/workspace/members/:userId/roles?role=... */
export async function handleRevokeWorkspaceMemberRole(
  req: Request,
  userId: string,
): Promise<Response> {
  const gate = await requireWorkspaceAdmin(req);
  if ('response' in gate) return gate.response;
  const { user, tenantId } = gate;

  // The role rides in the query string: DELETE-with-body does not survive
  // every proxy between cloudflared and the pod (same reason as the
  // super-admin revoke route).
  const roleParam = new URL(req.url).searchParams.get('role');
  const parsed = WorkspaceRole.safeParse(roleParam);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'invalid or missing ?role', allowed: WorkspaceRole.options },
      422,
    );
  }

  return emitSpan(
    'fr.workspace.members.revoke',
    {
      'user.id': user.id,
      'target.user_id': userId,
      'tenant.id': tenantId,
      'grant.role': parsed.data,
    },
    async () => {
      // `tx` is the revoke lock's transaction when called inside it (fr#1312);
      // a workspace-member revoke takes no lock and passes none.
      const revokeDbRow = async (tx?: WorkspaceAdminRevokeTx): Promise<Response> => {
        const had = await userRolesService.hasRole(userId, tenantId, parsed.data, tx);
        await userRolesService.revokeRole(userId, tenantId, parsed.data, tx);
        return jsonResponse({ revoked: had, user_id: userId, role: parsed.data });
      };

      if (parsed.data !== 'workspace-admin') return revokeDbRow();

      // fr#1312: the guard below is check-then-act, so two admins revoking
      // each other concurrently would both pass it and strand the workspace.
      // The WHOLE sequence — fresh realm read, guard, Keycloak revoke, DB
      // delete — runs under a per-tenant transaction-scoped advisory lock, and
      // every DB read/write in it goes through the lock's `tx` (one pooled
      // connection per revoke; see workspace-admin-revoke-lock.ts).
      try {
        return await withWorkspaceAdminRevokeLock(tenantId, async (tx) => {
          // Realm `tenant_admin` holders are admins too (fr#1287). Both checks
          // below need that set, and both FAIL CLOSED when Keycloak cannot be
          // asked: a guard that proceeds on "unknown" is the guard that strands
          // the workspace, or reports a revoke that changed nothing.
          let realmIds: string[];
          try {
            // FRESH: a safety decision must not count an admin Keycloak removed
            // within the recipient cache's 60s TTL (fr#1291 audit).
            realmIds = await keycloak.listRealmTenantAdminIds(tenantId, { fresh: true });
          } catch (err) {
            reportSwallowedFailure(err, {
              service: 'keycloak',
              method: 'GET',
              path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
              degradedTo: `workspace-admin revoke refused (503) for tenant ${tenantId}`,
            });
            return jsonResponse(
              {
                error: 'admin_count_unavailable',
                detail:
                  'Could not read realm tenant admins from Keycloak; refusing to revoke workspace-admin until it can be verified. Retry shortly.',
              },
              503,
            );
          }
          const realmSet = new Set(realmIds);

          // Never remove the last LIVE admin — self or anyone else — that strands
          // the workspace with nobody able to administer it, and recovering needs
          // a super-admin. Checked before any write (DB or Keycloak). Counted over
          // the EFFECTIVE admin set (DB rows union realm tenant admins), with DB
          // rows whose Keycloak user is deleted/disabled NOT counted (fr#1309).
          // Fails CLOSED: a DB read or liveness lookup that cannot answer is a 503.
          let strands: boolean;
          try {
            const dbAdmins = await userRolesService.listUsersByRole(tenantId, 'workspace-admin', tx);
            strands = await wouldStrandWorkspace({
              targetUserId: userId,
              realmAdminIds: realmSet,
              dbAdminIds: dbAdmins,
              isLive: (id) => isLiveAdminOf(id, tenantId),
            });
          } catch (err) {
            reportSwallowedFailure(err, {
              service: 'keycloak',
              method: 'GET',
              path: '/admin/realms/{realm}/users/{id}',
              degradedTo: `workspace-admin revoke refused (503) for tenant ${tenantId}`,
            });
            return jsonResponse(
              {
                error: 'admin_count_unavailable',
                detail:
                  'Could not verify the remaining workspace admins (Keycloak or database unavailable); refusing to revoke workspace-admin until it can be verified. Retry shortly.',
              },
              503,
            );
          }
          if (strands) {
            return jsonResponse(
              {
                error: 'cannot remove the last workspace admin',
                detail:
                  'Grant workspace-admin to someone else first, or ask a super-admin.',
              },
              409,
            );
          }

          // A realm tenant admin stays admin via Keycloak whatever happens to the
          // DB row, so deleting only the row would be a silent no-op 200. Without
          // write-through, refuse; with it, remove the realm role FIRST and touch
          // the DB only once Keycloak confirms the role is gone.
          if (!realmSet.has(userId)) return revokeDbRow(tx);

          const notRevocable = () =>
            jsonResponse(
              {
                error: 'realm_tenant_admin_not_revocable_here',
                detail:
                  'This user is a workspace admin via the Keycloak realm role tenant_admin. That role is managed in Keycloak and cannot be removed here.',
              },
              409,
            );
          if (!isTenantAdminWriteThroughEnabled()) return notRevocable();

          const keycloakSync = await syncTenantAdminRevoke(userId, tenantId, user.id);
          switch (keycloakSync) {
            case 'removed':
            case 'absent':
            // The user was deleted from Keycloak after the 60s realm-admin
            // cache listed them: nothing to remove there, so revoke the DB row
            // (2026-09-30: such orphan rows used to be unrevocable).
            case 'skipped_user_absent': {
              // A realm-only admin has no DB row; that is not a 404.
              const had = await userRolesService.hasRole(userId, tenantId, parsed.data, tx);
              if (had) await userRolesService.revokeRole(userId, tenantId, parsed.data, tx);
              return jsonResponse({
                revoked: had || keycloakSync === 'removed',
                user_id: userId,
                role: parsed.data,
                keycloak_sync: keycloakSync,
              });
            }
            case 'refused_composite':
            case 'skipped_super_admin':
              return jsonResponse(
                {
                  error: 'super_admin_implies_tenant_admin',
                  detail:
                    'This user holds tenant_admin through a composite role or group (e.g. super_admin includes tenant_admin), not a direct mapping; removing it here would change nothing. Change the composite/group in Keycloak.',
                  keycloak_sync: keycloakSync,
                },
                409,
              );
            case 'failed':
              return jsonResponse(
                {
                  error: 'keycloak_write_failed',
                  detail:
                    'Could not remove the tenant_admin realm role in Keycloak; nothing was changed. Retry shortly.',
                  keycloak_sync: keycloakSync,
                },
                502,
              );
            default:
              // 'disabled' / 'skipped_no_tenant' / 'skipped_tenant_mismatch':
              // not expected for a realm admin of THIS tenant. Nothing changed.
              return notRevocable();
          }
        });
      } catch (err) {
        if (err instanceof WorkspaceAdminRevokeBusy) {
          return jsonResponse(
            {
              error: 'workspace_admin_revoke_busy',
              detail:
                'Another workspace-admin revoke for this workspace is in progress; nothing was changed. Retry shortly.',
            },
            503,
          );
        }
        throw err;
      }
    },
  );
}
