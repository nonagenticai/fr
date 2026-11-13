// fr-agui SPEC §13 P4c part 1 — spec drain: the super-admin read models
// GET /api/admin/control-tower (routes/admin/control-tower.ts) and the two
// remaining GET /api/admin/verification/* (routes/admin/verification.ts, D8: keep),
// re-expressed with NO behaviour change (`legacyHandler`). Platform-scoped.
//
// Gate (`runReadModel` + `requireSuperAdminRead`): validateAuth (thrown to the
// central catch), then the super_admin realm role — anyone else gets the SAME
// opaque 404 as an absent route, so the surface stays invisible. Declared:
// `isAuthenticatedSuperAdmin`. The query is parsed only after the gate (a bad value
// is fr's 400 BAD_REQUEST).
//
// Each verification answer is ONE read-model block: `data` is the upstream payload
// VERBATIM (inference-router, Prometheus; fr
// recomputes nothing and only checks it is an object / array), `meta` its
// provenance. An upstream outage is `available:false` INSIDE a 200, never a 5xx.
import { z } from 'zod';

import { daysOnly } from '../../routes/admin/operator-read-schemas';
import type { Capability } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { blockMeta, blockOf, routeRule, settingsCapabilities, standardResponses, type SettingsRoute } from '../observe/_shared';

const RESPONSES = standardResponses(
  "404: `error.code` 'UPSTREAM_NOT_FOUND' 'Not found' — not a super_admin (the surface is invisible to anyone else). " +
    "400: `error.code` 'BAD_REQUEST' (a query value that fails the schema; checked after the super_admin gate). ",
);

/** An inference-router object, verbatim. */
const verbatimObject = (what: string) => z.record(z.unknown()).describe(`The ${what} payload, verbatim (fr only checks it is a JSON object).`);

const ROUTES: SettingsRoute[] = [
  {
    id: 'verification.get_served_models_timeline', method: 'GET', path: '/api/admin/verification/served-models/timeline', handler: 'handleGetVerificationServedModels',
    summary: 'Which model actually served each requested alias, per day (super-admin)', effect: 'read', input: daysOnly,
    output: blockOf(verbatimObject('inference-router served-models/timeline')), responses: RESPONSES,
  },
  {
    id: 'verification.list_alerts', method: 'GET', path: '/api/admin/verification/alerts', handler: 'handleGetVerificationAlerts',
    summary: 'Live Verification* Prometheus alerts (super-admin)', effect: 'read',
    description: 'Always an available block: a Prometheus failure is `data.reachable` false with no items (alert state unknown), never "no alerts".',
    input: z.object({}),
    output: blockOf(
      z.object({
        source: z.literal('prometheus'),
        reachable: z.boolean(),
        error: z.string().optional(),
        as_of: z.string(),
        items: z.array(
          z.object({
            alertname: z.string(),
            state: z.enum(['firing', 'pending']),
            severity: z.string().nullable(),
            concept: z.string().nullable(),
            active_at: z.string().nullable(),
            summary: z.string().nullable(),
            labels: z.record(z.string()),
          }),
        ),
      }),
    ),
    responses: RESPONSES,
  },
];

const group = (module: string, load: () => Promise<Record<string, unknown>>, area: 'verification' | 'control_tower', tag: string) => ({
  area, tag, tenancy: 'platform' as const, module, load, rule: routeRule(isAuthenticatedSuperAdmin),
});

export const VERIFICATION_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  group('src/routes/admin/verification.ts', () => import('../../routes/admin/verification'), 'verification', 'Verification'),
  ROUTES,
);

/** A control-tower block whose `data` is fr's own composed read model (services/control-tower). */
const towerBlock = (what: string) => z.object({ data: z.unknown().describe(`${what} (fr's composed read model); null when unavailable.`), meta: blockMeta });

export const CONTROL_TOWER_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  group('src/routes/admin/control-tower.ts', () => import('../../routes/admin/control-tower'), 'control_tower', 'Control Tower'),
  [
    {
      id: 'control_tower.get', method: 'GET', path: '/api/admin/control-tower', handler: 'handleGetControlTower',
      summary: 'The platform control tower: fleet KPIs, tenants, executions, live n8n workflows, approvals, andon, alerts (super-admin)', effect: 'read',
      description: 'Every block degrades on its own (`meta.available` false), so a dead upstream never fails the tower.',
      input: z.object({}),
      output: z.object({
        fleet: towerBlock('Fleet KPIs'),
        tenants: towerBlock('Per-tenant health rows'),
        active_executions: towerBlock('Active executions'),
        n8n_workflows: towerBlock('The live n8n workflow list'),
        observability: towerBlock('Observability meters'),
        approvals: towerBlock('The approvals rollup'),
        andon: towerBlock('The andon snapshot'),
        alerts: towerBlock('Control alerts'),
      }),
      responses: RESPONSES,
    },
  ],
);
