// Cockpit A5 / R-CK5 (migration 213) — the n8n execution hook's ingest into fr, declared as a
// capability:
//
//   internal.ingest_conveyor_flow_runs  POST /api/internal/conveyor/flow-runs
//       A Keycloak CLIENT-CREDENTIALS service account only (routes/internal-conveyor-flow-runs.ts
//       `requireFlowRunWriter`). Never through the registry or the agent: deny-all at that layer,
//       the handler owns its door. Not on the licence route allowlist.
//
// The project's read (`projects.list_flow_runs`) is in capabilities/projects/execution.ts with
// the Execution hub's other reads.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, LICENCE_ROUTE_DOOR_ERROR, type Capability } from '../define';
import { lazyHandler } from '../lazy';

/** Never through the registry or the agent (the handler owns its door). */
const never = { type: 'custom' as const, check: async () => false };

export const CONVEYOR_FLOW_RUN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'internal.ingest_conveyor_flow_runs',
    area: 'internal',
    summary: 'The n8n execution hook reports conveyor flow runs (cockpit R-CK5)',
    description:
      'Keycloak CLIENT-CREDENTIALS bearer only: issuer in FR_FLOW_RUN_ISSUER (default KEYCLOAK_ISSUER), a service ' +
      'account, `azp` in FR_FLOW_RUN_WRITER_AZP (unset ⇒ 503 `flow_run_ingest_unconfigured`; a user token ⇒ 403 ' +
      '`service_account_required`; another client ⇒ 403 `flow_run_writer_forbidden`). Body: one record, an array of ' +
      'at most 200, or `{records}`; a record is `{execution_id, status: running|success|error|waiting|canceled|crashed, ' +
      'n8n_status? (n8n\'s own final status), workflow_id?, workflow_name? (alias workflow), card_id?, project_ref? (alias project_id: an fr project id or an RM ' +
      'pm_project id), started_at?, stopped_at?, failed_node?, error_class?, error_message? (clipped to 2000), retry_of?, ' +
      'parent_execution_id?}`. Upsert on execution_id; a running/waiting record never overwrites a terminal status. ' +
      '200 `{data:{received, inserted, updated, kept_terminal, rejected[], failed[]}}` — a bad record is counted, never ' +
      'a 500. 400 `invalid_body` / `empty_batch`, 413 `batch_too_large`, 503 `flow_run_write_failed` when no valid ' +
      'record could be written.',
    http: { method: 'POST', path: '/api/internal/conveyor/flow-runs', operationId: 'internalIngestConveyorFlowRuns' },
    input: z.object({}).passthrough(),
    output: z.object({}).passthrough(),
    errors: [
      { status: 400, code: 'invalid_body' },
      { status: 401, code: 'unauthorized' },
      { status: 403, code: 'service_account_required' },
      LICENCE_ROUTE_DOOR_ERROR,
      { status: 413, code: 'batch_too_large' },
      { status: 503, code: 'flow_run_ingest_unconfigured' },
    ],
    auth: { principal: 'service', rbac: never },
    tenancy: 'tenant',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'service-to-service' },
    openapi: { tags: ['Internal'], security: [{ bearerAuth: [] }], internal: true },
    legacyHandler: lazyHandler(() => import('../../routes/internal-conveyor-flow-runs'), {
      module: 'src/routes/internal-conveyor-flow-runs.ts',
      exportName: 'handleIngestConveyorFlowRuns',
    }),
  }),
];
