// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: the n8n execution reads
// (routes/tools/n8n.ts), the inbound intake webhook (routes/intake-webhook.ts) and the frontend
// error sink (routes/client-errors.ts), re-expressed with NO behaviour change (`legacyHandler`).
// None had an operation in the served spec (LEGACY_UNDECLARED): every one is a NEW operation,
// operationId = camelCase(id), not agent-exposed, and none is on the licence route allowlist.
//
// Auth (the handlers', unchanged):
//   * the execution reads: validateAuth; a caller's own project executions, the PRODUCTION
//     workflow ids / trace links only for a platform caller (`canReadProductionWorkflows`).
//   * `POST /api/intake/webhook/:id`: NO bearer — the enabled trigger's id IS the shared secret
//     (an unknown or disabled id is 404); when the trigger names a secret, an HMAC-SHA256 of the raw
//     body in `x-hmac-sha256` / `x-hub-signature-256` (missing or wrong: 400). A webhook caller,
//     `x-internal` (not a typed-client op).
//   * `POST /api/client-errors`: NO auth by design (an error during login / first paint is the one
//     that matters); a per-client rate limit, a streamed 64 KiB body cap and a field allow-list
//     replace it. It touches no database and never 500s.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUser } from '../rbac-rules';
import { DOOR_403, LICENCE_DOOR_403_TEXT, VALIDATE_AUTH_401, doorBody, frErrorBody, neverThroughRegistry, pathId, platformCapabilities, routeRule, unauthorizedBody } from './_shared';

const STATUS_VALUES = ['canceled', 'error', 'running', 'success', 'waiting'] as const;

const N8N_DEFAULT =
  "400: `error.code` 'BAD_REQUEST' ('Invalid query: …'). " +
  DOOR_403 +
  " Any other status is n8n's, relayed in the integration envelope (`error.code` 'UPSTREAM_…'), or fr's own 500.";

const execution = z
  .object({
    id: z.string(),
    workflow_id: z.string().nullable().optional().describe('null when redacted: a customer never receives a PRODUCTION workflow id.'),
    status: z.string().optional(),
    mode: z.string().optional(),
    started_at: z.string().optional(),
    stopped_at: z.string().optional(),
    duration_ms: z.number().optional(),
    project_id: z.string(),
    initiated_via: z.string(),
    correlation_id: z.string(),
    trace_url: z.string().nullable().describe('null when redacted (platform-internal).'),
  })
  .passthrough();

export const INBOUND_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...platformCapabilities(
    { area: 'tools', tag: 'Workflows', tenancy: 'self', rule: routeRule(isAuthenticatedUser), module: 'src/routes/tools/n8n.ts', load: () => import('../../routes/tools/n8n') },
    [
      {
        id: 'tools.list_n8n_executions', method: 'GET', path: '/api/tools/n8n/executions', handler: 'handleListExecutions', effect: 'read',
        summary: "n8n executions of the caller's projects (paged)",
        input: z.object({
          limit: z.coerce.number().int().min(1).max(250).optional(),
          cursor: z.string().min(1).optional(),
          status: z.enum(STATUS_VALUES).optional(),
          projectId: z.string().min(1).optional(),
          workflowId: z.string().min(1).optional(),
        }),
        output: z.object({ data: z.array(execution), meta: z.unknown() }),
        responses: [
          { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
          { status: 'default', description: N8N_DEFAULT, schema: frErrorBody },
        ],
      },
      {
        id: 'tools.get_n8n_execution', method: 'GET', path: '/api/tools/n8n/executions/:id', handler: 'handleGetExecution', effect: 'read',
        summary: "One n8n execution in the caller's scope",
        input: z.object({ id: pathId('The n8n execution id') }),
        output: z.object({ data: execution }),
        responses: [
          { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
          { status: 'default', description: "404: `error.code` 'UPSTREAM_NOT_FOUND' (not in the caller's scope). " + N8N_DEFAULT, schema: frErrorBody },
        ],
      },
    ],
  ),
  ...platformCapabilities(
    {
      area: 'webhooks', tag: 'Webhooks', tenancy: 'tenant', principal: 'webhook', agentReason: 'service-to-service', internal: true,
      rule: neverThroughRegistry, module: 'src/routes/intake-webhook.ts', load: () => import('../../routes/intake-webhook'),
    },
    [
      {
        id: 'webhooks.intake_trigger', method: 'POST', path: '/api/intake/webhook/:id', handler: 'handleIntakeWebhook', effect: 'write',
        summary: "Inbound records for an `n8n_webhook` scheduled trigger (mapped and dispatched like the trigger's cron tick)",
        description:
          "No bearer: the trigger id IS the shared secret. The trigger's payload mapper runs over the JSON body and each " +
          'record is dispatched (deduplicated with the cron tick). 200 `{ accepted, skipped }`; nothing accepted because ' +
          'every record was already seen: 409 `{ skipped }`; nothing got through because dispatch failed: 502 ' +
          '`{ accepted, skipped, failed, error }`.',
        security: [],
        input: z.object({ id: pathId('The scheduled trigger id (an enabled `n8n_webhook` trigger)') }).passthrough(),
        output: z.object({ accepted: z.number().int(), skipped: z.number().int() }),
        responses: [
          {
            status: 'default',
            description:
              "404: `error` 'Trigger not found' (unknown or disabled). 400: `error` 'Invalid JSON body', 'Missing HMAC signature " +
              "header', 'HMAC signature mismatch' or the secret could not be read. 409: every record already seen " +
              '(`{ skipped }`). 502: dispatch failed for every record (`{ accepted, skipped, failed, error }`). ' +
              LICENCE_DOOR_403_TEXT +
              " 500: fr's own (`error`).",
            schema: z.object({}).passthrough(),
          },
        ],
      },
    ],
  ),
  ...platformCapabilities(
    {
      area: 'client_errors', tag: 'Client Errors', tenancy: 'platform', principal: 'public', agentReason: 'transport',
      rule: neverThroughRegistry, module: 'src/routes/client-errors.ts', load: () => import('../../routes/client-errors'),
    },
    [
      {
        id: 'client_errors.report', method: 'POST', path: '/api/client-errors', handler: 'handleClientErrors', effect: 'write', successStatus: 202,
        summary: 'Report a batch of frontend errors (logged as structured lines; no database)',
        description:
          'Unauthenticated by design. At most 25 events per batch are honoured (the rest count as rejected); only allow-listed ' +
          'fields are logged. Never answers 500.',
        security: [],
        input: z
          .object({
            events: z.array(z.object({}).passthrough()).describe('The error events (unknown keys are dropped, never logged).'),
            session_id: z.string().optional(),
            dropped: z.number().optional(),
            dropped_third_party: z.number().optional(),
          })
          .passthrough(),
        output: z.object({ accepted: z.number().int(), rejected: z.number().int(), dropped: z.number().int(), dropped_third_party: z.number().int() }),
        responses: [
          {
            status: 400,
            description: "`error`: 'invalid_body' (unreadable), 'invalid_json' (not JSON) or 'invalid_payload' (not an object with an `events` array).",
            schema: z.object({ error: z.string() }),
          },
          { status: 403, description: LICENCE_DOOR_403_TEXT, schema: doorBody },
          { status: 413, description: "`error` 'payload_too_large' (`max_bytes`: 65536, enforced while streaming).", schema: z.object({ error: z.string(), max_bytes: z.number() }) },
          { status: 429, description: "`error` 'rate_limited' (header `Retry-After`).", schema: z.object({ error: z.string() }) },
        ],
      },
    ],
  ),
];
