// fr-agui SPEC §13 P4c part 1 — spec drain: GET /api/measure (routes/measure.ts),
// the T/I/OE measurement lens over the request tenant's streams (Planka
// inventory + throughput, analytics_rollups operating expense), re-expressed with
// NO behaviour change.
//
// Gate: validateAuth — its refusals CAUGHT and answered `{ error: 'unauthorized' }`
// 401 — then `ctxTenantId(user.tenantId)` (neither a frame nor a JWT tenant → 500)
// before the first read. Declared: `isAuthenticatedUserInResolvedTenant`.
// Tenant-level (the workspace's streams; `stream` is a filter).
//
// 💰 `oe.cost_usd` is INCURRED cost: withheld (null) from anyone who is not a
// super_admin, as the handler does.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { caughtAuthResponses, routeRule, settingsCapabilities } from './_shared';

const WINDOW = z.enum(['24h', '7d', '30d', '90d']);

export const MEASURE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'measure', tag: 'Measure', tenancy: 'tenant',
    module: 'src/routes/measure.ts', load: () => import('../../routes/measure'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'measure.get', method: 'GET', path: '/api/measure', handler: 'handleGetMeasure',
      summary: "Throughput, inventory and operating expense of the request tenant's streams", effect: 'read',
      description:
        "Inventory and throughput are read from the streams' Planka boards; a stream whose board cannot be read is " +
        "reported in `meta` (`degraded`), and only when EVERY board fails is the call an error. Operating expense is " +
        'workspace-wide (not per stream); its incurred `cost_usd` is null for anyone but a super_admin.',
      input: z.object({
        stream: z.string().optional().describe("One stream id, or 'all' (the default). An unknown id selects no stream (never a 4xx)."),
        window: z.string().optional().describe("24h | 7d | 30d | 90d; anything else (or absent) is 7d (never a 4xx)."),
      }),
      output: z.object({
        data: z.object({
          window: WINDOW,
          stream: z.string().nullable(),
          streams: z.array(z.object({ id: z.string(), name: z.string() })).describe("Every active stream of the tenant (the selector)."),
          inventory: z.object({
            by_phase: z.object({ READYING: z.number(), DOING: z.number(), INSPECTING: z.number() }),
            blocked: z.number(),
            total: z.number(),
            done_current: z.number(),
            complete: z.boolean().describe('false: a list was truncated, so every number is a lower bound.'),
          }),
          throughput: z.object({ to_done: z.number().nullable().describe('null: no board yielded a throughput number.'), window: WINDOW }),
          oe: z.object({
            tokens: z.number().nullable().describe('null: nothing measured in the window.'),
            cost_usd: z.number().nullable().describe('Incurred cost; null for a non-super_admin, or nothing measured.'),
            approvals_decided: z.number(),
          }),
          constraint: z
            .object({
              phase: z.enum(['READYING', 'DOING', 'INSPECTING', 'PUBLISHING']).nullable().describe('null: the BLOCKED cards are the constraint.'),
              wip: z.number(),
              reason: z.string(),
            })
            .nullable(),
        }),
        meta: z.object({
          stream_count: z.number().int(),
          partial_streams: z.number().int(),
          degraded: z.boolean(),
          throughput_complete: z.boolean(),
          inventory_complete: z.boolean(),
        }),
      }),
      responses: caughtAuthResponses(
        { status: '401' },
        "502 / 504: every in-scope stream's board read failed (`error.code` 'UPSTREAM_…', Planka). 500 also when no tenant " +
          'is resolvable for the caller (no frame, no JWT tenant). ',
      ),
    },
  ],
);
