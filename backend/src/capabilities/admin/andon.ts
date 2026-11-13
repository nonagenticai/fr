// fr-agui SPEC §13 P4c part 1 — spec drain: the GLOBAL andon cord, the five
// /api/andon routes (routes/andon.ts), re-expressed with NO behaviour change
// (`legacyHandler`). One switch halts the platform conveyor across every
// workspace, so `tenancy: 'platform'`. (The stream cord was deleted 2026-11-03;
// the PROJECT cord, /api/projects/:id/andon/*,
// stays pinned for the project units.)
//
// Gates: validateAuth — its refusals CAUGHT (`authErrorToResponse`: 401
// 'unauthorized'; a door ForbiddenError 403 'forbidden') — then:
//   * GET /api/andon: nothing more (any authenticated caller reads it; a customer
//     tenant gets a neutral released cord in the same shape, `?live=1` probes n8n
//     only for a super_admin) — `isAuthenticatedUser`;
//   * engage / disengage / inflight / history: `requireSuperAdmin` — the
//     super_admin realm role, else 403 'forbidden' — `isAuthenticatedSuperAdmin`.
import { z } from 'zod';

import { streamKindEnum } from '../../db/schema';
import type { Capability, ResponseSpec } from '../define';
import { isAuthenticatedSuperAdmin, isAuthenticatedUser } from '../rbac-rules';
import { LICENCE_ROUTE_DOOR_403, isoTime, routeRule, settingsCapabilities } from '../observe/_shared';

const workerReplicas = z
  .number()
  .int()
  .nullable()
  .describe(
    'spec.replicas of the n8n-worker Deployment: 0 = every automatic n8n execution is stopped, 1 = the line is running. ' +
      'null = NOT MEASURED (the READ failed or nothing has been attempted; a refused write still reads back) — never the same fact as 0.',
  );

const pauseEvidence = z.object({
  attempted_at: isoTime.nullable().describe('null: no actuator attempt is recorded.'),
  error: z.string().nullable(),
  worker_replicas: workerReplicas,
});

const view = {
  engaged: z.boolean(),
  engaged_at: isoTime.nullable(),
  engaged_by: z.string().nullable().describe("The super_admin who pulled it (their email); null when released or for a customer tenant."),
  worker_replicas: workerReplicas,
  intent: z.enum(['engaged', 'released', 'unreadable']).describe("'unreadable': the singleton row is absent (shown as released)."),
  n8n_pause: pauseEvidence,
  n8n_live: z
    .object({
      measured_at: isoTime,
      worker_replicas: workerReplicas,
      available_replicas: z
        .number()
        .int()
        .nullable()
        .describe('status.availableReplicas — Ready worker pods. null: the probe failed. Lags spec.replicas after a release.'),
      error: z.string().nullable(),
    })
    .nullable()
    .describe('null: NOT probed.'),
};

const AUTH: ResponseSpec[] = [
  { status: 401, description: "`error` 'unauthorized' (no / an invalid / an expired bearer; the handler answers it itself).", schema: z.object({ error: z.literal('unauthorized') }) },
];
const forbidden = (who: string): ResponseSpec => ({
  status: 403,
  description: `\`error\` 'forbidden' — ${who}. Or \`code\` ${LICENCE_ROUTE_DOOR_403}`,
  schema: z.object({ error: z.string(), code: z.string().optional() }),
});
const SUPER_403 = forbidden("not a super_admin, or the conveyor priority identity on a write (validateAuth's door, rendered by the handler)");
const DEFAULT: ResponseSpec = { status: 'default', description: "fr's own 500 (`{ error }`), e.g. the database is unreachable.", schema: z.object({ error: z.string() }) };

export const ANDON_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'andon', tag: 'Andon', tenancy: 'platform',
    module: 'src/routes/andon.ts', load: () => import('../../routes/andon'),
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'andon.get', method: 'GET', path: '/api/andon', handler: 'handleGetAndon',
      summary: 'The global andon cord (polled by every signed-in user)', effect: 'read',
      description:
        "A customer tenant (neither a super_admin nor a platform active tenant) gets a neutral released cord in the same " +
        "shape. `live=1` adds the bounded n8n-worker scale probe for a super_admin only (anyone else: `n8n_live` null, never a refusal).",
      input: z.object({ live: z.string().optional().describe("'1' (super_admin only) re-reads the n8n-worker Deployment.") }),
      output: z.object(view),
      rule: routeRule(isAuthenticatedUser),
      responses: [
        ...AUTH,
        { status: 403, description: `\`code\` ${LICENCE_ROUTE_DOOR_403}`, schema: z.object({ error: z.string(), code: z.string() }) },
        DEFAULT,
      ],
    },
    {
      id: 'andon.engage', method: 'POST', path: '/api/andon/engage', handler: 'handleEngageAndon',
      summary: 'Pull the global andon cord: freeze fr work initiation and scale n8n-worker to 0 (super-admin)', effect: 'destructive',
      description:
        'No request body. Idempotent AND self-healing: a re-pull re-issues the scale whenever the worker is not PROVEN at 0 ' +
        '(an unmeasured worker is not a stop), records the new attempt in `worker_replicas`/`worker_scale_error`, and leaves ' +
        '`engaged_at`/`engaged_by` untouched; `already_engaged` is present only when the stop was already measured at 0. ' +
        'A missing `andon_state` singleton is repaired by the pull (it is upserted) instead of being reported as engaged. ' +
        'Scaling the worker to 0 stops ' +
        'EVERY n8n execution — production runs and the editor\'s manual test runs alike, both of which execute on the worker ' +
        '— while the editor, REST API and n8n-mcp stay up. Inbound webhooks are still accepted and QUEUED, not dropped. ' +
        'A failure to reach the API server keeps the fr-side freeze and is reported in `worker_scale_error`.',
      input: z.object({}),
      output: z.object({
        ...view,
        worker_scale_error: z.string().nullable(),
        already_engaged: z.literal(true).optional().describe('Present on a re-pull of an engaged cord (nothing changed).'),
      }),
      responses: [...AUTH, SUPER_403, DEFAULT],
    },
    {
      id: 'andon.disengage', method: 'POST', path: '/api/andon/disengage', handler: 'handleDisengageAndon',
      summary: 'Release the global andon cord, scaling n8n-worker back to 1 (super-admin)', effect: 'write',
      description:
        "No request body. `release_status` 'released_incomplete' when the scale-up did not land (see `worker_scale_error`); " +
        "a repeated release re-issues it. NOTE: 'released' means the API server ACCEPTED the scale-up, not that the worker " +
        'is serving again — the pod still has to start. `n8n_live.available_replicas` is the honest measure. Executions ' +
        'queued while the cord was engaged drain once the worker is back.',
      input: z.object({}),
      output: z.object({
        ...view,
        release_status: z.enum(['released', 'released_incomplete']),
        worker_scale_error: z.string().nullable(),
        cleared_pause_evidence: pauseEvidence.nullable().describe('The actuator attempt being released, captured before the release; null when the cord was not engaged.'),
      }),
      responses: [...AUTH, SUPER_403, DEFAULT],
    },
    {
      id: 'andon.history', method: 'GET', path: '/api/andon/history', handler: 'handleGetAndonHistory',
      summary: 'The last 50 engage / release transitions of the global cord (super-admin)', effect: 'read',
      input: z.object({}),
      output: z.object({
        history: z.array(z.object({ id: z.string(), engaged: z.boolean(), changed_at: isoTime, changed_by: z.string().nullable() })),
      }),
      responses: [...AUTH, forbidden('not a super_admin'), DEFAULT],
    },
    {
      id: 'andon.inflight', method: 'GET', path: '/api/andon/inflight', handler: 'handleGetAndonInflight',
      summary: 'How many n8n executions are still running (the drain after a pull; super-admin)', effect: 'read',
      description: 'Fails open: an n8n failure is `running_count` null with `n8n_error`, never an error status.',
      input: z.object({}),
      output: z.object({ running_count: z.number().int().nullable(), capped: z.boolean(), n8n_error: z.string().nullable() }),
      responses: [...AUTH, forbidden('not a super_admin'), DEFAULT],
    },
  ],
);

// fr-agui P4c part 2 — `GET /api/admin/andon` (routes/andon.ts `handleListAndonState`): the PROJECT and
// STREAM cords across the platform tenants. Same gate as the cord's writes (`requireSuperAdmin`: the
// validateAuth refusals caught, then the super_admin role, 403 'forbidden'). fr row 14c: a project is listed
// only when its own tenant tag is a PLATFORM tenant (an untagged one is excluded), a stream only when its
// `tenant_id` is; a pre-approval project never.
const cord = { andon_engaged: z.boolean(), andon_engaged_at: isoTime.nullable(), andon_engaged_by: z.string().nullable() };

export const ANDON_STATE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'andon', tag: 'Andon', tenancy: 'platform',
    module: 'src/routes/andon.ts', load: () => import('../../routes/andon'),
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'andon.list_state', method: 'GET', path: '/api/admin/andon', handler: 'handleListAndonState', effect: 'read',
      summary: 'Every platform project and stream cord, engaged or not (super-admin)',
      input: z.object({}),
      output: z.object({
        projects: z.array(z.object({ id: z.string(), name: z.string(), shape: z.enum(['deliverable', 'continuous_flow']), ...cord })),
        streams: z.array(
          z.object({ id: z.string(), name: z.string(), kind: z.enum(streamKindEnum.enumValues), tenant_id: z.string(), ...cord }),
        ),
        _by: z.string().describe("The calling super_admin's email."),
      }),
      responses: [...AUTH, forbidden('not a super_admin'), DEFAULT],
    },
  ],
);
