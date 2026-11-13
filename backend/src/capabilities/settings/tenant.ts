// fr-agui SPEC §13 P4b — spec drain: the tenant directory and the connector
// dry-run, re-expressed with NO behaviour change (`legacyHandler`):
//
//   * `GET /api/tenant/members` (routes/tenant/members.ts) — the request tenant's
//     members (the approver picker), with their knowledge areas. Gate:
//     validateAuth (every throw it raises is answered 401 { error: 'unauthorized' }
//     by the handler; the conveyor priority identity is admitted on this GET), then
//     `ctxTenantId(user.tenantId)` (with no tenant the handler throws → 500). A
//     licence-shaped bearer never reaches the handler: the route is not on the
//     licence route allowlist, so the SERVER refuses it right after routing (403
//     `licence_route_not_allowed`).
//   * `POST /api/connectors/test-connection` (routes/connectors.ts) — dry-run a
//     scheduled-trigger connector config. Gate: validateAuth only (its doors).
//     A `secret_id` is resolved only when it is the caller's (or its tenant's)
//     `user_secrets` row; its value is used for the dry-run and never returned.
//
// `GET /api/tenant/billing` (tenant money: workspace-admin | super-admin, and a
// DB role lookup with no seam) is NOT declared here; it stays pinned (see the
// P4b report).
import { z } from 'zod';

import { TestConnectionBody } from '../../routes/connectors-schemas';
import { isAuthenticatedUser, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import {
  DOOR_403,
  LICENCE_ROUTE_DOOR_403,
  VALIDATE_AUTH_401,
  frErrorBody,
  preHandlerRefusalBody,
  routeRule,
  settingsCapabilities,
  unauthorizedBody,
} from './_shared';

const member = z.object({
  id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  resolved: z.boolean().describe('False when the directory did not resolve the id; the row is still listed.'),
  knowledge_areas: z.array(z.string()),
});

export const TENANT_MEMBER_CAPABILITIES = settingsCapabilities(
  {
    area: 'tenant', tag: 'Tenant', tenancy: 'tenant',
    module: 'src/routes/tenant/members.ts', load: () => import('../../routes/tenant/members'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'tenant.list_members', method: 'GET', path: '/api/tenant/members', handler: 'handleListTenantMembers',
      summary: "The request tenant's members, with their knowledge areas", effect: 'read',
      description: 'Every user holding a grant in the tenant, deduplicated; `resolved: false` rows are listed by id. No role is returned.',
      input: z.object({}),
      output: z.object({ items: z.array(member) }),
      responses: [
        {
          status: 401,
          description:
            "`error` 'unauthorized' — every validateAuth failure (the handler answers each one 401). The conveyor priority " +
            'identity is admitted on this GET; a licence bearer is the 403, not a 401.',
          schema: z.object({ error: z.literal('unauthorized') }),
        },
        {
          status: 403,
          description: `${LICENCE_ROUTE_DOOR_403} Or a request-context refusal (\`code\` e.g. 'active_tenant_not_permitted'), before routing.`,
          schema: preHandlerRefusalBody,
        },
        { status: 'default', description: "500: fr's own (`error`), e.g. no tenant resolvable for the caller, or the database is unreachable.", schema: frErrorBody },
      ],
    },
  ],
);

export const CONNECTOR_CAPABILITIES = settingsCapabilities(
  {
    area: 'connectors', tag: 'Connectors', tenancy: 'tenant',
    module: 'src/routes/connectors.ts', load: () => import('../../routes/connectors'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'connectors.test_connection', method: 'POST', path: '/api/connectors/test-connection', handler: 'handleTestConnection',
      summary: 'Dry-run a connector config (fetch up to three sample records)', effect: 'write',
      description:
        'Always 200 once the body passes: `ok` says whether the connector could fetch. A `secret_id` must be one of the ' +
        "caller's (or its tenant's) secrets; its value is used for the dry-run and never returned.",
      input: TestConnectionBody,
      output: z.object({
        ok: z.boolean(),
        sample_count: z.number().int().optional(),
        sample: z.array(z.unknown()).optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        {
          status: 'default',
          description:
            "400: `error` 'invalid JSON body', 'body invalid: …', \"connector kind '…' is not available\" or 'config invalid: …' / " +
            "a kind mismatch (nothing fetched). " +
            DOOR_403 +
            " 500: fr's own (`error`).",
          schema: frErrorBody,
        },
      ],
    },
  ],
);
