// fr-agui SPEC §13 P4b (part 3) — spec drain: `/api/workspace/members`
// (routes/workspace/members.ts), the request tenant's member list and its
// workspace-admin / workspace-member grants, re-expressed with NO behaviour change
// (`legacyHandler`).
//
// Gate (`requireWorkspaceAdmin`, all three): it catches every validateAuth throw
// (401 'unauthorized'), resolves the tenant with `ctxTenantId(user.tenantId)`
// (neither a frame nor a JWT tenant → it throws, 500), then requires
// `isWorkspaceAdminOf` that tenant — a `user_roles` workspace-admin row (read from
// the database) or a realm tenant_admin pinned to it; a super_admin alone does NOT
// pass (403 'workspace-admin role required'). Declared: the route-aware
// `workspace-admin` rule (no `superAdmin`). The tenant is NEVER a parameter.
import { z } from 'zod';

import { GrantBody, WorkspaceRole } from '../../routes/workspace/members-schemas';
import { caughtAuthResponses, pathId, settingsCapabilities, workspaceAdminRule } from './_shared';

const GRANT_SYNC = ['disabled', 'added', 'already', 'skipped_no_tenant', 'skipped_tenant_mismatch', 'skipped_super_admin', 'skipped_user_absent', 'failed'] as const;
const REVOKE_SYNC = [
  'disabled', 'removed', 'absent', 'refused_composite', 'skipped_no_tenant', 'skipped_tenant_mismatch', 'skipped_super_admin', 'skipped_user_absent', 'failed',
] as const;
/** The REVOKE_SYNC outcomes a 200 can carry (the rest are answered 409 / 502 / refused before any write). */
const REVOKE_SUCCESS_SYNC = ['removed', 'absent', 'skipped_user_absent'] as const satisfies ReadonlyArray<(typeof REVOKE_SYNC)[number]>;

const member = z.object({
  user_id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  resolved: z.boolean().describe('false: the directory did not resolve the user (the grants still stand).'),
  workspaces: z.array(
    z.object({
      tenant_id: z.string(),
      tenant_name: z.string().nullable(),
      role: z.string(),
      granted_at: z.string().nullable().describe('null on an entry synthesised from the realm tenant_admin role.'),
      granted_by: z.string().nullable(),
      source: z.literal('keycloak').optional(),
    }),
  ),
  admin_source: z.enum(['db', 'keycloak', 'both']).optional().describe('Admins only: where the workspace-admin status comes from.'),
});

/** One member no push channel reaches (`UnreachableMember`, routes/workspace/members.ts). */
const unreachableMember = z.object({
  user_id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  verdict: z.enum(['passive_only', 'unknown']),
});

const userId = z.object({ userId: pathId('The member (Keycloak user id)') });
const ADMIN_403 = "403: `error` 'workspace-admin role required' (not a workspace-admin of the request tenant; a super_admin alone is not). ";
const NO_TENANT = '500 also when no tenant is resolvable for the caller (no frame, no JWT tenant). ';

export const WORKSPACE_MEMBER_CAPABILITIES = settingsCapabilities(
  {
    area: 'workspace', tag: 'Tenant', tenancy: 'tenant',
    module: 'src/routes/workspace/members.ts', load: () => import('../../routes/workspace/members'),
    rule: workspaceAdminRule(),
  },
  [
    {
      id: 'workspace.list_members', method: 'GET', path: '/api/workspace/members', handler: 'handleListWorkspaceMembers',
      summary: "The request tenant's members and their roles (workspace-admin)", effect: 'read',
      input: z.object({}),
      output: z.object({
        members: z.array(member),
        tenant_id: z.string(),
        directory_error: z.string().nullable().describe('Set when name resolution failed: names unavailable, grants intact.'),
        realm_admins_unavailable: z.boolean().describe('The realm-admin lookup failed: the list may miss realm-only admins.'),
        realm_admin_revocable: z.boolean(),
        unreachable_members: z.array(unreachableMember).describe(
          'P1-TEAM-b (George 2026-10-15): every approval, question and notification of the tenant goes to EVERY member, on the ' +
            'channels each member configured. The members fr cannot PUSH to: `passive_only` (only inapp/websocket enabled) or ' +
            '`unknown` (no channel prefs at all); members reachable by push are omitted. Computed over ALL members ' +
            '(`user_roles` ∪ Keycloak `tenant_id`), not only `members`.',
        ),
        unreachable_members_partial: z.boolean().describe(
          'True when the member set behind `unreachable_members` could not be read completely (a directory or DB failure).',
        ),
      }),
      responses: caughtAuthResponses({ status: '401' }, ADMIN_403 + NO_TENANT),
    },
    {
      id: 'workspace.grant_member_role', method: 'POST', path: '/api/workspace/members/:userId/roles', handler: 'handleGrantWorkspaceMemberRole',
      summary: 'Grant a member a workspace role in the request tenant (workspace-admin)', effect: 'write',
      description: 'Idempotent: `granted` is false when the role was already held. A workspace-admin grant also reports its Keycloak write-through.',
      input: GrantBody.extend(userId.shape).strict(),
      output: z.object({
        granted: z.boolean(),
        user_id: z.string(),
        role: WorkspaceRole,
        keycloak_sync: z.enum(GRANT_SYNC).optional().describe('workspace-admin grants only.'),
      }),
      responses: caughtAuthResponses(
        { status: '401', write: true },
        ADMIN_403 + "400: `error` 'invalid JSON body'. 422: `error` 'invalid request body' (`details`; an unknown key such as a tenant is refused). " + NO_TENANT,
      ),
    },
    {
      id: 'workspace.revoke_member_role', method: 'DELETE', path: '/api/workspace/members/:userId/roles', handler: 'handleRevokeWorkspaceMemberRole',
      summary: 'Revoke a workspace role from a member of the request tenant (workspace-admin)', effect: 'destructive',
      description:
        'Never strands the workspace: removing the last live admin is a 409. A realm tenant_admin is revocable here only with ' +
        'the Keycloak write-through on.',
      input: userId.extend({ role: WorkspaceRole.describe('The role to revoke (query parameter).') }),
      output: z.object({
        revoked: z.boolean(),
        user_id: z.string(),
        role: WorkspaceRole,
        keycloak_sync: z.enum(REVOKE_SUCCESS_SYNC).optional().describe('workspace-admin revokes only; every other outcome is a 409 / 502.'),
      }),
      responses: caughtAuthResponses(
        { status: '401', write: true },
        ADMIN_403 +
          "422: `error` 'invalid or missing ?role' (`allowed`). 409: `error` 'cannot remove the last workspace admin', " +
          "'realm_tenant_admin_not_revocable_here' or 'super_admin_implies_tenant_admin'. 503: `error` 'admin_count_unavailable' " +
          "(Keycloak or the database could not verify the remaining admins) or 'workspace_admin_revoke_busy'. 502: `error` " +
          "'keycloak_write_failed' (nothing changed). " + NO_TENANT,
      ),
    },
  ],
);
