// fr-agui SPEC §13 P4b (part 2) — spec drain: `/api/scheduled-triggers`
// (routes/scheduled-triggers.ts), the cron-driven inbound work pulls, re-expressed
// with NO behaviour change (`legacyHandler`). Gates: schedules/_shared.ts.
//
//   * every route — the list included (SEC-b: it used to key on `user.tenantId`,
//     the JWT HOME tenant, so a super-admin switched with `X-Active-Tenant` listed
//     their home tenant's triggers) — resolves `ctxTenantId` first:
//     `isAuthenticatedUserInResolvedTenant`.
//   * create additionally requires `project_id` to be a `continuous_flow` project of
//     the request tenant (404 / 422 shape_mismatch), then the dept-manager gate.
//
// No secret travels here: a connector config names a secret by `secret_id` (a
// reference to the caller's user_secrets row), never by value.
import { z } from 'zod';

import { CardTemplateSchema, ScheduledTriggerCreateSchema, ScheduledTriggerPatchSchema, SourceConnectorEnum } from '../../routes/scheduled-triggers-schemas';
import type { ResponseSpec } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, pathId, routeRule, settingsCapabilities, unauthorizedBody, type SettingsRoute } from '../settings/_shared';
import { NO_TENANT_500, RESOURCE_403, fr4xxBody, isoTime, runList, runsLimit } from './_shared';

const MODULE = { module: 'src/routes/scheduled-triggers.ts', load: () => import('../../routes/scheduled-triggers') };

const id = z.object({ id: pathId('Scheduled trigger id (a uuid; anything else is the same 404 as an absent row)') });

/** A `scheduled_triggers` row, `last_run_error` reduced to client-safe text. */
export const scheduledTrigger = z.object({
  id: z.string(),
  tenant_id: z.string(),
  project_id: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  source_connector: SourceConnectorEnum,
  connector_config: z.record(z.unknown()),
  payload_mapper: z.record(z.string()),
  target_list: z.string(),
  card_template: CardTemplateSchema.passthrough(),
  enabled: z.boolean(),
  last_run_at: isoTime.nullable(),
  last_run_status: z.enum(['ok', 'error', 'no_new_records', 'skipped_no_connector', 'config_invalid', 'partial_failure']).nullable(),
  last_run_error: z.string().nullable(),
  permanent_failure_count: z.number().int(),
  disabled_reason: z.string().nullable(),
  from_suggestion_id: z.string().nullable(),
  origin_kind: z.string(),
  origin_project_id: z.string().nullable(),
  origin_workflow_run_id: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});

const NOT_FOUND = "404: `error` 'Scheduled trigger not found' (absent, malformed id, or another tenant's).";
const BODY_400 =
  "400: `error` 'invalid JSON body', a cron that does not parse in its timezone, " +
  "\"source_connector '…' is not available\", 'connector_config invalid: …' or 'payload_mapper invalid: …'.";

const responses = (o: { body?: 'create' | 'patch'; row?: boolean; resource?: boolean }): ResponseSpec[] => [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      (o.body !== undefined ? `${BODY_400} ` : '') +
      (o.body === 'create'
        ? "422: `error` 'Validation error' (the body fails the schema, e.g. an unknown key such as `tenant_id`; `details`), " +
          "or 'scheduled_intake triggers require project.shape = continuous_flow' (`details.code` shape_mismatch). " +
          "404: `error` 'project_id does not exist' (absent, or another tenant's). "
        : '') +
      (o.body === 'patch'
        ? "422: `error` '<field> cannot be changed' (`project_id` / `tenant_id` / `id` in the body; `details.code` immutable_field), " +
          "or 'Validation error' (`details`). "
        : '') +
      (o.row ? `${NOT_FOUND} ` : '') +
      (o.resource ? `${RESOURCE_403} ` : '') +
      `${DOOR_403} ${NO_TENANT_500}`,
    schema: fr4xxBody,
  },
];

const ROUTES: SettingsRoute[] = [
  {
    id: 'scheduled_triggers.create', method: 'POST', path: '/api/scheduled-triggers', handler: 'handleCreateScheduledTrigger',
    summary: 'Create a scheduled intake trigger on a continuous-flow project', effect: 'write', successStatus: 201,
    description: 'Requires a workspace-admin of the request tenant, or a dept-manager of the project\'s department.',
    input: ScheduledTriggerCreateSchema, output: scheduledTrigger,
    responses: responses({ body: 'create', resource: true }),
  },
  {
    id: 'scheduled_triggers.list', method: 'GET', path: '/api/scheduled-triggers', handler: 'handleListScheduledTriggers',
    summary: "The request tenant's scheduled triggers the caller may see", effect: 'read',
    description:
      "Keyed by the request tenant (a super-admin's accepted workspace switch, else the JWT tenant). A workspace-admin of it " +
      "sees every trigger; anyone else only those whose project is in a " +
      'department it belongs to. `project_id` narrows the list (a project the caller cannot see is an empty list, never a 403).',
    input: z.object({ project_id: z.string().optional().describe('Only this project\'s triggers.') }),
    output: z.object({ items: z.array(scheduledTrigger), total: z.number().int() }),
    responses: responses({}),
  },
  {
    id: 'scheduled_triggers.get', method: 'GET', path: '/api/scheduled-triggers/:id', handler: 'handleGetScheduledTrigger',
    summary: 'One scheduled trigger of the request tenant', effect: 'read',
    input: id, output: scheduledTrigger, responses: responses({ row: true, resource: true }),
  },
  {
    id: 'scheduled_triggers.update', method: 'PATCH', path: '/api/scheduled-triggers/:id', handler: 'handlePatchScheduledTrigger',
    summary: 'Update a scheduled trigger (re-enabling clears its auto-disable ledger)', effect: 'write',
    input: ScheduledTriggerPatchSchema.extend(id.shape), output: scheduledTrigger, responses: responses({ body: 'patch', row: true, resource: true }),
  },
  {
    id: 'scheduled_triggers.delete', method: 'DELETE', path: '/api/scheduled-triggers/:id', handler: 'handleDeleteScheduledTrigger',
    summary: 'Delete a scheduled trigger', effect: 'destructive', successStatus: 204,
    input: id, output: z.null(), responses: responses({ row: true, resource: true }),
  },
  {
    id: 'scheduled_triggers.run_now', method: 'POST', path: '/api/scheduled-triggers/:id/run-now', handler: 'handleRunNowScheduledTrigger',
    summary: 'Fire a scheduled trigger now (records a manual run)', effect: 'write',
    description: "Records a `kind: manual` run with status 'skipped_no_connector'; no connector runs from this route.",
    input: id, output: z.object({ ok: z.literal(true), status: z.literal('skipped_no_connector') }),
    responses: responses({ row: true, resource: true }),
  },
  {
    id: 'scheduled_triggers.list_runs', method: 'GET', path: '/api/scheduled-triggers/:id/runs', handler: 'handleListScheduledTriggerRuns',
    summary: "A scheduled trigger's run audit log, newest first", effect: 'read',
    input: id.extend({ limit: runsLimit }), output: runList, responses: responses({ row: true, resource: true }),
  },
];

export const SCHEDULED_TRIGGER_CAPABILITIES = settingsCapabilities(
  { area: 'scheduled_triggers', tag: 'Scheduled Triggers', tenancy: 'tenant', ...MODULE, rule: routeRule(isAuthenticatedUserInResolvedTenant) },
  ROUTES,
);
