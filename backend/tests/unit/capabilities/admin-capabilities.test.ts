// tests/unit/capabilities/admin-capabilities.test.ts
//
// fr-agui SPEC §13 P4c part 2 — spec drain, the super_admin row (minus the licensing
// console, pricing and provisioning: part 3) and the leftovers part 1 handed over. The
// routes the P4c-part-1 base (369106df2) pinned in GRANDFATHERED_UNDECLARED for them are
// declared as capabilities with NO behaviour change. Pinned here:
//
//   * the NEW set is EXACTLY those former pins, each on the handler the route table used;
//   * tenancy (tenant / platform / self), agent exclusion, operationId = camelCase(id);
//   * licence: none of these routes is on the licence allowlist;
//   * 🔐 secrets: none (no field here carries a credential; a project's GitHub token is a
//     secrets-service REFERENCE, never the token);
//   * the declared inputs ARE the routes' schemas where fr validates with zod (moved to
//     side-effect-free modules); strict exactly where the handler refuses an unknown key;
//   * no router.add row is left for them, and their part-3 / P2 neighbours stay.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import * as assetQuerySchemas from '../../../src/integrations/_lib/asset-query-schemas';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import * as projectSchemas from '../../../src/routes/admin/assets/projects-schemas';
import * as userRoleSchemas from '../../../src/routes/admin/user-roles-schemas';
import { ALL, BODIES, byId } from './p4c2-fixtures';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4c-part-2 pins of check-route-spec-coverage.ts @ 369106df2. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['GET', '/api/admin/assets/principles', 'handleListAdminPrinciples'],
  ['GET', '/api/admin/assets/principles/{id}', 'handleGetAdminPrinciple'],
  ['POST', '/api/admin/assets/principles', 'handleCreateAdminPrinciple'],
  ['PATCH', '/api/admin/assets/principles/{id}', 'handleUpdateAdminPrinciple'],
  ['DELETE', '/api/admin/assets/principles/{id}', 'handleDeleteAdminPrinciple'],
  ['GET', '/api/admin/assets/requirements', 'handleListAdminRequirements'],
  ['GET', '/api/admin/assets/requirements/{id}', 'handleGetAdminRequirement'],
  ['POST', '/api/admin/assets/requirements', 'handleCreateAdminRequirement'],
  ['PATCH', '/api/admin/assets/requirements/{id}', 'handleUpdateAdminRequirement'],
  ['DELETE', '/api/admin/assets/requirements/{id}', 'handleDeleteAdminRequirement'],
  ['GET', '/api/admin/assets/decisions', 'handleListAdminDecisions'],
  ['GET', '/api/admin/assets/decisions/{id}', 'handleGetAdminDecision'],
  ['POST', '/api/admin/assets/decisions', 'handleCreateAdminDecision'],
  ['PATCH', '/api/admin/assets/decisions/{id}', 'handleUpdateAdminDecision'],
  ['DELETE', '/api/admin/assets/decisions/{id}', 'handleDeleteAdminDecision'],
  ['GET', '/api/admin/assets/projects', 'handleListAdminProjects'],
  ['GET', '/api/admin/assets/projects/{id}', 'handleGetAdminProject'],
  ['PATCH', '/api/admin/assets/projects/{id}', 'handleUpdateAdminProject'],
  ['DELETE', '/api/admin/assets/projects/{id}', 'handleDeleteAdminProject'],
  ['GET', '/api/admin/assets/workflows', 'handleListAdminWorkflows'],
  ['GET', '/api/admin/assets/workflows/{id}', 'handleGetAdminWorkflow'],
  // server.ts registered these five through pure delegation arrows; the module exports:
  ['GET', '/api/admin/users', 'handleListAdminUsers'],
  ['POST', '/api/admin/users/{userId}/roles', 'handleGrantUserRole'],
  ['DELETE', '/api/admin/users/{userId}/roles', 'handleRevokeUserRole'],
  ['GET', '/api/admin/usage/system', 'handleGetAdminSystemUsage'],
  ['GET', '/api/admin/andon', 'handleListAndonState'],
  ['GET', '/api/me/super-admin', 'handleGetSuperAdminStatus'],
  ['GET', '/api/me/dept-roles', 'handleListMyDeptRoles'],
  ['POST', '/api/asset-scope/{assetType}/{assetId}/promote', 'handlePromote'],
];

const IDS = new Set(ALL.map((c) => c.id));
const p4c2 = CAPABILITIES.filter((e) => IDS.has(e.cap.id));
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;

const tenancyOf = (id: string, area: string) =>
  area === 'asset_console' || id === 'asset_assignments.promote' ? 'tenant' : area === 'me' ? 'self' : 'platform';

describe('P4c part 2 — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    const declared = p4c2.map((e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const);
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
    for (const { cap: c } of p4c2) expect(c.openapi?.frozen).toBeUndefined();
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4c2) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(`${c.id} ${ref.module}#${ref.exportName}: function`);
    }
  });

  test('tenancy (tenant: the console + promote; self: the role bits; platform: the rest), agent exclusion, principal; operationId = camelCase(id)', () => {
    for (const { cap: c } of p4c2) {
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal} ${c.http.operationId}`).toBe(
        `${c.id} ${tenancyOf(c.id, c.area)} {"expose":false,"reason":"out-of-agent-scope"} user ${camel(c.id)}`,
      );
    }
  });

  test('the routes are no longer router.add rows (deriveRouter registers them); nor are their P2 neighbours (P4d-2c)', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    for (const { cap: c } of p4c2) {
      const re = new RegExp(`\\.add\\(\\s*'${c.http.method}',\\s*'${c.http.path!.replace(/[/.-]/g, '\\$&')}'`);
      expect(`${c.id} ${re.test(server)}`).toBe(`${c.id} false`);
    }
    for (const m of [
      "'./routes/admin/users'", "'./routes/admin/user-roles'", "'./routes/admin/assets/principles'", "'./routes/admin/assets/projects'",
      "'./routes/admin/improvement/workflows'", "'./routes/asset-scope/promote'", "'./routes/me/dept-roles'",
    ]) {
      expect(server).not.toContain(`from ${m}`);
    }
    // (The provisioning, licensing-console and pricing neighbours were declared in P4c part 3; the
    // override / block neighbours in P4d-2c, capabilities/library/asset-surfaces.ts.)
    expect(server).not.toContain("router.add('POST', '/api/asset-scope/:assetType/:assetId/override', handleOverride);");
  });

  test("effects: GETs read; deletes destructive; success statuses are the handlers' own", () => {
    for (const { cap: c } of p4c2) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm}`).toBe(`${c.id} destructive card-typed`);
    }
    const destructive = p4c2.filter((e) => e.cap.effect === 'destructive' && e.cap.http.method !== 'DELETE').map((e) => e.cap.id);
    expect(destructive).toEqual([]);
    const nonDefault = Object.fromEntries(p4c2.filter((e) => e.cap.http.successStatus !== undefined).map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(nonDefault).toEqual({
      'asset_console.create_principle': 201, 'asset_console.delete_principle': 204,
      'asset_console.create_requirement': 201, 'asset_console.delete_requirement': 204,
      'asset_console.create_decision': 201, 'asset_console.delete_decision': 204,
      'asset_console.archive_project': 204,
      'admin_users.grant_role': 201,
      'admin_users.revoke_role': 204,
    });
    // The alternative success each of the two role routes ALSO answers is declared (200).
    for (const id of ['admin_users.grant_role', 'admin_users.revoke_role']) {
      expect(`${id} ${byId(id).openapi?.responses?.some((r) => r.status === 200)}`).toBe(`${id} true`);
    }
  });
});

describe('P4c part 2 — licence: none of these routes is allowlisted', () => {
  test('no route here is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4c2) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4c part 2 — 🔐 secrets, and inputs', () => {
  test('no secret is declared: nothing here carries a credential', () => {
    expect(p4c2.filter((e) => e.cap.secrets !== undefined).map((e) => e.cap.id)).toEqual([]);
  });

  test("the shared schemas ARE the routes' (moved to side-effect-free modules)", async () => {
    expect(byId('asset_console.list_principles').input).toBe(assetQuerySchemas.listPrinciplesParamsSchema);
    expect(byId('asset_console.list_requirements').input).toBe(assetQuerySchemas.listRequirementsParamsSchema);
    expect(byId('asset_console.list_decisions').input).toBe(assetQuerySchemas.listDecisionsParamsSchema);
    // Composed (path parameters merged in): the moved schema's own keys, unchanged.
    const keysOf = (s: unknown) => Object.keys((extractJsonSchema(s) as { properties?: object }).properties ?? {}).sort();
    expect(keysOf(byId('admin_users.grant_role').input)).toEqual(['userId', ...keysOf(userRoleSchemas.GrantBody)].sort());
    expect(keysOf(byId('admin_users.revoke_role').input)).toEqual(['userId', ...keysOf(userRoleSchemas.RevokeParams)].sort());
    expect(keysOf(byId('asset_console.update_project').input)).toEqual(['id', ...keysOf(projectSchemas.PatchProjectSchema)].sort());
  });

  test('strict exactly where the handler refuses an unknown key: the project PATCH (and nowhere else)', () => {
    const strict = p4c2.filter((e) => (extractJsonSchema(e.cap.input) as { additionalProperties?: unknown }).additionalProperties === false).map((e) => e.cap.id);
    expect(strict).toEqual(['asset_console.update_project']);
    expect(byId('asset_console.update_project').input.safeParse({ id: 'x', status: 'active', future: 1 }).success).toBe(false);
    // Forwarded bodies keep their unknown keys (the upstream decides): END-TO-END upstream types, `.passthrough()`.
    for (const id of ['asset_console.create_principle', 'asset_console.update_requirement', 'asset_console.create_decision']) {
      const parsed = byId(id).input.safeParse({ ...inputFor(id), future: 1 }) as { success: boolean; data?: Record<string, unknown> };
      expect(`${id} ${parsed.success} ${parsed.data?.future}`).toBe(`${id} true 1`);
    }
    // The grant body ignores unknown keys (zod strip), never refuses them.
    expect(byId('admin_users.grant_role').input.safeParse({ userId: 'u', ...(BODIES['admin_users.grant_role'] as object), future: 1 }).success).toBe(true);
  });

  test('forwarded bodies carry the upstream types (n8n-nodes-fr renders json / number kinds from them)', () => {
    const props = (id: string) => (extractJsonSchema(byId(id).input) as { properties: Record<string, { type?: unknown }> }).properties;
    expect(props('asset_console.create_requirement').effort!.type).toBe('number');
    expect(props('asset_console.create_requirement').links!.type).toBe('object');
    expect(props('asset_console.create_principle').implications!.type).toBe('array');
  });
});

function inputFor(id: string): Record<string, unknown> {
  const c = byId(id);
  return { ...(c.http.path!.includes(':id') ? { id: 'x' } : {}), ...(BODIES[id] as object) };
}

describe('P4c part 2 — the served spec', () => {
  test('every NEW operation is tagged with a declared tag and carries its operationId', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    type Op = { tags: string[]; operationId: string; 'x-internal'?: boolean };
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
    for (const { cap: c } of p4c2) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags.length).toBe(1);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
      expect(op['x-internal']).toBeUndefined();
    }
  });
});
