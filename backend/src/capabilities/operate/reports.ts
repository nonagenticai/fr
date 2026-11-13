// fr-agui SPEC §13 P4b (part 2) — spec drain: three of the reporting reads
// (routes/reports/index.ts), re-expressed with NO behaviour change (`legacyHandler`).
// `GET /api/reports/project-status/:projectId` is project-scoped and stays pinned
// (P2); `/api/reports[/:reportId[/fix]]` are literal-spec operations.
//
//   * approval-backlog — fr's own approvals the caller must decide, in
//     `ctxTenantId(user.tenantId)` (500 with no tenant, before the store):
//     `isAuthenticatedUserInResolvedTenant`.
//   * worker-activity — two worker_management reads (`requireTenant`: the
//     REQUEST-CONTEXT tenant, non-blank, else 409 MISSING_TENANT, nothing sent):
//     `isAuthenticatedUserInFrameTenant`.
//   * asset-changes — the version history of ONE asset, read from
//     requirements_management (`requireTenant`) — but only when `assetId` is given:
//     without it the route answers `changes: []` and a `note` with no upstream call,
//     whatever the tenant. So the frame tenant is required exactly when `assetId` is
//     present (and non-empty); the declared rule reads the input to decide that.
import { z } from 'zod';

import type { ActionContext } from '../../agui/types';
import { tryGetRequestContext } from '../../integrations/_lib/context';
import type { Capability, ResponseSpec } from '../define';
import { isAuthenticatedUserInFrameTenant, isAuthenticatedUserInResolvedTenant, principalDoorAdmits, type CapabilityRoute } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody } from '../settings/_shared';

const ASSET_TYPES = ['requirements', 'decisions', 'principles'] as const;

/**
 * `GET /api/reports/asset-changes/:assetType`: `validateAuth` (its doors), then a
 * non-blank REQUEST-CONTEXT tenant only when an upstream call is made — i.e. when
 * `assetId` is a non-empty string (`url.searchParams.get('assetId') ?? undefined`,
 * then `if (!assetId)`).
 */
function assetChangesRule(route: CapabilityRoute): Capability['auth']['rbac'] {
  return {
    type: 'custom' as const,
    check: async (ctx: ActionContext, input: unknown) => {
      if (!ctx.userId || !principalDoorAdmits(route)) return false;
      const assetId = (input as { assetId?: unknown } | null | undefined)?.assetId;
      const callsUpstream = typeof assetId === 'string' && assetId.length > 0;
      return !callsUpstream || Boolean(tryGetRequestContext()?.tenantId?.trim());
    },
  };
}

const iso = z.string().describe('ISO-8601 timestamp');

const responses = (o: { tenant: 'resolved' | 'frame' | 'asset' }): ResponseSpec[] => [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      (o.tenant === 'asset' ? "400: `error` \"Unsupported assetType '…'\" (not requirements / decisions / principles). " : '') +
      (o.tenant === 'resolved'
        ? "500: fr's own (`error`), e.g. no tenant resolvable for the caller (no frame, no JWT tenant), or the database is unreachable. "
        : "409: `error.code` 'MISSING_TENANT' (no request tenant: nothing is sent upstream" +
          (o.tenant === 'asset' ? '; only when `assetId` is given' : '') +
          "). Any other status is the upstream's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx " +
          "or no answer is 502, a timeout 504), or fr's own 500 (`error`). ") +
      DOOR_403,
    schema: frErrorBody,
  },
];

export const REPORTING_CAPABILITIES = settingsCapabilities(
  {
    area: 'reports', tag: 'Reporting', tenancy: 'tenant',
    module: 'src/routes/reports/index.ts', load: () => import('../../routes/reports/index'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'reports.approval_backlog', method: 'GET', path: '/api/reports/approval-backlog', handler: 'handleApprovalBacklogReport',
      summary: 'The pending approvals the caller is a required approver on, newest first', effect: 'read',
      input: z.object({}),
      output: z.object({
        data: z.object({
          pending: z.array(
            z.object({
              id: z.string(),
              project_id: z.string().nullable(),
              description: z.string(),
              status: z.string(),
              created_at: iso,
              expires_at: iso.nullable().describe('null: no deadline.'),
              role: z.string().nullable(),
            }),
          ),
          count: z.number().int(),
        }),
      }),
      responses: responses({ tenant: 'resolved' }),
    },
    {
      id: 'reports.worker_activity', method: 'GET', path: '/api/reports/worker-activity/:workerId', handler: 'handleWorkerActivityReport',
      summary: "A worker and its recent state transitions (up to 100), optionally since a time", effect: 'read',
      input: z.object({
        workerId: pathId('Worker name'),
        since: z.string().optional().describe('ISO-8601; only events at or after it (an unparsable value filters nothing).'),
      }),
      output: z.object({
        data: z.object({
          worker: z.object({}).passthrough().describe("worker_management's WorkerResponse, as it answers it."),
          since: z.string().optional(),
          events: z.array(z.object({ at: z.string(), status: z.string(), detail: z.string().nullable().optional() })),
        }),
      }),
      responses: responses({ tenant: 'frame' }),
      rule: routeRule(isAuthenticatedUserInFrameTenant),
    },
    {
      id: 'reports.asset_changes', method: 'GET', path: '/api/reports/asset-changes/:assetType', handler: 'handleAssetChangesReport',
      summary: "One asset's version history (requirements / decisions / principles)", effect: 'read',
      description: 'Without `assetId` nothing is read: `changes` is empty and `note` says an id is needed.',
      input: z.object({
        assetType: z.enum(ASSET_TYPES).describe('requirements | decisions | principles'),
        assetId: z.string().optional().describe('The asset. Required for any history.'),
        since: z.string().optional().describe('ISO-8601; versions updated at or after it (best effort).'),
      }),
      output: z.object({
        data: z.object({
          changes: z.array(
            z.object({
              id: z.string().optional(),
              version: z.union([z.number(), z.string()]).optional(),
              updated_at: z.string().optional(),
              raw: z.unknown().describe('The upstream version row, as it answers it.'),
            }),
          ),
          assetType: z.enum(ASSET_TYPES),
          since: z.string().optional(),
          note: z.string().optional(),
        }),
      }),
      responses: responses({ tenant: 'asset' }),
      rule: assetChangesRule,
    },
  ],
);
