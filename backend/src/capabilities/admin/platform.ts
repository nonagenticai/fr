// fr-agui SPEC §13 P4c part 2 — spec drain: the platform access console and the
// system-wide usage rollup, re-expressed with NO behaviour change (`legacyHandler`):
//
//   * GET /api/admin/users (routes/admin/users.ts) and POST / DELETE
//     /api/admin/users/:userId/roles (routes/admin/user-roles.ts): who holds an fr
//     role in which workspace, across EVERY tenant (`user_roles` is the authority).
//     Gate: validateAuth CAUGHT (EVERY refusal 401 'unauthorized' — the conveyor
//     write door included), then the super_admin realm role (403 'super-admin only').
//   * GET /api/admin/usage/system (routes/me/usage.ts): the billing service's
//     system-wide rollup (every tenant, every provider; incurred AND billed cost).
//     Gate: validateAuth (thrown to the central catch), then the super_admin role
//     (403 'forbidden').
//
// All four are cross-tenant: `tenancy: 'platform'`, `isAuthenticatedSuperAdmin`.
import { z } from 'zod';

import { GrantBody, RevokeParams } from '../../routes/admin/user-roles-schemas';
import type { Capability, ResponseSpec } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { FR_500, LICENCE_ROUTE_DOOR_403, isoTime, pathId, routeRule, settingsCapabilities, standardResponses } from '../observe/_shared';

const ACCESS_401: ResponseSpec = {
  status: 401,
  description:
    "`error` 'unauthorized': the handler catches every validateAuth refusal and answers it itself (the conveyor priority " +
    'identity on a write included). A licence bearer is a 403 (below), never this 401.',
  schema: z.object({ error: z.literal('unauthorized') }),
};
const accessDefault = (extra: string): ResponseSpec => ({
  status: 'default',
  description: "403: `error` 'super-admin only' (not a super_admin). " + extra + `403: ${LICENCE_ROUTE_DOOR_403} ${FR_500}`,
  schema: z.object({ error: z.string(), details: z.unknown().optional() }).passthrough(),
});

const grantSync = z
  .enum(['disabled', 'added', 'already', 'skipped_no_tenant', 'skipped_tenant_mismatch', 'skipped_super_admin', 'skipped_user_absent', 'failed'])
  .describe('The Keycloak realm tenant_admin write-through outcome (services/tenant-admin-sync.ts; workspace-admin grants only).');
const revokeSync = z
  .enum(['disabled', 'removed', 'absent', 'refused_composite', 'skipped_no_tenant', 'skipped_tenant_mismatch', 'skipped_super_admin', 'skipped_user_absent', 'failed'])
  .describe('The Keycloak realm tenant_admin write-through outcome (services/tenant-admin-sync.ts).');
const userId = { userId: pathId('The Keycloak user id (sub) of the person') };
const grant = z.object({
  user_id: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string().nullable().describe("The workspace's name from the licences catalogue; null when it could not be read."),
  role: z.enum(['workspace-admin', 'workspace-member']),
  created: z.boolean().describe('false: the grant already existed (nothing written).'),
  tenant_lookup_error: z.string().nullable().describe('Why the name could not be read (a catalogue outage never refuses the grant).'),
  keycloak_sync: grantSync.optional(),
});
const revoked = z.object({ user_id: z.string(), tenant_id: z.string(), role: z.string(), keycloak_sync: revokeSync });

export const ADMIN_USER_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...settingsCapabilities(
    {
      area: 'admin_users', tag: 'Platform Access', tenancy: 'platform',
      module: 'src/routes/admin/users.ts', load: () => import('../../routes/admin/users'),
      rule: routeRule(isAuthenticatedSuperAdmin),
    },
    [
      {
        id: 'admin_users.list', method: 'GET', path: '/api/admin/users', handler: 'handleListAdminUsers', effect: 'read',
        summary: 'Who holds an fr role, in which workspace, across every tenant (super-admin)',
        description:
          'One entry per person, from `user_roles`. A grant whose Keycloak account cannot be resolved is still listed ' +
          '(`resolved` false: a dangling grant), and a directory outage never blanks the list (`directory_error`).',
        input: z.object({}),
        output: z.object({
          users: z.array(
            z.object({
              user_id: z.string(),
              email: z.string().nullable(),
              name: z.string().nullable(),
              resolved: z.boolean(),
              workspaces: z.array(
                z.object({ tenant_id: z.string(), tenant_name: z.string().nullable(), role: z.string(), granted_at: isoTime, granted_by: z.string().nullable() }),
              ),
            }),
          ),
          grant_count: z.number().int(),
          directory_error: z.string().nullable().describe('Non-null: the names could not be read (every row then `resolved` false).'),
        }),
        responses: [ACCESS_401, accessDefault('')],
      },
    ],
  ),
  ...settingsCapabilities(
    {
      area: 'admin_users', tag: 'Platform Access', tenancy: 'platform',
      module: 'src/routes/admin/user-roles.ts', load: () => import('../../routes/admin/user-roles'),
      rule: routeRule(isAuthenticatedSuperAdmin),
    },
    [
      {
        id: 'admin_users.grant_role', method: 'POST', path: '/api/admin/users/:userId/roles', handler: 'handleGrantUserRole', effect: 'write', successStatus: 201,
        summary: "Grant a person a role in a workspace (super-admin)",
        description:
          '201 for a new grant, 200 (`created` false) for one that already existed. A workspace-admin grant also writes the ' +
          'Keycloak realm role through when that is on (`keycloak_sync`). Unknown body keys are ignored.',
        input: z.object(userId).merge(GrantBody),
        output: grant,
        responses: [
          { status: 200, description: 'The grant already existed (`created` false); nothing written.', schema: grant },
          ACCESS_401,
          accessDefault(
            "422: `error` 'invalid request body' (`details`: `tenant_id` not a UUID, `role` not workspace-admin / workspace-member). " +
              "400: `error` 'invalid JSON body'. 404: `error` 'tenant not found' (`tenant_id`: the licences catalogue answered that it does not exist). ",
          ),
        ],
      },
      {
        id: 'admin_users.revoke_role', method: 'DELETE', path: '/api/admin/users/:userId/roles', handler: 'handleRevokeUserRole', effect: 'destructive', successStatus: 204,
        summary: "Revoke a person's role in a workspace (super-admin)",
        description:
          'The target rides in the QUERY. Revoking workspace-admin is guarded: never the last live admin of the tenant, and one ' +
          'revoke per tenant at a time. 204 when the grant was removed; 200 with `keycloak_sync` when the Keycloak write-through ' +
          'ran (or removed a realm-only admin).',
        input: z.object(userId).merge(RevokeParams),
        output: z.null(),
        responses: [
          { status: 200, description: 'Revoked with the Keycloak write-through (or a realm-only admin removed there): its outcome.', schema: revoked },
          ACCESS_401,
          accessDefault(
            "422: `error` 'invalid query parameters' (`details`). 404: `error` 'no such grant'. 409: `error` 'cannot remove the " +
              "last workspace admin' or 'super_admin_implies_tenant_admin' (Keycloak grants it through super_admin / a composite). " +
              "502: `error` 'keycloak_write_failed' (nothing revoked). 503: `error` 'admin_count_unavailable' (the remaining admins " +
              "could not be verified) or 'workspace_admin_revoke_busy' (another revoke for the tenant is in flight); nothing changed. ",
          ),
        ],
      },
    ],
  ),
];

/** billing_service SystemUsageResponse (src/models/domain.py), relayed — `tenant_name` rewritten from fr's workspaces. */
const counts = { requests: z.number().int(), input_tokens: z.number().int(), output_tokens: z.number().int(), incurred_cost_usd: z.string() };
const systemUsage = z
  .object({
    window: z.string(),
    start: isoTime,
    end: isoTime,
    generated_at: isoTime,
    grand_total: z.object({ ...counts, billed_cost_usd: z.string() }).passthrough(),
    by_tenant: z.array(
      z
        .object({
          tenant_id: z.string(),
          tenant_name: z.string().nullable().describe("fr's own workspace name, else the billing service's; null when neither names it."),
          ...counts,
          effective_incurred_cost_usd: z.string().optional().describe('Incurred cost after the included-usage allowance (the markup base).'),
          markup_pct: z.number(),
          billed_cost_usd: z.string(),
        })
        .passthrough(),
    ),
    by_provider: z.array(z.object({ provider: z.string(), ...counts }).passthrough()),
  })
  .passthrough()
  .describe("The billing service's system-wide rollup (every tenant, every provider), relayed.");

export const SYSTEM_USAGE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'billing', tag: 'Billing', tenancy: 'platform',
    module: 'src/routes/me/usage.ts', load: () => import('../../routes/me/usage'),
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'billing.get_system_usage', method: 'GET', path: '/api/admin/usage/system', handler: 'handleGetAdminSystemUsage', effect: 'read',
      summary: 'System-wide usage and cost: every tenant, every provider (super-admin)',
      description: "Incurred (provider) AND billed cost, which only a super_admin sees. `window` is forwarded verbatim (default 'month').",
      input: z.object({ window: z.string().optional().describe("'today' or 'month' (the default); forwarded verbatim.") }),
      output: systemUsage,
      responses: standardResponses(
        "403: `error` 'forbidden' (not a super_admin). Any other status is the billing service's, relayed (`error.code` 'UPSTREAM_…'). ",
      ),
    },
  ],
);
