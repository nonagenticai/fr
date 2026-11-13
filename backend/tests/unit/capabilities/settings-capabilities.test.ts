// tests/unit/capabilities/settings-capabilities.test.ts
//
// fr-agui SPEC §13 P4b — spec drain, tenant settings and services. The routes the
// P4a3 base (6065cc59f) pinned in GRANDFATHERED_UNDECLARED under the groups below
// are declared as capabilities (src/capabilities/settings/*) with NO behaviour
// change. Pinned here:
//
//   * the NEW set is EXACTLY the former pins, each on the handler the route table
//     used (handlers bind late, lazy.ts, so a typo'd export would otherwise fail
//     only at the first request);
//   * tenancy, agent exclusion, operationId = camelCase(id);
//   * licence: none of these routes is on the licence allowlist, and none declares
//     licence ops (D9 `/api/inapp/messages` included — see capabilities/settings/messaging.ts);
//   * 🔐 the secret inputs are declared (`secrets.input`) on every route whose body
//     carries one, and the declared inputs are no stricter than the handlers (most
//     ARE the handlers' schemas, moved to shared modules) — EXCEPT a body fr forwards
//     verbatim (`secrets.create_asset`): fr enforces nothing there, so its input is
//     the END-TO-END contract (secrets-service `SecretData`), typed so a generated
//     client sends objects / numbers, not strings;
//   * no router.add row is left in server.ts for them (deriveRouter registers them).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Capability } from '../../../src/capabilities/define';
import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import * as channelSchemas from '../../../src/routes/channels-shared';
import * as connectorSchemas from '../../../src/routes/connectors-schemas';
import * as inappSchemas from '../../../src/routes/notifications/inapp-schemas';
import { buildLlmUpdate } from '../../../src/routes/settings/llm-provider';
import { URLCredentialCreateSchema } from '../../../src/types/urlCredentials';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4b-group pins of check-route-spec-coverage.ts @ 6065cc59f. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['DELETE', '/api/channels/{id}', 'handleDeleteChannel'],
  ['DELETE', '/api/settings/llm-provider', 'handleDeleteLlmProvider'],
  ['DELETE', '/api/url-credentials/{id}', 'handleDeleteUrlCredential'],
  ['GET', '/api/assets/secrets', 'handleListSecretAssets'],
  ['GET', '/api/assets/secrets/{secretId}', 'handleGetSecretAsset'],
  ['GET', '/api/channels', 'handleListChannels'],
  ['GET', '/api/channels/{id}', 'handleGetChannel'],
  ['GET', '/api/inapp/messages', 'handleInAppListMessages'],
  ['GET', '/api/me/secrets', 'handleListSecrets'],
  ['GET', '/api/settings/llm-provider', 'handleGetLlmProvider'],
  ['GET', '/api/settings/llm-provider/all', 'handleListLlmProviders'],
  ['GET', '/api/settings/llm-provider/catalog', 'handleGetLlmCatalog'],
  ['GET', '/api/tenant/members', 'handleListTenantMembers'],
  ['GET', '/api/url-credentials', 'handleListUrlCredentials'],
  ['GET', '/api/url-credentials/{id}', 'handleGetUrlCredential'],
  ['PATCH', '/api/channels/{id}', 'handleUpdateChannel'],
  ['POST', '/api/assets/secrets', 'handleCreateSecretAsset'],
  ['POST', '/api/channels', 'handleCreateChannel'],
  ['POST', '/api/connectors/test-connection', 'handleTestConnection'],
  ['POST', '/api/inapp/messages', 'handleInAppPostMessage'],
  ['POST', '/api/notifications/inapp', 'handleSendInappNotification'],
  ['POST', '/api/url-credentials', 'handleCreateUrlCredential'],
  ['PUT', '/api/settings/llm-provider', 'handlePutLlmProvider'],
  ['PUT', '/api/url-credentials/{id}', 'handleUpdateUrlCredential'],
];

const p4b = CAPABILITIES.filter((e) => e.file.startsWith('src/capabilities/settings/'));
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;
const byId = new Map<string, Capability<unknown, unknown>>(p4b.map((e) => [e.cap.id, e.cap]));
function cap(id: string): Capability<unknown, unknown> {
  const c = byId.get(id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
}

describe('P4b — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    // Two absolute counts were deleted here on 2026-10-31 (`FORMERLY_PINNED.length`
    // and `p4b.length`, both `toBe(24)`). They proved nothing: the first restated
    // the length of a literal declared 20 lines above, and the equality below is
    // the real guard — an empty or extra `p4b` fails it. All the counts did was
    // force a manual bump every time a route was added to this group.
    const declared = p4b.map((e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const);
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
    for (const { cap: c } of p4b) expect(c.openapi?.frozen).toBeUndefined();
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4b) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(`${c.id} ${ref.module}#${ref.exportName}: function`);
    }
  });

  test('tenancy (self = keyed by the caller), out-of-agent-scope; operationId = camelCase(id)', () => {
    const SELF = new Set(['url_credentials', 'inapp']);
    for (const { cap: c } of p4b) {
      const tenancy = SELF.has(c.area) || c.id === 'secrets.list_mine' ? 'self' : 'tenant';
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal} ${c.http.operationId}`).toBe(
        `${c.id} ${tenancy} {"expose":false,"reason":"out-of-agent-scope"} user ${camel(c.id)}`,
      );
    }
  });

  test('no route here takes a project: no path parameter names one, and no handler gates on one', () => {
    for (const { cap: c } of p4b) expect(c.http.path!).not.toMatch(/project/i);
    for (const f of new Set(p4b.map((e) => handlerRefOf(e.cap.legacyHandler)!.module))) {
      const src = readFileSync(join(BACKEND, f), 'utf8');
      expect(`${f} ${/loadProjectFor|assertProjectAccess|canMutateProject|findTenantScopedProject/.test(src)}`).toBe(`${f} false`);
    }
  });

  test('the routes are no longer router.add rows in server.ts (deriveRouter registers them)', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    for (const { cap: c } of p4b) {
      expect(server).not.toMatch(new RegExp(`router\\.add\\(\\s*'${c.http.method}',\\s*'${c.http.path!.replace(/[/-]/g, '\\$&')}'`));
    }
    for (const m of ["'./routes/urlCredentials'", "'./routes/assets/secrets'", "'./routes/channels'", "'./routes/connectors'", "'./routes/tenant/members'", "'./routes/inapp-messages'", "'./routes/notifications/inapp'"]) {
      expect(server).not.toContain(`from ${m}`);
    }
    // Their literal-spec siblings were declared by P4d-2d (frozen: capabilities/platform/{admin,account}-frozen.ts).
    expect(server).toContain('// POST /api/settings/llm-provider/test is capability-derived (P4d-2d');
    expect(server).toContain('// GET /api/settings/llm-provider/audit is capability-derived (P4d-2d');
    expect(server).toContain('// GET /api/secrets is capability-derived (P4d-2d');
  });

  test('effects: GETs read; deletes destructive; success statuses are the handlers\' own', () => {
    for (const { cap: c } of p4b) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm} ${c.http.successStatus}`).toBe(`${c.id} destructive card-typed 204`);
      if (c.http.method !== 'GET' && c.http.method !== 'DELETE') expect(`${c.id} ${c.effect}`).toBe(`${c.id} write`);
    }
    const non200 = Object.fromEntries(p4b.filter((e) => e.cap.http.successStatus !== undefined && e.cap.http.method !== 'DELETE').map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(non200).toEqual({
      'url_credentials.create': 201,
      'channels.create': 201,
      'secrets.create_asset': 201,
      'inapp.post_message': 202,
      'notifications.send_inapp': 202,
    });
  });
});

describe('P4b — licence: none of these routes is allowlisted', () => {
  test('no route in these groups is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4b) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4b — 🔐 secret inputs, and inputs no stricter than the routes', () => {
  test('every body field that carries a secret is declared in secrets.input — and nothing else is', () => {
    const inputs = Object.fromEntries(p4b.filter((e) => e.cap.secrets?.input).map((e) => [e.cap.id, e.cap.secrets!.input]));
    expect(inputs).toEqual({
      'settings.set_llm_provider': ['/apiKey'],
      'url_credentials.create': ['/credentials'],
      'url_credentials.update': ['/credentials'],
      'channels.create': ['/credentials'],
      'channels.update': ['/credentials'],
      'secrets.create_asset': ['/secrets', '/env_vars'],
    });
    // Each declared pointer names a real top-level input field.
    for (const [id, ptrs] of Object.entries(inputs)) {
      const shape = (cap(id).input as unknown as { shape?: Record<string, unknown>; _def: { shape?: () => Record<string, unknown> } }).shape;
      for (const p of ptrs!) expect(`${id} ${p} ${shape !== undefined && p.slice(1) in shape}`).toBe(`${id} ${p} true`);
    }
  });

  test('the shared schemas ARE the handlers\' (moved out of the route modules), path ids added', () => {
    expect(cap('url_credentials.create').input).toBe(URLCredentialCreateSchema);
    expect(cap('channels.create').input).toBe(channelSchemas.CreateBodySchema);
    expect(cap('notifications.send_inapp').input).toBe(inappSchemas.sendInappNotificationSchema);
    expect(cap('connectors.test_connection').input).toBe(connectorSchemas.TestConnectionBody);
    const update = { name: 'n', credentials: null };
    expect(channelSchemas.UpdateBodySchema.safeParse(update).success).toBe(true);
    expect(cap('channels.update').input.safeParse({ ...update, id: 'not-even-a-uuid' }).success).toBe(true);
  });

  test('the LLM PUT body accepts everything buildLlmUpdate accepts (the route\'s own validator)', () => {
    const bodies: unknown[] = [
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm', apiKey: '' },
      { provider: 'p', model: 'm', baseUrl: null, temperature: null, maxTokens: null, params: null },
      { provider: 'p', model: 'm', baseUrl: '', temperature: 0.2, maxTokens: 10, params: { a: 1 }, extra: true },
    ];
    for (const b of bodies) {
      expect(() => buildLlmUpdate(b)).not.toThrow();
      expect(`${JSON.stringify(b)} ${cap('settings.set_llm_provider').input.safeParse(b).success}`).toBe(`${JSON.stringify(b)} true`);
    }
    // `?tier=` — absent / empty / a tier.
    for (const tier of [undefined, '', 'small', 'medium', 'high']) {
      expect(cap('settings.get_llm_provider').input.safeParse(tier === undefined ? {} : { tier }).success).toBe(true);
    }
  });

  test('free-form inputs keep every key (forwarded bodies, the in-app post, a junk list limit)', () => {
    expect(cap('secrets.create_asset').input.safeParse({ identifier: 'x', anything: { nested: 1 } }).success).toBe(true);
    expect(cap('inapp.post_message').input.safeParse({ text: 5, userId: 7, threadId: {}, correlationId: 1 }).success).toBe(true);
    expect(cap('inapp.list_messages').input.safeParse({ limit: 'lots' }).success).toBe(true);
  });
});

describe('P4b — the served spec', () => {
  test('every NEW operation is tagged with a declared tag and answers its declared responses; PUT ?tier is a query parameter', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, { tags: string[]; operationId: string; responses: Record<string, unknown>; parameters?: Array<{ name: string; in: string }>; requestBody?: unknown }>>;
    for (const { cap: c } of p4b) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags.length).toBe(1);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
    }
    // secrets.create_asset: the END-TO-END contract (secrets-service SecretData), typed — an
    // untyped field made the n8n generator emit a raw string that secrets-service answers 422.
    type Js = { type?: string; required?: string[]; maxLength?: number; minimum?: number; maximum?: number; nullable?: boolean; additionalProperties?: unknown; properties?: Record<string, Js> };
    const create = (paths['/api/assets/secrets']!.post!.requestBody as { content: Record<string, { schema: Js }> }).content['application/json']!.schema;
    expect(create.required).toEqual(['identifier']);
    expect(create.additionalProperties).toBe(true);
    expect(create.properties!.identifier).toMatchObject({ type: 'string', maxLength: 255 });
    for (const k of ['secrets', 'env_vars']) {
      expect(create.properties![k]).toMatchObject({ type: 'object', additionalProperties: { type: 'string', maxLength: 10000 } });
    }
    expect(create.properties!.metadata).toMatchObject({ type: 'object', nullable: true });
    expect(create.properties!.ttl).toMatchObject({ type: 'integer', minimum: 60, maximum: 604800, nullable: true });
    // The in-app 403 door: the refused X-Active-Tenant switch, on both methods. The
    // retired read-only support switch's code is gone (George 2026-10-27).
    const door403 = (m: 'get' | 'post') => JSON.stringify(paths['/api/inapp/messages']![m]!.responses['403']);
    expect(door403('get')).toContain('active_tenant_not_permitted');
    expect(door403('post')).toContain('active_tenant_not_permitted');
    expect(door403('get')).not.toContain('support_switch_read_only');
    expect(door403('post')).not.toContain('support_switch_read_only');
    // Every refusal reason the gate sends is documented on the door.
    for (const reason of ['archived', 'unknown', 'service_account', 'untrusted_session']) {
      expect(door403('get')).toContain(reason);
      expect(door403('post')).toContain(reason);
    }
    const put = paths['/api/settings/llm-provider']!.put!;
    expect(put.parameters).toEqual([expect.objectContaining({ name: 'tier', in: 'query' })]);
    expect(JSON.stringify(put.requestBody)).not.toContain('"tier"');
  });
});
