// tests/unit/capabilities/derive-openapi.test.ts
//
// fr-agui SPEC §3.4 (b) / §3.6 — the served spec is DERIVED: the non-path document
// (capabilities/spec-document.ts) with every capability's operation placed in the order of the
// committed lock (capabilities/served-spec.lock.json). P4d-2e deleted the hand-written
// openapi.ts literal; the byte-level proof that nothing moved is now the lock guard
// (scripts/check-served-spec.ts, one sha256 per served operation), and the frozen operations
// are still pinned verbatim below.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { openapiSpec, SERVED_SPEC_ORDER } from '../../../src/capabilities/served-spec';
import { SPEC_DOCUMENT } from '../../../src/capabilities/spec-document';
import {
  OpenApiDerivationError,
  SECRET_MARKER_KEY,
  inputIsStrict,
  markSecret,
  SERVED_SPEC_EXTENSIONS,
  buildOpenApiSpec,
  deriveOperation,
  openApiPath,
  toOas30,
} from '../../../src/capabilities/derive-openapi';
import { defineCapability, type Capability } from '../../../src/capabilities/define';
import { CAPABILITIES, type RegisteredCapability } from '../../../src/capabilities/registry';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { projectsListCapability } from '../../../src/capabilities/projects/list';

type Paths = Record<string, Record<string, unknown>>;

const servedKeys = (spec: { paths: Paths }) => Object.entries(spec.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`));

describe('served spec', () => {
  // A capability with no `openapi.frozen` is a NEW operation (P4a1: the KAG
  // routes, previously undeclared). An `http.specExempt` row (P4d-2e) has none.
  const fresh = CAPABILITIES.filter((e) => e.cap.openapi?.frozen === undefined && e.cap.http.path !== null && e.cap.http.specExempt === undefined);

  test('is the spec document with every capability operation, in the LOCK order, and nothing else', () => {
    expect(SERVED_SPEC_EXTENSIONS).toBe(false);
    const served = openapiSpec as unknown as { paths: Paths } & Record<string, unknown>;
    // The document's key order (paths keeps its slot) and every non-path part are the spec document's.
    expect(Object.keys(served)).toEqual(Object.keys(SPEC_DOCUMENT));
    const { paths: _p, ...rest } = served;
    const { paths: docPaths, ...docRest } = SPEC_DOCUMENT;
    expect(docPaths).toEqual({});
    expect(rest).toEqual(docRest as never);
    // Every routed, non-exempt capability is served exactly once; the order is the lock's, exactly.
    const routed = CAPABILITIES.filter((e) => e.cap.http.path !== null && e.cap.http.specExempt === undefined);
    expect(servedKeys(served)).toEqual([...SERVED_SPEC_ORDER]);
    expect(SERVED_SPEC_ORDER.length).toBe(routed.length);
    for (const { cap } of routed) {
      const op = served.paths[openApiPath(cap.http.path!)]![cap.http.method.toLowerCase()];
      expect(op).toEqual(deriveOperation(cap, { extensions: false }) as never);
    }
  });

  test('an http.specExempt row is routed but never served', () => {
    const exempt = CAPABILITIES.filter((e) => e.cap.http.specExempt !== undefined);
    expect(exempt.map((e) => `${e.cap.http.method} ${e.cap.http.path}`)).toEqual(
      ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => `${m} /api/assets/kag/reviews(.*)`),
    );
    expect(JSON.stringify(openapiSpec)).not.toContain('/api/assets/kag/reviews(');
  });

  test('every capability is served once, at its path, with its operationId; a frozen one verbatim', () => {
    const served = openapiSpec.paths as unknown as Paths;
    const frozen = CAPABILITIES.filter(({ cap }) => cap.openapi?.frozen !== undefined);
    const P4D2A_FROZEN = new Set(['src/capabilities/approvals/approvals.ts', 'src/capabilities/projects/collaboration.ts']);
    const P4D2A2_FROZEN = new Set([
      'src/capabilities/projects/project-frozen.ts',
      'src/capabilities/cards/cards.ts',
      'src/capabilities/decompositions/decompositions.ts',
    ]);
    for (const f of P4D2A2_FROZEN) P4D2A_FROZEN.add(f);
    const P4D2C_FROZEN = new Set(['src/capabilities/library/asset-authoring.ts']);
    for (const f of P4D2C_FROZEN) P4D2A_FROZEN.add(f);
    const P4D2D_FROZEN = new Set([
      'src/capabilities/platform/service-frozen.ts',
      'src/capabilities/platform/admin-frozen.ts',
      'src/capabilities/platform/account-frozen.ts',
      'src/capabilities/platform/system.ts',
    ]);
    for (const f of P4D2D_FROZEN) P4D2A_FROZEN.add(f);
    expect(frozen.filter(({ file }) => !P4D2A_FROZEN.has(file)).map(({ cap }) => cap.id).sort()).toEqual([
      'approvals.decide',
      // P4a3: the conveyor catalogue (12).
      'conveyor.create_catalogue_item',
      'conveyor.delete_catalogue_item',
      'conveyor.get_catalogue_enums',
      'conveyor.get_catalogue_item',
      'conveyor.get_project_type_card_types',
      'conveyor.get_taxonomy',
      'conveyor.import_catalogue_defaults',
      'conveyor.list_catalogue',
      'conveyor.list_project_types',
      'conveyor.resolve_wip_limit',
      'conveyor.set_project_type_card_types',
      'conveyor.update_catalogue_item',
      // P4d-2b: the two kanban literal operations (moveKanbanCard, breakGlassDoneKanbanCard).
      'kanban.break_glass_done',
      'kanban.move_card',
      'projects.create',
      'projects.get',
      // P2-c1: the quality and knowledge-allocation reads (spec drain of literal operations).
      'projects.get_knowledge_allocation',
      'projects.get_quality',
      'projects.get_quality_history',
      'projects.list',
    ]);
    for (const { cap } of frozen) {
      const op = served[openApiPath(cap.http.path!)]![cap.http.method.toLowerCase()] as { operationId: string };
      expect(op.operationId).toBe(cap.http.operationId);
      expect(op).toEqual((cap.openapi?.frozen ?? deriveOperation(cap)) as never);
    }
  });

  test('each NEW capability (P4a1 KAG, P1b, P4a2 research / media, P4a3 library) is a NEW operation: its own operationId, a declared tag; x-internal for service routes only', () => {
    const served = openapiSpec.paths as unknown as Paths;
    const declaredTags = new Set(((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags).map((t) => t.name));
    for (const { cap } of fresh) {
      const op = served[openApiPath(cap.http.path!)]![cap.http.method.toLowerCase()] as {
        operationId: string;
        tags: string[];
        'x-internal'?: boolean;
      };
      expect(op.operationId).toBe(cap.http.operationId);
      expect(op.tags.length).toBeGreaterThan(0);
      for (const t of op.tags) expect(declaredTags.has(t)).toBe(true);
      // P4b part 3: the GitHub App callback is a browser redirect, not a typed-client op.
      // R311 PR 5: a licence-allowlisted webhook (the conveyor seat's project.startFailed / coachFailed) IS a
      // typed-client op — n8n-nodes-fr is generated from it — so it is not x-internal.
      expect(op['x-internal'] === true).toBe(
        cap.area === 'internal' || (cap.area === 'webhooks' && cap.licence === undefined) || cap.id === 'github_app.install_callback',
      );
    }
  });

  test('a frozen operation is COPIED, so a consumer mutating the served spec cannot edit the declaration', () => {
    const op = deriveOperation(projectsListCapability) as { summary: string };
    op.summary = 'mutated';
    expect((projectsListCapability.openapi!.frozen as { summary: string }).summary).toBe("List user's projects");
  });
});

describe('buildOpenApiSpec — placement and refusals', () => {
  const doc = (paths: Paths = {}) => ({ openapi: '3.0.0', paths });
  const pick = (...ids: string[]) => ids.map((id) => CAPABILITIES.find((e) => e.cap.id === id)!);

  test('a path written in the document fails the build: every operation is a capability\'s', () => {
    expect(() => buildOpenApiSpec(doc({ '/api/projects': { get: { operationId: 'listProjects' } } }), CAPABILITIES)).toThrow(OpenApiDerivationError);
  });

  test('two capabilities on one path+method fail the build', () => {
    const twin = { ...projectsListCapability, id: 'projects.list_twin' as const, http: { ...projectsListCapability.http, operationId: 'twin' } };
    expect(() => buildOpenApiSpec(doc(), [...pick('projects.list'), { cap: twin, file: 'test' }])).toThrow('served by BOTH');
  });

  test('the order places listed operations first, in that order; the rest follow in registry order', () => {
    const entries = pick('projects.list', 'projects.create', 'projects.get');
    const out = buildOpenApiSpec(doc(), entries, { extensions: false }, ['GET /api/projects/{id}', 'POST /api/projects', 'GET /nowhere']);
    expect(servedKeys(out)).toEqual(['GET /api/projects/{id}', 'POST /api/projects', 'GET /api/projects']);
    // Methods of one path follow the order too (POST before GET under /api/projects).
    expect(Object.keys(out.paths['/api/projects']!)).toEqual(['post', 'get']);
  });

  test('an http.specExempt capability is not emitted', () => {
    const exempt = CAPABILITIES.filter((e) => e.cap.http.specExempt !== undefined);
    expect(exempt.length).toBeGreaterThan(0);
    expect(buildOpenApiSpec(doc(), exempt).paths).toEqual({});
  });
});

describe('deriveOperation — a NEW (non-frozen) operation', () => {
  const cap: Capability<unknown, unknown> = {
    id: 'demo.update_thing',
    area: 'projects',
    summary: 'Update a thing',
    http: { method: 'PATCH', path: '/api/demo/:id', operationId: 'updateDemoThing', successStatus: 200 },
    input: z.object({ id: z.string().uuid(), name: z.string().max(10), note: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
    errors: [{ status: 409, code: 'conflict' }],
    auth: { principal: 'user', rbac: { type: 'public' } },
    tenancy: 'project',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'out-of-agent-scope' },
    legacyHandler: async () => new Response(),
  };

  test('path params, body, responses and errors from the zod schemas', () => {
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(op.operationId).toBe('updateDemoThing');
    expect(op.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]);
    expect(op.requestBody.content['application/json'].schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string', maxLength: 10 }, note: { type: 'string' } },
      required: ['name'],
    });
    expect(op.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    });
    expect(op.responses['409'].description).toBe('conflict');
    expect(op['x-fr-capability']).toBeUndefined();
  });

  test('x-fr-capability metadata when extensions are on (frozen operations too)', () => {
    expect((deriveOperation(cap, { extensions: true }) as Record<string, unknown>)['x-fr-capability']).toEqual({
      id: 'demo.update_thing',
      effect: 'write',
      tenancy: 'project',
      confirm: 'card',
      conveyorGated: false,
    });
    const frozen = deriveOperation(projectsListCapability, { extensions: true }) as Record<string, any>;
    expect(frozen['x-fr-capability'].id).toBe('projects.list');
    expect(frozen.operationId).toBe('listProjects');
  });

  test('a GET puts non-path fields in the query', () => {
    const get: Capability<unknown, unknown> = { ...cap, http: { ...cap.http, method: 'GET' }, effect: 'read', confirm: 'none' };
    const op = deriveOperation(get, { extensions: false }) as Record<string, any>;
    expect(op.requestBody).toBeUndefined();
    expect(op.parameters.map((p: { name: string; in: string }) => `${p.in}:${p.name}`)).toEqual([
      'path:id',
      'query:name',
      'query:note',
    ]);
  });

  test('an appended new capability changes the served document only by that operation', () => {
    const extra: RegisteredCapability = { cap: cap as Capability<any, any>, file: 'test' };
    const out = buildOpenApiSpec(SPEC_DOCUMENT, [...CAPABILITIES, extra], { extensions: false }, SERVED_SPEC_ORDER);
    expect(out.paths['/api/demo/{id}']).toEqual({ patch: deriveOperation(cap, { extensions: false }) });
    const { ['/api/demo/{id}']: _added, ...rest } = out.paths;
    expect(JSON.stringify({ ...out, paths: rest })).toBe(JSON.stringify(openapiSpec));
  });
});

describe('deriveOperation — P4a1 body and media-type forms', () => {
  const base: Capability<unknown, unknown> = {
    id: 'demo.forward',
    area: 'kag',
    summary: 'Forward a body',
    http: { method: 'POST', path: '/api/demo/forward', operationId: 'demoForward' },
    input: z.object({}).passthrough(),
    output: z.object({ data: z.unknown() }),
    errors: [],
    auth: { principal: 'user', rbac: { type: 'public' } },
    tenancy: 'tenant',
    effect: 'read',
    confirm: 'none',
    agent: { expose: false, reason: 'out-of-agent-scope' },
    legacyHandler: async () => new Response(),
  };

  test('a .passthrough() body with no listed key still gets a requestBody that admits any key', () => {
    const op = deriveOperation(base, { extensions: false }) as Record<string, any>;
    expect(op.requestBody).toEqual({
      required: false,
      content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } },
    });
  });

  test('listed keys of a passthrough body are kept, and the passthrough is seen through .extend/.describe', () => {
    const cap = { ...base, input: z.object({}).passthrough().describe('x').extend({ project_id: z.string().optional() }) };
    const schema = (deriveOperation(cap, { extensions: false }) as Record<string, any>).requestBody.content['application/json'].schema;
    expect(schema).toEqual({ type: 'object', properties: { project_id: { type: 'string' } }, additionalProperties: true });
  });

  test('a strip (default) object with no keys emits NO requestBody — passthrough is not assumed', () => {
    const op = deriveOperation({ ...base, input: z.object({}) }, { extensions: false }) as Record<string, any>;
    expect(op.requestBody).toBeUndefined();
  });

  test('a passthrough input on a GET stays query-only (no requestBody)', () => {
    const get = { ...base, http: { ...base.http, method: 'GET' as const } };
    expect((deriveOperation(get, { extensions: false }) as Record<string, any>).requestBody).toBeUndefined();
  });

  test('multipart: the named file part is binary AND required, the media type is multipart/form-data', () => {
    const cap: Capability<unknown, unknown> = {
      ...base,
      effect: 'write',
      confirm: 'card',
      http: { ...base.http, requestBody: { contentType: 'multipart/form-data', fileFields: ['file'] } },
      input: z.object({ file: z.unknown().describe('the doc'), note: z.string().optional() }),
    };
    const rb = (deriveOperation(cap, { extensions: false }) as Record<string, any>).requestBody;
    expect(rb.required).toBe(true);
    expect(Object.keys(rb.content)).toEqual(['multipart/form-data']);
    expect(rb.content['multipart/form-data'].schema).toEqual({
      type: 'object',
      properties: { file: { type: 'string', format: 'binary', description: 'the doc' }, note: { type: 'string' } },
      required: ['file'],
    });
  });

  test('a non-JSON response is a binary schema under its media type, not the output zod schema', () => {
    const cap = { ...base, http: { ...base.http, method: 'GET' as const, responseContentType: 'application/octet-stream' } };
    const res = (deriveOperation(cap, { extensions: false }) as Record<string, any>).responses['200'];
    expect(res.content).toEqual({ 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } });
  });

  test('the real KAG upload is multipart with a required binary `file`; the real screenshot is bytes', () => {
    const served = openapiSpec.paths as unknown as Record<string, Record<string, any>>;
    const upload = served['/api/tools/kag/documents']!.post.requestBody;
    expect(upload.content['multipart/form-data'].schema.required).toEqual(['file']);
    expect(upload.content['multipart/form-data'].schema.properties.file.format).toBe('binary');
    expect(Object.keys(served['/api/tools/kag/scrape/sessions/{id}/screenshot']!.get.responses['200'].content)).toEqual([
      'application/octet-stream',
    ]);
    // A forwarded body admits the upstream's keys.
    expect(served['/api/assets/kag/nlp/entities']!.post.requestBody.content['application/json'].schema.additionalProperties).toBe(true);
  });
});

describe('toOas30 — derived operations speak OpenAPI 3.0, the agent schemas keep JSON Schema', () => {
  test('a nullable (anyOf [X, null]) becomes X + nullable:true, keeping the description', () => {
    expect(toOas30({ anyOf: [{ type: 'string', maxLength: 3 }, { type: 'null' }], description: 'd' })).toEqual({
      type: 'string',
      maxLength: 3,
      description: 'd',
      nullable: true,
    });
    expect(toOas30({ properties: { a: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } } })).toEqual({
      properties: { a: { type: 'object', properties: {}, nullable: true } },
    });
  });

  test('a multi-branch nullable keeps its anyOf; a non-nullable anyOf is untouched; const becomes enum', () => {
    expect(toOas30({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] })).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      nullable: true,
    });
    expect(toOas30({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(toOas30({ const: 'x' })).toEqual({ enum: ['x'] });
  });

  test('P4b: a numeric exclusive bound (z.number().positive()) becomes minimum/maximum + the 3.0 boolean', () => {
    expect(toOas30({ type: 'number', exclusiveMinimum: 0 })).toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true });
    expect(toOas30({ type: 'number', exclusiveMaximum: 10 })).toEqual({ type: 'number', maximum: 10, exclusiveMaximum: true });
    expect(toOas30({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 })).toEqual({
      type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: true,
    });
    // Already 3.0 (a boolean), or a PROPERTY named like the keyword: untouched.
    expect(toOas30({ type: 'number', minimum: 1, exclusiveMinimum: true })).toEqual({ type: 'number', minimum: 1, exclusiveMinimum: true });
    expect(toOas30({ properties: { exclusiveMinimum: { type: 'string' } } })).toEqual({ properties: { exclusiveMinimum: { type: 'string' } } });
    // The real converter output for `.positive()` is the 2019 form this rewrites.
    expect(extractJsonSchema(z.number().positive())).toMatchObject({ exclusiveMinimum: 0 });
  });

  test('P4b: http.queryFields put the named properties of a BODY method in the query string', () => {
    const cap: Capability<unknown, unknown> = {
      id: 'demo.query_put',
      area: 'settings',
      summary: 'q',
      http: { method: 'PUT', path: '/api/demo/q', operationId: 'demoQueryPut', queryFields: ['tier'] },
      input: z.object({ tier: z.enum(['a', 'b']).optional(), name: z.string() }),
      output: z.object({ ok: z.boolean() }),
      errors: [],
      auth: { principal: 'user', rbac: { type: 'public' } },
      tenancy: 'tenant',
      effect: 'write',
      confirm: 'card',
      agent: { expose: false, reason: 'out-of-agent-scope' },
      openapi: { tags: ['LLM Provider'] },
      legacyHandler: async () => new Response(),
    };
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(op.parameters).toEqual([{ name: 'tier', in: 'query', required: false, schema: { type: 'string', enum: ['a', 'b'] } }]);
    expect(op.requestBody.content['application/json'].schema).toEqual({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
  });

  test('deriveOperation emits the 3.0 form for a .nullable() field and the declared tags', () => {
    const cap: Capability<unknown, unknown> = {
      id: 'demo.nullable',
      area: 'kag',
      summary: 'n',
      http: { method: 'POST', path: '/api/demo/n', operationId: 'demoNullable' },
      input: z.object({ ua: z.string().nullable().optional(), kind: z.literal('a') }),
      output: z.object({ data: z.unknown() }),
      errors: [],
      auth: { principal: 'user', rbac: { type: 'public' } },
      tenancy: 'tenant',
      effect: 'read',
      confirm: 'none',
      agent: { expose: false, reason: 'out-of-agent-scope' },
      openapi: { tags: ['KAG'] },
      legacyHandler: async () => new Response(),
    };
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(op.tags).toEqual(['KAG']);
    expect(op.requestBody.content['application/json'].schema.properties).toEqual({
      ua: { type: 'string', nullable: true },
      kind: { enum: ['a'] },
    });
    // The agent-facing schema (the ONE converter) is unchanged: still JSON Schema.
    expect(JSON.stringify(extractJsonSchema(cap.input))).toContain('"type":"null"');
  });
});

// fr-agui P4d-1 — the five derive-openapi extensions P4-carry recorded as inexpressible.
describe('deriveOperation — P4d-1 extensions', () => {
  const base: Capability<unknown, unknown> = {
    id: 'demo.p4d',
    area: 'settings',
    summary: 'p4d',
    http: { method: 'POST', path: '/api/demo/p4d/:id', operationId: 'demoP4d' },
    input: z.object({ id: z.string(), apiKey: z.string(), note: z.string().optional() }),
    output: z.object({ token: z.string(), items: z.array(z.object({ url: z.string().nullable(), name: z.string() })) }),
    errors: [],
    auth: { principal: 'user', rbac: { type: 'public' } },
    tenancy: 'tenant',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { tags: ['LLM Provider'] },
    legacyHandler: async () => new Response(),
  };
  const body = (op: Record<string, any>) => op.requestBody.content['application/json'].schema;
  const ok = (op: Record<string, any>) => op.responses['200'].content['application/json'].schema;

  test('x-secret marks every secrets.input / secrets.output field (through arrays and nullables), and nothing else', () => {
    const plain = deriveOperation(base, { extensions: false }) as Record<string, any>;
    expect(JSON.stringify(plain)).not.toContain(SECRET_MARKER_KEY);
    const cap = { ...base, secrets: { input: ['/apiKey'], output: ['/token', '/items/url'] } };
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(body(op).properties.apiKey).toEqual({ type: 'string', [SECRET_MARKER_KEY]: true });
    expect(body(op).properties.note).toEqual({ type: 'string' });
    expect(ok(op).properties.token).toEqual({ type: 'string', [SECRET_MARKER_KEY]: true });
    expect(ok(op).properties.items.items.properties.url).toEqual({ type: 'string', nullable: true, [SECRET_MARKER_KEY]: true });
    expect(ok(op).properties.items.items.properties.name).toEqual({ type: 'string' });
    // A query-parameter secret (GET) is marked on the parameter's schema.
    const get = { ...cap, http: { ...cap.http, method: 'GET' as const }, effect: 'read' as const, confirm: 'none' as const };
    const q = (deriveOperation(get, { extensions: false }) as Record<string, any>).parameters.find((p: { name: string }) => p.name === 'apiKey');
    expect(q.schema[SECRET_MARKER_KEY]).toBe(true);
    // The agent-facing schema never carries the marker (the converter's output is copied per derivation).
    expect(JSON.stringify(extractJsonSchema(cap.input))).not.toContain(SECRET_MARKER_KEY);
  });

  test('P4d-2e (P4d-1 audit): a pointer THROUGH a nullable / union object is marked via its anyOf / allOf / oneOf branch', () => {
    // `creds` is a nullable OBJECT: the converter emits `anyOf: [{object}, {type: null}]`, so the
    // `/creds/token` leaf lives inside a branch. Without markSecret's branch walk this marks nothing.
    const schema = extractJsonSchema(
      z.object({ creds: z.object({ token: z.string(), user: z.string() }).nullable(), either: z.union([z.object({ key: z.string() }), z.object({ key: z.string(), x: z.number() })]) }),
    ) as Record<string, any>;
    expect(Array.isArray(schema.properties.creds.anyOf)).toBe(true);
    expect(markSecret(schema, ['creds', 'token'])).toBe(1);
    expect(markSecret(schema, ['either', 'key'])).toBe(2);
    const creds = schema.properties.creds.anyOf.find((b: { type?: string }) => b.type === 'object');
    expect(creds.properties.token[SECRET_MARKER_KEY]).toBe(true);
    expect(creds.properties.user[SECRET_MARKER_KEY]).toBeUndefined();
    // …and through deriveOperation, into the served 3.0 form (the nullable collapses, the mark survives).
    const cap = { ...base, output: z.object({ creds: z.object({ token: z.string() }).nullable() }), secrets: { output: ['/creds/token'] } };
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(ok(op).properties.creds.properties.token[SECRET_MARKER_KEY]).toBe(true);
    expect(ok(op).properties.creds.nullable).toBe(true);
  });

  test('every declared secret pointer marks at least one field of the served spec (except the FROZEN projects.create)', () => {
    const unresolved: string[] = [];
    for (const { cap } of CAPABILITIES) {
      for (const side of ['input', 'output'] as const) {
        for (const ptr of cap.secrets?.[side] ?? []) {
          const schema = extractJsonSchema(side === 'input' ? cap.input : cap.output);
          if (markSecret(schema, ptr.split('/').slice(1)) === 0) unresolved.push(`${cap.id} ${side} ${ptr}`);
        }
      }
    }
    // P4d-2d's frozen secret writes (`$ref: SecretCreate` / `SecretUpdate`) are verbatim literals, so
    // derive-openapi never rebuilds them; the components carry the x-secret mark. (projects.create no longer
    // declares a secret: the per-project GitHub token was removed, George 2026-10-18.)
    expect(unresolved).toEqual([
      'secrets.create_secret input /secret_value',
      'secrets.update_secret input /secret_value',
    ]);
  });

  test('a .strict() input is additionalProperties:false on the body; strip stays unstated, passthrough stays true', () => {
    expect(body(deriveOperation(base, { extensions: false }) as Record<string, any>).additionalProperties).toBeUndefined();
    const strict = { ...base, input: z.object({ id: z.string(), apiKey: z.string() }).strict().describe('x') };
    expect(body(deriveOperation(strict, { extensions: false }) as Record<string, any>).additionalProperties).toBe(false);
    // Through a merge with a path-param object (`.merge` takes the argument's unknownKeys).
    const merged = { ...base, input: z.object({ id: z.string() }).merge(z.object({ apiKey: z.string() }).strict()) };
    expect(body(deriveOperation(merged, { extensions: false }) as Record<string, any>).additionalProperties).toBe(false);
    const pass = { ...base, input: z.object({ id: z.string(), apiKey: z.string() }).passthrough() };
    expect(body(deriveOperation(pass, { extensions: false }) as Record<string, any>).additionalProperties).toBe(true);
    expect(inputIsStrict(z.object({}).strict().optional())).toBe(true);
    expect(inputIsStrict(z.object({}))).toBe(false);
  });

  test('http.bodyFields: a body key that shares a path parameter name is emitted in BOTH places', () => {
    const before = deriveOperation(base, { extensions: false }) as Record<string, any>;
    expect(Object.keys(body(before).properties)).toEqual(['apiKey', 'note']);
    const cap = { ...base, http: { ...base.http, bodyFields: ['id'] } };
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(op.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(body(op).properties.id).toEqual({ type: 'string' });
    expect(body(op).required).toEqual(['id', 'apiKey']);
    // A copy, not an alias: marking one does not mark the other.
    (body(op).properties.id as Record<string, unknown>).x = 1;
    expect(op.parameters[0].schema.x).toBeUndefined();
  });

  test('http.bodyFields on a DELETE: the named properties form the JSON body, the rest stay query', () => {
    const del: Capability<unknown, unknown> = {
      ...base,
      http: { method: 'DELETE', path: '/api/demo/p4d/:id', operationId: 'demoP4dDelete' },
      input: z.object({ id: z.string(), keep_board: z.boolean().optional(), q: z.string().optional() }),
      effect: 'destructive',
      confirm: 'card-typed',
    };
    const before = deriveOperation(del, { extensions: false }) as Record<string, any>;
    expect(before.requestBody).toBeUndefined();
    const op = deriveOperation({ ...del, http: { ...del.http, bodyFields: ['keep_board'] } }, { extensions: false }) as Record<string, any>;
    expect(op.requestBody).toEqual({
      required: false,
      content: { 'application/json': { schema: { type: 'object', properties: { keep_board: { type: 'boolean' } } } } },
    });
    expect(op.parameters.map((p: { in: string; name: string }) => `${p.in}:${p.name}`)).toEqual(['path:id', 'query:q']);
    expect(() => deriveOperation({ ...del, http: { ...del.http, bodyFields: ['nope'] } }, { extensions: false })).toThrow(OpenApiDerivationError);
  });

  test('http.headers: X-Target-Tenant-Id is an `in: header` parameter', () => {
    const cap = { ...base, http: { ...base.http, headers: [{ name: 'X-Target-Tenant-Id' as const, required: true, description: 'the tenant' }] } };
    const op = deriveOperation(cap, { extensions: false }) as Record<string, any>;
    expect(op.parameters).toContainEqual({ name: 'X-Target-Tenant-Id', in: 'header', required: true, description: 'the tenant', schema: { type: 'string' } });
    expect((deriveOperation(base, { extensions: false }) as Record<string, any>).parameters.some((p: { in: string }) => p.in === 'header')).toBe(false);
  });

  test('defineCapability refuses a misuse of bodyFields / headers', () => {
    const ok = { ...base, http: { ...base.http, bodyFields: ['id'] } };
    expect(() => defineCapability(ok)).not.toThrow();
    expect(() => defineCapability({ ...base, http: { ...base.http, bodyFields: ['note'] } })).toThrow(/only a name shared with a path parameter/);
    expect(() => defineCapability({ ...base, http: { ...base.http, method: 'GET', bodyFields: ['id'] }, effect: 'read', confirm: 'none' })).toThrow(/GET carries no request body/);
    expect(() => defineCapability({ ...ok, legacyHandler: undefined, handler: async () => ({}) })).toThrow(/legacy route/);
    expect(() => defineCapability({ ...base, http: { ...base.http, headers: [{ name: 'X-Target-Tenant-Id', required: true, description: ' ' }] } })).toThrow(/needs a description/);
  });

  test('the real declarations: the licensing target header, the archive keep_board body', () => {
    const served = openapiSpec as unknown as { paths: Record<string, Record<string, any>> };
    const header = (p: string, m: string) =>
      (served.paths[p]![m].parameters as Array<{ in: string; name: string; required: boolean }>).filter((x) => x.in === 'header');
    expect(header('/api/admin/licenses/grants/revoke', 'post')).toMatchObject([{ name: 'X-Target-Tenant-Id', required: true }]);
    expect(header('/api/admin/licenses/grants/user/{subjectId}', 'get')).toMatchObject([{ required: true }]);
    expect(header('/api/admin/licenses/grants/user/{subjectId}', 'post')).toMatchObject([{ required: true }]);
    expect(header('/api/admin/licenses/grants/user/{subjectId}', 'delete')).toMatchObject([{ required: true }]);
    expect(header('/api/admin/licenses/grants/{licenseId}/regenerate-token', 'post')).toMatchObject([{ required: false }]);
    const arch = served.paths['/api/admin/assets/projects/{id}']!.delete.requestBody;
    expect(arch.required).toBe(false);
    expect(arch.content['application/json'].schema.properties.keep_board.type).toBe('boolean');
  });
});
