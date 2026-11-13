// fr-agui SPEC §13 P4b (part 3) — spec drain: the analytics rollup reads
// `/api/tools/analytics/*` (routes/tools/analytics.ts), re-expressed with NO
// behaviour change (`legacyHandler`).
//
// ⚠️ THE ROUTES' AGENT TWINS STAY WHERE THEY ARE. Each route validates its query and
// runs the hand-written `analytics.*` AG-UI action through `invokeAction`; those
// actions stay registered by routes/tools/analytics.ts (not derived from here,
// `agent.expose:false`). The capability id equals the action name (KAG precedent).
// The input schemas ARE the route's (routes/tools/analytics-schemas.ts); unknown
// query parameters are stripped, never refused.
//
// Gate, as the route runs it: validateAuth (its doors), then the action reads the
// tenant from an ActionContext the route builds WITHOUT one, so `ctxTenantId('')`
// accepts only the REQUEST-CONTEXT tenant (present and non-empty, no trim) and
// throws (500) before any read otherwise: `isAuthenticatedUserWithFrameTenant`.
// The JWT tenant is never a fallback here.
//
// 💰 Incurred cost is a super_admin's only — decided from the frame's verified
// `callerIsSuperAdmin`: the `cost_usd` KPI is dropped from the summary, every
// breakdown bucket's `cost_usd` is null, the export omits `cost_usd` rows, and a
// breakdown OF the `cost_usd` metric is refused (403). That last refusal depends on
// the input, so the breakdown's declared rule reads it.
import { z } from 'zod';

import type { ActionContext } from '../../agui/types';
import { tryGetRequestContext } from '../../integrations/_lib/context';
import { breakdownInput, breakdownOutput, exportInput, perChannelInput, perChannelOutput, summaryInput, summaryOutput } from '../../routes/tools/analytics-schemas';
import { defaultConfirm, defineCapability, type Capability, type CapabilityHttp, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { isAuthenticatedUserWithFrameTenant, type CapabilityRoute } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, unauthorizedBody } from '../settings/_shared';

const INCURRED_COST_METRIC = 'cost_usd';

/**
 * `GET /api/tools/analytics/breakdown`: the frame-tenant bar, and — for `metric=cost_usd`
 * only — a caller whose frame says it is a super_admin (`callerIsSuperAdmin`, set from
 * the verified claims), else 403 before any read.
 */
function breakdownRule(route: CapabilityRoute): Capability['auth']['rbac'] {
  return {
    type: 'custom' as const,
    check: async (ctx: ActionContext, input: unknown) => {
      if (!(await isAuthenticatedUserWithFrameTenant(ctx, route))) return false;
      const metric = (input as { metric?: unknown } | null | undefined)?.metric;
      return metric !== INCURRED_COST_METRIC || tryGetRequestContext()?.callerIsSuperAdmin === true;
    },
  };
}

const frameTenant = (route: CapabilityRoute): Capability['auth']['rbac'] => ({
  type: 'custom' as const,
  check: (ctx: ActionContext) => isAuthenticatedUserWithFrameTenant(ctx, route),
});

const responses = (extra = ''): ResponseSpec[] => [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      "400: `error.code` 'BAD_REQUEST' — a query parameter fails the schema (an unknown `window` / `dimension`, a non-uuid " +
      '`project_id`), or the result exceeds its row cap (narrow the window or filters). ' +
      extra +
      DOOR_403 +
      " 500: fr's own (`error`), e.g. no request tenant (the JWT tenant is not a fallback here), or the database is unreachable.",
    schema: frErrorBody,
  },
];

interface AnalyticsRoute {
  id: `analytics.${string}`;
  path: string;
  handler: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  responses: ResponseSpec[];
  rule?: (route: CapabilityRoute) => Capability['auth']['rbac'];
  http?: Pick<CapabilityHttp, 'responseContentType'>;
}

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function analyticsCapability(r: AnalyticsRoute): Capability<unknown, unknown> {
  return defineCapability({
    id: r.id,
    area: 'analytics',
    summary: r.summary,
    ...(r.description !== undefined ? { description: r.description } : {}),
    http: { method: 'GET', path: r.path, operationId: camel(r.id), ...(r.http ?? {}) },
    input: r.input,
    output: r.output,
    errors: [],
    auth: { principal: 'user', rbac: (r.rule ?? frameTenant)({ method: 'GET', path: r.path }) },
    tenancy: 'tenant',
    effect: 'read',
    confirm: defaultConfirm('read'),
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { tags: ['Analytics'], responses: [...r.responses] },
    legacyHandler: lazyHandler(() => import('../../routes/tools/analytics'), { module: 'src/routes/tools/analytics.ts', exportName: r.handler }),
  });
}

const COST_NOTE = 'The `cost_usd` (incurred provider cost) metric is a super_admin\'s only: dropped for everyone else.';

export const ANALYTICS_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  analyticsCapability({
    id: 'analytics.summary', path: '/api/tools/analytics/summary', handler: 'handleSummary',
    summary: "The request tenant's KPI totals and sparklines over a window (tenant-wide, or one project)",
    description: `${COST_NOTE} \`meta.stale\`: the rollup has not ticked for over 10 minutes.`,
    input: summaryInput, output: summaryOutput, responses: responses(),
  }),
  analyticsCapability({
    id: 'analytics.breakdown', path: '/api/tools/analytics/breakdown', handler: 'handleBreakdown',
    summary: "One metric of the request tenant split by a dimension (tool, outcome, project, initiator, channel)",
    description: "Every bucket's `cost_usd` is null for a caller who is not a super_admin, and `metric=cost_usd` is refused (403).",
    input: breakdownInput, output: breakdownOutput,
    responses: responses("403: `error` 'the cost_usd metric is restricted to platform operators' (metric=cost_usd, not a super_admin). "),
    rule: breakdownRule,
  }),
  analyticsCapability({
    id: 'analytics.per_channel', path: '/api/tools/analytics/per-channel', handler: 'handlePerChannel',
    summary: "Notifications the request tenant's approvals actually sent, per channel, over a window",
    description: '`project_id` is accepted and ignored (the notification log carries no project).',
    input: perChannelInput, output: perChannelOutput, responses: responses(),
  }),
  analyticsCapability({
    id: 'analytics.export', path: '/api/tools/analytics/export.csv', handler: 'handleExportCsv',
    summary: "The request tenant's raw rollup rows over a window, as CSV (a download)",
    description:
      `text/csv (Content-Disposition: attachment; analytics-<window>.csv), columns bucket_ts, metric_name, initiator, channel, ` +
      `project_id, value; at most 50 000 rows. ${COST_NOTE} \`dimensions\` is comma-separated on the wire and does not change the rows.`,
    input: exportInput, output: z.string().describe('The CSV document.'), responses: responses(),
    http: { responseContentType: 'text/csv' },
  }),
];
