// tests/unit/capabilities/schedules-operate-capabilities.test.ts
//
// fr-agui SPEC §13 P4b part 2 — spec drain: scheduled triggers / reports, the
// suggestion-inbox actions, three reports, the worker registry and the n8n workflow
// browsers. The routes the P4b-part-1 base (06d5ecc07) pinned in
// GRANDFATHERED_UNDECLARED under those groups are declared as capabilities
// (src/capabilities/{schedules,operate}/*) with NO behaviour change. Pinned here:
//
//   * the NEW set is EXACTLY the former pins, each on the handler the route table used;
//   * tenancy, agent exclusion (the two n8n render-workflow callbacks are
//     service-to-service), operationId = camelCase(id);
//   * licence: none of these routes is on the licence allowlist;
//   * 🔐 the worker `api_key_override` / `base_url_override` / `mcp_config` are declared secret inputs
//     (create / update) and secret outputs of GET only;
//   * the declared inputs ARE the routes' schemas where fr validates the body, and the
//     upstream's END-TO-END types where fr forwards it verbatim (the worker bodies):
//     typed, so a generated client sends numbers / objects, `.passthrough()` kept;
//   * no router.add row is left for them; GET /api/tenant/members is re-tagged 'Tenant'.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { parseListWorkersParams } from '../../../src/integrations/workers';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import * as triggerSchemas from '../../../src/routes/scheduled-triggers-schemas';
import * as triggerShared from '../../../src/routes/scheduled-triggers-shared';
import { ALL, byId } from './p4b2-fixtures';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4b-part-2 pins of check-route-spec-coverage.ts @ 06d5ecc07. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['DELETE', '/api/assets/workers/{name}', 'handleDeleteWorker'],
  ['DELETE', '/api/scheduled-triggers/{id}', 'handleDeleteScheduledTrigger'],
  ['GET', '/api/assets/workers', 'handleListWorkers'],
  ['GET', '/api/assets/workers/providers', 'handleListWorkerProviders'],
  ['GET', '/api/assets/workers/providers/{provider}/models', 'handleListWorkerProviderModels'],
  ['GET', '/api/assets/workers/{name}', 'handleGetWorker'],
  ['GET', '/api/reports/approval-backlog', 'handleApprovalBacklogReport'],
  ['GET', '/api/reports/asset-changes/{assetType}', 'handleAssetChangesReport'],
  ['GET', '/api/reports/worker-activity/{workerId}', 'handleWorkerActivityReport'],
  ['GET', '/api/scheduled-triggers', 'handleListScheduledTriggers'],
  ['GET', '/api/scheduled-triggers/{id}', 'handleGetScheduledTrigger'],
  ['GET', '/api/scheduled-triggers/{id}/runs', 'handleListScheduledTriggerRuns'],
  ['GET', '/api/tools/n8n/workflows', 'handleListWorkflows'],
  // server.ts imported these three under aliases (handleListWorkflowsViewer, …); the module exports:
  ['GET', '/api/workflows', 'handleList'],
  ['GET', '/api/workflows/tags', 'handleTags'],
  ['GET', '/api/workflows/{id}', 'handleGet'],
  ['PATCH', '/api/scheduled-triggers/{id}', 'handlePatchScheduledTrigger'],
  ['POST', '/api/assets/workers', 'handleCreateWorker'],
  ['POST', '/api/assets/workers/chat/completions', 'handleWorkerChatCompletions'],
  ['POST', '/api/assets/workers/{name}/message', 'handleSendWorkerMessage'],
  ['POST', '/api/scheduled-triggers', 'handleCreateScheduledTrigger'],
  ['POST', '/api/scheduled-triggers/{id}/run-now', 'handleRunNowScheduledTrigger'],
  // Registered through pure delegation arrows `(req, id) => handleX(req, id)`: the same function.
  ['POST', '/api/suggested-schedules/{id}/accept', 'handleAcceptSuggestedSchedule'],
  ['POST', '/api/suggested-schedules/{id}/dismiss', 'handleDismissSuggestedSchedule'],
  ['PUT', '/api/assets/workers/{name}', 'handleUpdateWorker'],
];

const p4b2 = CAPABILITIES.filter((e) => e.file.startsWith('src/capabilities/schedules/') || e.file.startsWith('src/capabilities/operate/'));
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;

describe('P4b part 2 — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    expect(p4b2.map((e) => e.cap.id).sort()).toEqual(ALL.map((c) => c.id).sort());
    const declared = p4b2.map((e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const);
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
    for (const { cap: c } of p4b2) expect(c.openapi?.frozen).toBeUndefined();
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4b2) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(`${c.id} ${ref.module}#${ref.exportName}: function`);
    }
  });

  test('tenancy, agent exclusion, principal; operationId = camelCase(id)', () => {
    for (const { cap: c } of p4b2) {
      const tenancy = c.area === 'workflows' || c.area === 'tools' ? 'platform' : 'tenant';
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal} ${c.http.operationId}`).toBe(
        `${c.id} ${tenancy} {"expose":false,"reason":"out-of-agent-scope"} user ${camel(c.id)}`,
      );
    }
  });

  test('no path parameter names a project (the project-scoped siblings stay pinned for P2)', () => {
    for (const { cap: c } of p4b2) expect(c.http.path!).not.toMatch(/project/i);
  });

  test('the routes are no longer router.add rows (deriveRouter registers them); their pinned siblings stay', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    const tools = readFileSync(join(BACKEND, 'src/routes/tools/index.ts'), 'utf8');
    for (const { cap: c } of p4b2) {
      const re = new RegExp(`router\\.add\\(\\s*'${c.http.method}',\\s*'${c.http.path!.replace(/[/-]/g, '\\$&')}'`);
      expect(`${c.id} ${re.test(server) || re.test(tools)}`).toBe(`${c.id} false`);
    }
    for (const m of ["'./routes/assets/workers'", "'./routes/workflows'", "'./routes/scheduled-triggers'"]) {
      expect(server).not.toContain(`from ${m}`);
    }
    // P4d-2a declared the two project-scoped siblings (capabilities/projects/project-routes.ts).
    expect(server).toContain('// GET /api/reports/project-status/:projectId is capability-derived (P4d-2a');
    expect(server).toContain('// GET /api/projects/:projectId/suggested-schedules is capability-derived (P4d-2a');
    // P4d-2d declared the execution reads too (capabilities/platform/inbound.ts): tools/index.ts registers no route.
    expect(tools).not.toContain('router.add(');
    expect(tools).toContain("import './n8n';");
  });

  test("effects: GETs read; deletes destructive; success statuses are the handlers' own", () => {
    for (const { cap: c } of p4b2) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm} ${c.http.successStatus}`).toBe(`${c.id} destructive card-typed 204`);
      if (c.http.method !== 'GET' && c.http.method !== 'DELETE') expect(`${c.id} ${c.effect}`).toBe(`${c.id} write`);
    }
    const non200 = Object.fromEntries(p4b2.filter((e) => e.cap.http.successStatus !== undefined && e.cap.http.method !== 'DELETE').map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(non200).toEqual({
      'scheduled_triggers.create': 201,
      'suggested_schedules.accept': 201,
      'workers.create': 201,
    });
  });
});

describe('P4b part 2 — licence: none of these routes is allowlisted', () => {
  test('no route here is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4b2) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4b part 2 — 🔐 secrets, and inputs', () => {
  test("the worker's three secret-bearing fields are the only secrets: inputs of create / update, outputs of GET only", () => {
    const keys = ['mcp_config', 'base_url_override', 'api_key_override'];
    const inputs = Object.fromEntries(p4b2.filter((e) => e.cap.secrets?.input).map((e) => [e.cap.id, e.cap.secrets!.input]));
    expect(inputs).toEqual({ 'workers.create': keys.map((k) => `/${k}`), 'workers.update': keys.map((k) => `/${k}`) });
    const outputs = Object.fromEntries(p4b2.filter((e) => e.cap.secrets?.output).map((e) => [e.cap.id, e.cap.secrets!.output]));
    // create / update: worker_management answers with echo_overrides=False (always null), so no secret output.
    expect(outputs).toEqual({ 'workers.get': keys.map((k) => `/data/${k}`) });
  });

  test('the message body is strict (MessageRequest is extra="forbid"); the create / update and chat bodies pass extras through', () => {
    const ap = (id: string) => (extractJsonSchema(byId(id).input) as { additionalProperties?: unknown }).additionalProperties;
    expect(ap('workers.send_message')).toBe(false);
    expect(byId('workers.send_message').input.safeParse({ name: 'w1', message: 'hi', bogus: 1 }).success).toBe(false);
    for (const id of ['workers.create', 'workers.update', 'workers.chat_completions']) expect(`${id} ${ap(id) === false}`).toBe(`${id} false`);
  });

  test("the shared schemas ARE the routes' (moved to side-effect-free modules; the old imports still resolve)", () => {
    expect(byId('scheduled_triggers.create').input).toBe(triggerSchemas.ScheduledTriggerCreateSchema);
    expect(triggerShared.ScheduledTriggerCreateSchema).toBe(triggerSchemas.ScheduledTriggerCreateSchema);
    expect(triggerShared.CardTemplateSchema).toBe(triggerSchemas.CardTemplateSchema);
    // PATCH: the route's strict schema plus the path id.
    expect(byId('scheduled_triggers.update').input.safeParse({ id: 'x', name: 'n' }).success).toBe(true);
    expect(byId('scheduled_triggers.update').input.safeParse({ id: 'x', project_id: 'p' }).success).toBe(false);
  });

  test('the worker bodies fr forwards verbatim: typed END-TO-END (worker_management models), unknown keys kept', () => {
    const create = byId('workers.create').input;
    expect(create.safeParse({ worker_name: 'w', temperature: 0.5, max_tokens: 10, output_schema: { type: 'object' }, mcp_config: 'preset', future_field: 1 }).success).toBe(true);
    for (const bad of [{}, { worker_name: '' }, { worker_name: 'w', temperature: '0.5' }, { worker_name: 'w', max_tokens: 20000 }, { worker_name: 'w', tool_names: 'a,b' }, { worker_name: 'w', output_schema: '{}' }]) {
      expect(`${JSON.stringify(bad)} ${create.safeParse(bad).success}`).toBe(`${JSON.stringify(bad)} false`);
    }
    const msg = byId('workers.send_message').input;
    expect(msg.safeParse({ name: 'w', message: 'hi', context: { a: 1 }, work_tier: 'small' }).success).toBe(true);
    expect(msg.safeParse({ name: 'w', message: [{ type: 'text', text: 'hi' }] }).success).toBe(true);
    expect(msg.safeParse({ name: 'w', message: 'hi', context: '{"a":1}' }).success).toBe(false);
    const chat = byId('workers.chat_completions').input;
    expect(chat.safeParse({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }).success).toBe(true);
    expect(chat.safeParse({ provider: 'p', model: 'm', messages: [] }).success).toBe(false);
    // The worker list page: what parseListWorkersParams accepts, the declaration accepts (as numbers).
    expect(parseListWorkersParams(new URLSearchParams('limit=5&offset=0'))).toEqual({ limit: 5, offset: 0 });
    expect(byId('workers.list').input.safeParse({ limit: 5, offset: 0 }).success).toBe(true);
  });
});

describe('P4b part 2 — the served spec', () => {
  test('every NEW operation is tagged with a declared tag; the forwarded worker body keeps its types; members are Tenant', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    type Js = { type?: string; nullable?: boolean; additionalProperties?: unknown; properties?: Record<string, Js>; items?: Js; anyOf?: Js[]; minimum?: number; maximum?: number };
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, { tags: string[]; operationId: string; requestBody?: { content: Record<string, { schema: Js }> }; parameters?: Array<{ name: string; in: string; schema: Js }>; 'x-internal'?: boolean }>>;
    for (const { cap: c } of p4b2) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags.length).toBe(1);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
      expect(`${c.id} ${op['x-internal'] === true}`).toBe(`${c.id} false`);
    }
    const create = paths['/api/assets/workers']!.post!.requestBody!.content['application/json']!.schema;
    expect(create.additionalProperties).toBe(true);
    expect(create.properties!.temperature).toMatchObject({ type: 'number', minimum: 0, maximum: 2, nullable: true });
    expect(create.properties!.max_tokens).toMatchObject({ type: 'integer', minimum: 1, maximum: 16384, nullable: true });
    expect(create.properties!.output_schema).toMatchObject({ type: 'object', nullable: true });
    expect(create.properties!.tool_names).toMatchObject({ type: 'array', items: { type: 'string' } });
    const chat = paths['/api/assets/workers/chat/completions']!.post!.requestBody!.content['application/json']!.schema;
    expect(chat.properties!.messages).toMatchObject({ type: 'array' });
    expect(chat.properties!.stream).toMatchObject({ type: 'boolean' });
    // GET inputs are query parameters with their types.
    const list = paths['/api/assets/workers']!.get!.parameters!;
    expect(list.find((p) => p.name === 'limit')).toMatchObject({ in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } });
    // A POST that takes no body (run-now, accept, dismiss) declares none.
    for (const p of ['/api/scheduled-triggers/{id}/run-now', '/api/suggested-schedules/{id}/accept', '/api/suggested-schedules/{id}/dismiss']) {
      expect(`${p} ${paths[p]!.post!.requestBody === undefined}`).toBe(`${p} true`);
    }
    expect(paths['/api/tenant/members']!.get!.tags).toEqual(['Tenant']);
  });
});
