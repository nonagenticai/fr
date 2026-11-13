// fr-agui SPEC §13 P4b (part 3) — spec drain: `GET /api/tenant/billing`
// (routes/tenant/billing.ts), the per-project / per-member spend of the request
// tenant, re-expressed with NO behaviour change (`legacyHandler`). MONEY.
//
// Gate, as the handler enforces it: it catches every validateAuth throw (401
// 'unauthorized'), resolves the tenant with `ctxTenantId(user.tenantId)` (the
// frame tenant, else the JWT one; with neither it THROWS → 500), then admits a
// `super_admin`, a realm `tenant_admin` pinned to that tenant, or a `user_roles`
// 'workspace-admin' row read STRAIGHT from the database (`hasRole`), else 403.
// Declared: the route-aware `workspace-admin` rule with `superAdmin` (the same
// predicate, `isWorkspaceAdminVia`, and the same database read).
//
// What a caller sees: a super_admin the INCURRED cost (`cost_basis: 'incurred'`);
// a workspace-admin the BILLED cost (`'billed'`), or — when the tenant's markup is
// unknown — every fr cost figure withheld (`null`, `'unavailable'`). Request
// counts, names, coverage and the customer's own BYO spend are always present.
import { z } from 'zod';

import { caughtAuthResponses, settingsCapabilities, workspaceAdminRule } from './_shared';

const cost = z.number().nullable().describe("USD. null when the tenant's markup is unknown (cost_basis 'unavailable').");

const billing = z.object({
  from: z.string(),
  to: z.string(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable().describe("null: not one of the request tenant's projects in fr's table."),
      cost_usd: cost,
      requests: z.number(),
    }),
  ),
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      resolved: z.boolean().describe('false: Keycloak did not resolve the actor (the row is still listed).'),
      cost_usd: cost,
      byo_cost_usd: z.number().describe("The part billed to the customer's own provider key (never marked up)."),
      requests: z.number(),
    }),
  ),
  unattributed: z.object({
    project_usd: cost,
    project_requests: z.number(),
    member_usd: cost,
    member_requests: z.number(),
  }),
  total_cost_usd: cost.describe("billing's tenant total (the authoritative spend figure)."),
  totals: z.object({ tenant_usd: cost, projects_usd: cost, members_usd: cost }),
  totals_mismatch: z.boolean().describe('The tenant / projects / members totals differ by more than 1e-6 USD.'),
  coverage: z.object({ project_pct: z.number().nullable(), member_pct: z.number().nullable() }),
  names_unavailable: z.object({ projects: z.boolean(), members: z.boolean() }),
  cost_basis: z.enum(['incurred', 'billed', 'unavailable']),
});

export const TENANT_BILLING_CAPABILITIES = settingsCapabilities(
  {
    area: 'billing', tag: 'Billing', tenancy: 'tenant',
    module: 'src/routes/tenant/billing.ts', load: () => import('../../routes/tenant/billing'),
    rule: workspaceAdminRule({ superAdmin: true }),
  },
  [
    {
      id: 'billing.get_tenant_billing', method: 'GET', path: '/api/tenant/billing', handler: 'handleGetTenantBilling',
      summary: "Spend per project and per member of the request tenant over a date range (workspace-admin or super_admin)", effect: 'read',
      input: z.object({
        from: z.string().optional().describe('YYYY-MM-DD; default: 6 days before `to`.'),
        to: z.string().optional().describe('YYYY-MM-DD (UTC, inclusive); default today.'),
      }),
      output: z.object({ data: billing }),
      responses: caughtAuthResponses(
        { status: '401' },
        "403: `error` 'workspace-admin required for this tenant'. 422: `error` 'from/to must be YYYY-MM-DD', 'from must be on " +
          "or before to' or 'date range too wide'. Any billing status is relayed (`error.code` 'UPSTREAM_…'; its 401 / 5xx or " +
          'no answer is 502). 500 also when no tenant is resolvable for the caller (no frame, no JWT tenant). ',
      ),
    },
  ],
);
