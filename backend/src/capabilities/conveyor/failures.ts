// R311 PR 5 (n8n-workflows design/choices/v4/kanban-coach-errors.md §2.5, §4.1,
// §7 item 5) — the conveyor's two failure callbacks into fr, and the project's
// start-retry surface, declared as capabilities.
//
//   webhooks.n8n_project_start_failed  POST /api/webhooks/n8n/project-start-failed  (licence: project.startFailed)
//   webhooks.n8n_project_coach_failed  POST /api/webhooks/n8n/project-coach-failed  (licence: project.coachFailed)
//       The conveyor seat ONLY (an fr licence token; `licenceOnly`). Never through
//       the registry or the agent: deny-all at that layer, the handler owns its door.
//   projects.conveyor_start_retry      POST /api/projects/:id/conveyor-start/retry
//       The Execution hub's "Retry the conveyor start" button. The project agent
//       reaches it through its own confirm-card action
//       `projects.retry_conveyor_start` (agui/actions/project-execution.ts), which runs THIS route as the human —
//       so the route itself is `out-of-agent-scope` here, exactly like
//       `projects.provision_container` and the `projects.provision` action.
//
// The read (`projects.list_conveyor_notices`) is in capabilities/projects/execution.ts
// with the hub's other reads.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, type Capability, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { frErrorBody, pathId, routeRule } from '../library/_shared';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, unauthorizedBody } from '../account/_shared';

/** These routes never run through the registry or the agent: deny-all at that layer (the handler owns its door). */
const never = { type: 'custom' as const, check: async () => false };
const LICENCE = [{ licenceToken: [] }];

const ERROR_TEXT_MAX = 2000;
const blank = (s: z.ZodTypeAny) => s.optional();
const opaque = (what: string) => z.string().min(1).max(200).describe(what);
const errorText = z.string().min(1).describe(`The failure's text (error.message or description). Clipped to ${ERROR_TEXT_MAX} characters, never refused for length.`);

const startFailedBody = z.object({
  fr_project_id: z.string().uuid().describe("The fr project whose conveyor start failed (the start body's fr_project_id)."),
  rm_project_id: blank(opaque("The RM pm_project id (the start body's rm_project_id); must be the project's when sent. `''` = absent.")),
  execution_id: opaque('The n8n execution id of the FAILED start (trigger.conveyor_start). Idempotency: (fr_project_id, execution_id).'),
  stage: opaque("The failed node's name, or 'unknown'."),
  error_text: errorText,
  idempotency_key: blank(
    z
      .string()
      .max(300)
      .describe("The Idempotency-Key the failed start received (`<fr id>` or `<fr id>:retry-<n>`); binds the notice to that start attempt. `''` = absent."),
  ),
});

const coachFailedBody = z.object({
  fr_project_id: blank(z.string().uuid().describe("The fr project. One of fr_project_id / rm_project_id is required (else 422 `project_required`). `''` = absent.")),
  rm_project_id: blank(opaque("The RM pm_project id (the coach contract's project_id); finds the project when fr_project_id is absent. `''` = absent.")),
  card_id: blank(opaque("The target card the coach could neither act nor comment on. `''` = absent.")),
  flow: opaque('The source flow ($workflow.name of the failed execution).'),
  node: opaque("The source's failed node."),
  error_class: opaque('The computed error class (kanban-coach-errors.md §3.1).'),
  error_text: errorText,
  coach_execution_id: opaque("The coach's own n8n execution id. Idempotency: (licence tenant, coach_execution_id)."),
});

const notice = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['start_failed', 'coach_failed']),
    project_id: z.string().uuid().nullable().describe("null: an unattached coach_failed notice (only an rm_project_id was sent and RM could not resolve it)."),
    execution_id: z.string(),
    idempotency_key: z.string().nullable(),
    rm_project_id: z.string().nullable(),
    card_id: z.string().nullable(),
    flow: z.string().nullable(),
    node: z.string().nullable(),
    error_class: z.string().nullable(),
    error_text: z.string(),
    created_at: z.string(),
    created: z.boolean().describe('false on a replay of the same idempotency key: the stored notice, nobody notified again.'),
  })
  .describe('The stored notice.');

const WEBHOOK_RESPONSES: ResponseSpec[] = [
  { status: 200, description: 'A replay (same idempotency key): the stored notice, `created: false`; nobody is notified again.', schema: z.object({ data: notice }) },
  { status: 401, description: "Not an fr licence token (`error`: 'This route accepts an fr licence token only …', or validateAuth's 401).", schema: frErrorBody },
  { status: 404, description: "`error` 'Project not found': no such project in the licence's tenant (unknown and foreign read the same).", schema: frErrorBody },
  {
    status: 'default',
    description:
      "400 `error.code` 'BAD_REQUEST' (the body is not JSON). 422 `code` 'validation_failed' (`details`: the issues), 'project_required' " +
      "(coach_failed: neither id), 'idempotency_key_mismatch' (start_failed: not one of the project's start keys). " +
      "502/504: the licences service could not verify the token. fr's own 500.",
    schema: frErrorBody,
  },
];

function webhook(s: {
  id: `webhooks.${string}`;
  path: string;
  operationId: string;
  op: string;
  exportName: string;
  summary: string;
  description: string;
  input: z.ZodTypeAny;
}): Capability<unknown, unknown> {
  return defineCapability({
    id: s.id,
    area: 'webhooks',
    summary: s.summary,
    description: s.description,
    http: { method: 'POST', path: s.path, operationId: s.operationId, successStatus: 201 },
    input: s.input,
    output: z.object({ data: notice }),
    errors: [],
    auth: { principal: 'service', rbac: never },
    tenancy: 'tenant',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'service-to-service' },
    licence: { ops: [s.op] },
    openapi: { tags: ['Webhooks'], security: LICENCE, responses: WEBHOOK_RESPONSES },
    legacyHandler: lazyHandler(() => import('../../routes/webhooks/conveyor-failures'), {
      module: 'src/routes/webhooks/conveyor-failures.ts',
      exportName: s.exportName,
    }),
  });
}

export const CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  webhook({
    id: 'webhooks.n8n_project_start_failed',
    path: '/api/webhooks/n8n/project-start-failed',
    operationId: 'n8nProjectStartFailed',
    op: 'project.startFailed',
    exportName: 'handleProjectStartFailed',
    summary: "Record that a project's conveyor start failed after n8n accepted it (`project.start_failed`, R311 §2.5)",
    description:
      "Sent by the conveyor's trigger.conveyor_start `Coach error`, or by its errorWorkflow backstop for a timeout or a crash after the 200. " +
      'Auth: an fr licence token only (the conveyor seat); the project must be in the licence\'s tenant. Idempotent on ' +
      '(fr_project_id, execution_id): both senders may report one failure — the first is 201 and tells every member of the ' +
      "project's tenant (inbox + their channels), a replay is 200 with the stored notice. Record-and-show only: fr decides nothing " +
      "from it and never retries on its own; it OFFERS a member the start retry (POST /api/projects/{id}/conveyor-start/retry), " +
      'which sends `Idempotency-Key: <fr id>:retry-<n>`.',
    input: startFailedBody,
  }),
  webhook({
    id: 'webhooks.n8n_project_coach_failed',
    path: '/api/webhooks/n8n/project-coach-failed',
    operationId: 'n8nProjectCoachFailed',
    op: 'project.coachFailed',
    exportName: 'handleProjectCoachFailed',
    summary: 'Record that the kanban coach could neither act nor comment on a card (`project.coach_failed`, R311 §4.1)',
    description:
      "Sent by cap.kanban_coach.handle_error's `Coach result` when its best-effort `Coach failed by the conveyor:` comment failed too " +
      '(fr is the one channel that depends on neither Planka nor RM). Auth: an fr licence token only; the project (by fr_project_id, ' +
      "with no RM call) must be in the licence's tenant. With ONLY an rm_project_id, fr asks requirements_management for its fr " +
      'project; when RM is down or cannot resolve it the notice is stored UNATTACHED (`project_id` null, the raw ids kept) — never ' +
      "lost. Idempotent on (licence tenant, coach_execution_id): the first is 201 and " +
      "tells every member of the project's tenant, a replay is 200. Record-and-show only: it never triggers anything; the member " +
      'retries by hand (moves or re-runs the card).',
    input: coachFailedBody,
  }),
];

const RETRY_ROUTE = { method: 'POST' as const, path: '/api/projects/:id/conveyor-start/retry' };

export const PROJECT_CONVEYOR_RETRY_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'projects.conveyor_start_retry',
    area: 'projects',
    summary:
      "Retry this project's conveyor start (offered after a recorded start failure, an undelivered start, a failed board link, or a delivered start that made no progress or stalled: \"Start again\")",
    description:
      "Any member of the project's tenant. Offered `no_progress` (R319, \"Start again\") when the latest start was delivered at least " +
      "10 minutes ago and the project's start card is still in TODO on its board (the conveyor re-pulls it: 200 resumed; a start card " +
      'that has left TODO is refused 409 psra_exists, recorded as refused_by_conveyor). Offered `stalled` (R320, behind ' +
      'CONVEYOR_START_STALLED_RETRY, default off) when the start card sits in READY or DOING and neither its list nor the latest ' +
      'start answer changed for 30 minutes, no approval is pending on it and the project is not on hold; the conveyor answers ' +
      '200 restarted or 200 running (recorded on the attempt). A stalled restart the conveyor did not make (409 psra_exists or ' +
      "200 duplicate, the answers before R320) reads `restart_not_done` with `details.message` (the member's text) and is offered " +
      'again after another 30 minutes. Refused 409 `conveyor_retry_not_offered` ' +
      '(`details.reason`: start_in_flight | started | on_hold (the project is on hold) | restart_not_done | ' +
      'conveyor_not_configured | no_start_recorded | start_request_invalid | refused_by_conveyor, the last with `details.code` and ' +
      "`details.message`, the member's text) unless GET /api/projects/{id}/conveyor-notices offers it (`retry.available`). " +
      'Under the project lock it records attempt n and sends the start with `Idempotency-Key: <fr id>:retry-<n>` (n8n has never ' +
      "seen that key): first the project's board link in requirements_management (idempotent when unchanged), then the start webhook, " +
      'detached — 202 with the attempt; its outcome is recorded on it. No request body (or `{}`) = this start retry. ' +
      'RESTART (George 2026-10-31; R349 2026-11-04): a body `{scope: \'project\', comment?}` or `{scope: \'phase\', phase, comment?}` restarts the whole project or ' +
      "ONE requirements_management phase — the current one or an earlier one (GET conveyor-notices `restart.phases`) — and the conveyor runs EVERY card in that scope again, finished ones included. " +
      "`comment` (trimmed, at most 2000 characters) is the member's note to steer the run, forwarded as written. " +
      'Offered for any active, undelivered project (GET conveyor-notices `restart`); refused 409 `conveyor_restart_not_offered` ' +
      '(`details.reason`: not_active | delivered | not_on_conveyor | conveyor_not_configured | on_hold | start_in_flight), 409 `restart_phase_unknown` (no RM ' +
      "phase), 409 `restart_phase_invalid` (scope phase without a phase, or a phase that is not the current one or earlier: `details.phase` = the current phase, `details.allowed`). It reads the RM " +
      'phase fresh (the type\'s phase order from fr\'s project-type catalogue cache), records attempt n with `Idempotency-Key: <fr id>:restart-<n>`, withdraws (voids) the conveyor\'s open questions on this project, plus open requests about its cards ' +
      '(reason "project restarted …"; a failed void sends nothing), then sends the start with `restart: {scope, phase?, comment?}` in its body.',
    http: { ...RETRY_ROUTE, operationId: 'projectsConveyorStartRetry', successStatus: 202 },
    input: z.object({
      id: pathId('Project id (a uuid; a malformed id is the same 404 as an absent project)'),
      scope: z
        .enum(['project', 'phase'])
        .optional()
        .describe("Absent = the start retry. 'project' = restart the whole project; 'phase' = restart one phase (the current one or earlier)."),
      phase: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('With scope phase (required): the phase to restart, the current one or earlier; anything else is 409 restart_phase_invalid.'),
      comment: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe("A restart only: the member's optional comment to steer the restarted run (trimmed; sent to the conveyor as written)."),
    }),
    output: z.object({
      data: z.object({
        project_id: z.string().uuid(),
        attempt_n: z.number().int().min(1),
        idempotency_key: z.string().describe('`<fr id>:retry-<n>`, or `<fr id>:restart-<n>` for a restart'),
        offered_because: z.enum(['start_failed', 'no_board_link', 'not_delivered', 'no_progress', 'stalled']).optional(),
        restart: z
          .object({ scope: z.enum(['project', 'phase']), phase: z.string().nullable(), comment: z.string().nullable() })
          .optional()
          .describe('A restart: its scope, (scope phase) the RM phase restarted, and the comment sent (null when none).'),
        voided_asks: z.number().int().min(0).optional().describe("A restart: how many of the conveyor's open questions on this project, plus open requests about its cards, it withdrew."),
        status: z.literal('pending'),
      }),
    }),
    errors: [],
    auth: { principal: 'user', rbac: routeRule(isAuthenticatedUserInResolvedTenant)(RETRY_ROUTE) },
    tenancy: 'project',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: {
      tags: ['Projects'],
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        { status: 404, description: "`error` 'Project not found' (absent, malformed id, or not a project of the request tenant).", schema: frErrorBody },
        {
          status: 409,
          description:
            "`code` 'conveyor_retry_not_offered' (`details.reason`), 'conveyor_start_in_progress' (another retry is being recorded), " +
            "'rm_project_missing', 'board_missing', 'project_tenant_unknown', 'project_archived'; a restart also " +
            "'conveyor_restart_not_offered' (`details.reason`), 'restart_phase_unknown', 'restart_phase_invalid', and the RM type " +
            "errors 'project_type_missing' / 'project_type_not_in_catalogue' for a phase restart. Nothing was sent.",
          schema: frErrorBody,
        },
        {
          status: 'default',
          description: `${DOOR_403} The board read failing: Planka's status mapped (400, 401, 403, 429, 502). fr's own 500.`,
          schema: frErrorBody,
        },
      ],
    },
    legacyHandler: lazyHandler(() => import('../../routes/project-conveyor-start'), {
      module: 'src/routes/project-conveyor-start.ts',
      exportName: 'handleRetryProjectConveyorStart',
    }),
  }),
];
