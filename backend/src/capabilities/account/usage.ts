// fr-agui SPEC §13 P4b (part 3) — spec drain: the active workspace's usage, cost,
// budget and plan views under `/api/me` (routes/me/usage.ts, routes/me/budget-topup.ts),
// re-expressed with NO behaviour change (`legacyHandler`). `GET /api/me/usage/funding`
// was already a literal spec operation and stays one.
//
// Money: every cost figure follows the owner ruling the handlers enforce — a
// super_admin sees INCURRED (provider) cost, everyone else BILLED cost (incurred ×
// the tenant's markup), and when the markup cannot be established the billed
// figure is WITHHELD (`null`, `cost_basis: 'unavailable'`), never the incurred one.
// The fields that carry incurred cost are declared optional and described as
// super_admin-only.
//
// Gates, as the handlers enforce them:
//   * usage summary / series / breakdown / quota, by-correlation cost, budget
//     status, packages, plan — validateAuth only (its doors): `isAuthenticatedUser`.
//     With no request tenant they answer an empty-but-valid payload (budget status:
//     metering's own 400, relayed);
//   * `/usage/by-tenant` — + `super_admin` (403 'forbidden'): `isAuthenticatedSuperAdmin`;
//   * the top-up and its history — the handler catches validateAuth, then needs a
//     REQUEST-CONTEXT tenant (absent or empty → 400 'no active tenant', NOT trimmed),
//     then a super_admin, a realm tenant_admin pinned to it, or a `user_roles`
//     workspace-admin row (403): the route-aware `workspace-admin` rule with
//     `superAdmin` and `frameTenant: 'untrimmed'`.
import { z } from 'zod';

import { TopupBody } from '../../routes/me/budget-topup-schemas';
import { isAuthenticatedSuperAdmin, isAuthenticatedUser } from '../rbac-rules';
import { caughtAuthResponses, isoTime, routeRule, settingsCapabilities, standardResponses, workspaceAdminRule } from './_shared';

/** A decimal USD amount as billing / fr serialise it (a string). */
const usd = z.string().describe('USD, a decimal string');
const costBasis = z.enum(['billed', 'unavailable']).describe("'billed', or 'unavailable': the tenant's markup is unknown, so the billed amount is withheld (null).");
const incurred = (what: string) => usd.optional().describe(`${what} SUPER_ADMIN ONLY (incurred provider cost); absent for everyone else.`);
const billedOrNull = usd.nullable().describe('Billed cost; null when the markup is unknown (cost_basis unavailable).');
const markupPct = z.number().nullable().describe('The tenant markup: a super_admin only (null for everyone else).');

const METERING =
  "Any metering status is relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no answer is 502, a timeout " +
  '504) — except a 404 (an older metering deploy), answered as the empty payload. ';

const series = z.object({
  window: z.literal('30d'),
  granularity: z.enum(['hourly', 'daily']),
  buckets: z.array(
    z.object({
      ts: z.string(),
      requests: z.number(),
      tokens: z.number(),
      cost_usd: incurred('Incurred cost of the bucket.'),
      billed_cost_usd: billedOrNull,
      provider_estimate_usd: usd.nullable().optional().describe('Estimated public provider cost of BYO usage (not marked up).'),
    }),
  ),
  cost_unavailable: z.boolean().describe('No cost rollup for this granularity / window: render cost cells as unknown, not $0.'),
  markup_pct: markupPct,
  cost_basis: costBasis,
});

const breakdown = z.object({
  window: z.literal('30d'),
  services: z.array(
    z.object({
      service: z.string(),
      requests: z.number(),
      tokens: z.number(),
      cost_usd: incurred('Incurred cost of the service.'),
      billed_cost_usd: billedOrNull,
      provider_estimate_usd: usd.nullable().optional(),
    }),
  ),
  cost_unavailable: z.boolean(),
  markup_pct: markupPct,
  cost_basis: costBasis,
});

/** billing `BudgetAggregateStatus` (GET /api/budget/status/me), relayed unchanged. */
export const budgetStatus = z
  .object({
    tenant_id: z.string(),
    total_remaining: z.number().int(),
    budget_count: z.number().int(),
    next_expiry: z.string().nullable().optional(),
    budgets: z.array(
      z
        .object({
          budget_id: z.string(),
          tenant_id: z.string(),
          license_id: z.string().nullable(),
          period: z.string(),
          budget_tokens: z.number().int(),
          used_tokens: z.number().int(),
          remaining_tokens: z.number().int(),
          usage_pct: z.number(),
          over_budget: z.boolean(),
          priority: z.number().int(),
          starts_at: z.string().nullable().optional(),
          expires_at: z.string().nullable().optional(),
          source: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const topupPackage = z.object({ id: z.string(), label: z.string(), tokens: z.number().int(), priceUsd: z.number() });

/** A `budget_topups` row as `jsonResponse` serialises it. */
const topupRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  actor_user_id: z.string(),
  package_id: z.string(),
  tokens: z.number(),
  price_usd: z.string(),
  budget_id: z.string().nullable(),
  payment_ref: z.string().nullable(),
  payment_status: z.enum(['free', 'paid', 'pending', 'failed']),
  status: z.enum(['pending', 'allocated', 'failed']),
  error: z.string().nullable(),
  idempotency_key: z.string(),
  created_at: isoTime,
  updated_at: isoTime,
});

/** The top-up outcome (201; a replay adds `status` + `idempotent_replay`, 200). */
export const topupAllocated = z.object({
  topup_id: z.string(),
  budget_id: z.string().nullable(),
  tokens: z.number(),
  package_id: z.string(),
  payment_status: z.enum(['free', 'paid', 'pending', 'failed']),
});

const ADMIN_GATE =
  "400: `error` 'no active tenant' (no request tenant). 403: `error` 'workspace-admin required for this tenant' (neither a " +
  'super_admin nor a workspace-admin of the request tenant). ';

export const MY_USAGE_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Billing', tenancy: 'tenant',
    module: 'src/routes/me/usage.ts', load: () => import('../../routes/me/usage'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.get_usage_summary', method: 'GET', path: '/api/me/usage/summary', handler: 'handleGetMyUsageSummary',
      summary: "The request tenant's requests, tokens and cost today or this month", effect: 'read',
      input: z.object({ window: z.string().optional().describe("'month', else today (any other value is today).") }),
      output: z.object({
        window: z.enum(['today', 'month']),
        requests: z.number(),
        tokens: z.number(),
        internal_cost_usd: incurred('Incurred cost.'),
        billed_cost_usd: billedOrNull,
        cost_basis: costBasis,
        today_provisional: z
          .object({
            currency: z.string(),
            cost_usd: usd.nullable().describe('Incurred for a super_admin, billed for everyone else; null when the markup is unknown.'),
            cost_basis: z.enum(['incurred', 'billed', 'unavailable']),
            calls: z.number(),
            input_tokens: z.number(),
            output_tokens: z.number(),
            settled_through: z.string().nullable().describe('Last day the nightly rollup settled.'),
            since: z.string().nullable().describe('First day the provisional figure covers.'),
            as_of: z.string().describe('When billing read the figure (ISO-8601).'),
          })
          .nullable()
          .describe(
            "The request tenant's spend not yet rolled up (billing /api/costs/provisional), independent of `window`. " +
              'null when unreadable — never zeros; see today_provisional_unavailable_reason.',
          ),
        today_provisional_unavailable_reason: z
          .enum(['no_active_tenant', 'billing_not_deployed', 'billing_unreachable', 'billing_malformed'])
          .nullable(),
      }),
      responses: standardResponses(
        "No request tenant: zeros, no upstream call. Any metering status is relayed (`error.code` 'UPSTREAM_…'; its 4xx pass " +
          'through, its 401 / 5xx or no answer is 502, a timeout 504) — except the provisional read, whose failure only nulls ' +
          '`today_provisional`. ',
      ),
    },
    {
      id: 'me.get_usage_series', method: 'GET', path: '/api/me/usage/series', handler: 'handleGetMyUsageSeries',
      summary: "The request tenant's 30-day usage series (hourly or daily buckets)", effect: 'read',
      input: z.object({
        window: z.string().optional().describe('Always 30d (the value is never read).'),
        granularity: z.string().optional().describe("'hourly', else daily (any other value is daily)."),
      }),
      output: series,
      responses: standardResponses(METERING),
    },
    {
      id: 'me.get_usage_breakdown', method: 'GET', path: '/api/me/usage/breakdown', handler: 'handleGetMyUsageBreakdown',
      summary: "The request tenant's 30-day usage per service", effect: 'read',
      input: z.object({ window: z.string().optional().describe('Always 30d (the value is never read).') }),
      output: breakdown,
      responses: standardResponses(METERING),
    },
    {
      id: 'me.get_usage_quota', method: 'GET', path: '/api/me/usage/quota', handler: 'handleGetMyUsageQuota',
      summary: "The request tenant's month-to-date consumption (no per-user quota exists: quotas are null)", effect: 'read',
      input: z.object({}),
      output: z.object({
        requests_per_month: z.object({ quota: z.number().nullable(), consumed: z.number() }),
        tokens_per_month: z.object({ quota: z.number().nullable(), consumed: z.number() }),
        cost_usd_per_month: z.object({
          quota: z.number().nullable(),
          consumed: usd.nullable().describe('Incurred for a super_admin, billed for everyone else; null when the markup is unknown.'),
          cost_basis: z.enum(['incurred', 'billed', 'unavailable']),
        }),
      }),
      responses: standardResponses(
        "Any metering status is relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no answer is 502, a timeout 504). ",
      ),
    },
    {
      id: 'me.get_usage_by_tenant', method: 'GET', path: '/api/me/usage/by-tenant', handler: 'handleGetMyUsageByTenant',
      summary: 'Super-admin: today and this month, per workspace the caller can act in (incurred cost)', effect: 'read',
      input: z.object({}),
      output: z.object({
        items: z.array(
          z.object({
            tenant_id: z.string(),
            tenant_name: z.string().nullable(),
            today: z.object({ requests: z.number(), cost_usd: usd }),
            month: z.object({ requests: z.number(), cost_usd: usd }),
          }),
        ),
      }),
      responses: standardResponses(
        "403: `error` 'forbidden' (not a super_admin). Any metering status is relayed (`error.code` 'UPSTREAM_…'). ",
      ),
      rule: routeRule(isAuthenticatedSuperAdmin),
      tenancy: 'platform',
    },
    {
      id: 'me.get_cost_by_correlation', method: 'GET', path: '/api/me/costs/by-correlation', handler: 'handleGetMyCostByCorrelation',
      summary: 'Priced LLM cost of the given correlation ids in the request tenant, optionally grouped', effect: 'read',
      description:
        'No ids, or no request tenant: zeros, no upstream call. `provider` grouping is a super_admin only (dropped for ' +
        'everyone else, like an unknown dimension).',
      input: z.object({
        ids: z.string().optional().describe('Comma-separated correlation ids (uuid; the first 500 are sent).'),
        group_by: z.string().optional().describe('Comma-separated: stage, model, provider (super_admin), correlation_id, day.'),
      }),
      output: z
        .object({
          total_cost_usd: usd.nullable(),
          total_input_tokens: z.number(),
          total_output_tokens: z.number(),
          event_count: z.number(),
          groups: z.array(
            z
              .object({
                key: z.record(z.string()).describe('One entry per requested dimension.'),
                cost_usd: usd.nullable(),
                input_tokens: z.number(),
                output_tokens: z.number(),
                event_count: z.number(),
              })
              .passthrough(),
          ),
          cost_basis: z.enum(['incurred', 'billed', 'unavailable']),
        })
        .passthrough(),
      responses: standardResponses(
        "Any billing status is relayed (`error.code` 'UPSTREAM_…': e.g. its 422 for a malformed id; its 401 / " +
          '5xx or no answer is 502) — except a 404 (an older billing deploy), answered as zeros. ',
      ),
    },
    {
      id: 'me.get_plan', method: 'GET', path: '/api/me/plan', handler: 'handleGetMyPlan',
      summary: "The request tenant's access charges (licence fees) and this month's included-usage allowance", effect: 'read',
      input: z.object({}),
      output: z.object({
        access_charges: z.array(
          z.object({
            service_key: z.string().nullable(),
            amount_usd: usd,
            cadence: z.string(),
            included_cost_usd: usd.nullable(),
            used_usd: usd.nullable(),
            remaining_usd: usd.nullable(),
          }),
        ),
        monthly_total_usd: usd,
        monthly_included_usd: usd,
        included_used_usd: usd.nullable(),
        included_remaining_usd: usd.nullable(),
        cost_basis: z.enum(['incurred', 'billed', 'unavailable']),
      }),
      responses: standardResponses(
        'No request tenant, or an older billing deploy (404): the empty plan. Any other billing / metering status is relayed ' +
          "(`error.code` 'UPSTREAM_…'). ",
      ),
    },
  ],
);

export const MY_BUDGET_STATUS_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Billing', tenancy: 'tenant',
    module: 'src/routes/me/usage.ts', load: () => import('../../routes/me/usage'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.get_budget_status', method: 'GET', path: '/api/me/budget/status', handler: 'handleGetMyBudgetStatus',
      summary: "The request tenant's token budgets (billing's aggregate, relayed)", effect: 'read',
      input: z.object({}),
      output: budgetStatus,
      responses: standardResponses(
        "Any billing status is relayed (`error.code` 'UPSTREAM_…': e.g. its 400 when there is no request tenant; its 401 / 5xx " +
          'or no answer is 502) — except a 404 (an older deploy), answered as an empty aggregate. ',
      ),
    },
  ],
);

export const MY_TOPUP_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Billing', tenancy: 'tenant',
    module: 'src/routes/me/budget-topup.ts', load: () => import('../../routes/me/budget-topup'),
    rule: workspaceAdminRule({ superAdmin: true, frameTenant: 'untrimmed' }),
  },
  [
    {
      id: 'me.list_topup_packages', method: 'GET', path: '/api/me/budget/packages', handler: 'handleListTopupPackages',
      summary: 'The budget top-up packages (none while top-up is disabled)', effect: 'read',
      input: z.object({}),
      output: z.object({ packages: z.array(topupPackage), topupEnabled: z.boolean() }),
      responses: standardResponses(),
      rule: routeRule(isAuthenticatedUser),
    },
    {
      id: 'me.top_up_budget', method: 'POST', path: '/api/me/budget/topup', handler: 'handleTopUpMyBudget',
      summary: "Top up the request tenant's token budget with a package (workspace-admin or super_admin)", effect: 'write', successStatus: 201,
      description:
        'Disabled until payment processing exists (BUDGET_TOPUP_ENABLED): then 409 `topup_unavailable` after the admin gate, ' +
        'before anything is written. Idempotent on (tenant, `idempotency_key`): a replay answers 200 with `idempotent_replay`.',
      input: TopupBody,
      output: topupAllocated,
      responses: [
        {
          status: 200,
          description: "An idempotent replay: this `idempotency_key` was already used for the request tenant; the ORIGINAL's outcome, nothing allocated again.",
          schema: topupAllocated.extend({ status: z.enum(['pending', 'allocated', 'failed']), idempotent_replay: z.literal(true) }),
        },
        ...caughtAuthResponses(
          { status: 'own', write: true },
          ADMIN_GATE +
            "409: `error` 'topup_unavailable' (top-up disabled). 400: `error` 'invalid JSON body'. 422: `error` 'invalid request " +
            "body' (`details`). 404: `error` \"unknown package '…'\" (`packages`: the ids). Any billing status of the allocation is " +
            "relayed (`error.code` 'UPSTREAM_…'). ",
        ),
      ],
    },
    {
      id: 'me.list_topups', method: 'GET', path: '/api/me/budget/topups', handler: 'handleListMyTopups',
      summary: "The request tenant's 50 most recent top-ups (the audit rows)", effect: 'read',
      input: z.object({}),
      output: z.object({ topups: z.array(topupRow) }),
      responses: caughtAuthResponses({ status: '401' }, ADMIN_GATE),
    },
  ],
);
