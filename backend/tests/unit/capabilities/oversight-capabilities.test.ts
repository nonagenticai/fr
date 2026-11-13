// tests/unit/capabilities/oversight-capabilities.test.ts
//
// fr-agui SPEC §13 P4c part 1 — spec drain, tenant and platform oversight. The
// routes the P4b-part-3 base (998c54e91) pinned in GRANDFATHERED_UNDECLARED under the
// P4c rows of B-route-migration.md — minus the super_admin row (part 2) and the
// project-scoped routes P2 / P3 redesign — are declared as capabilities
// (src/capabilities/{observe,admin}/*) with NO behaviour change. Pinned here:
//
//   * the NEW set is EXACTLY the former pins, each on the handler the route table used;
//   * tenancy (tenant vs platform), agent exclusion, operationId = camelCase(id);
//   * licence: none of these routes is on the licence allowlist;
//   * 🔐 secrets: a delivery's recipient address (output) — and nothing else;
//   * the declared inputs ARE the routes' schemas where fr validates with zod (moved to
//     side-effect-free modules); no input is strict (no handler refuses unknown keys);
//   * no router.add row is left for them, and their pinned neighbours stay.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openApiPath, pathParams } from '../../../src/capabilities/derive-openapi';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import * as assignmentSchemas from '../../../src/routes/assets/assignments-schemas';
import * as deliverySchemas from '../../../src/routes/engagements/deliveries-schemas';
import { ALL, byId } from './p4c1-fixtures';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4c-part-1 pins of check-route-spec-coverage.ts @ 998c54e91. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['GET', '/api/card-types', 'handleListCardTypes'],
  ['GET', '/api/card-types/{cardType}', 'handleGetCardType'],
  ['GET', '/api/assets/_assignments', 'handleListAssetAssignments'],
  ['GET', '/api/traceability/graph', 'handleGetTraceabilityGraph'],
  ['GET', '/api/measure', 'handleGetMeasure'],
  ['GET', '/api/engagements/deliveries', 'handleListDeliveries'],
  ['GET', '/api/engagements/deliveries/{id}', 'handleGetDelivery'],
  ['GET', '/api/admin/departments', 'handleListDepartments'],
  ['POST', '/api/admin/departments', 'handleCreateDepartment'],
  ['GET', '/api/admin/departments/{id}', 'handleGetDepartment'],
  ['PATCH', '/api/admin/departments/{id}', 'handlePatchDepartment'],
  ['POST', '/api/admin/departments/{id}/archive', 'handleArchiveDepartment'],
  ['GET', '/api/admin/departments/{id}/members', 'handleListDepartmentMembers'],
  ['POST', '/api/admin/departments/{id}/members', 'handleAddDepartmentMember'],
  ['PATCH', '/api/admin/departments/{id}/members/{userId}', 'handlePatchDepartmentMember'],
  ['DELETE', '/api/admin/departments/{id}/members/{userId}', 'handleDeleteDepartmentMember'],
  ['GET', '/api/andon', 'handleGetAndon'],
  ['POST', '/api/andon/engage', 'handleEngageAndon'],
  ['POST', '/api/andon/disengage', 'handleDisengageAndon'],
  ['GET', '/api/andon/history', 'handleGetAndonHistory'],
  ['GET', '/api/andon/inflight', 'handleGetAndonInflight'],
  ['GET', '/api/admin/control-tower', 'handleGetControlTower'],
  ['GET', '/api/admin/verification/served-models/timeline', 'handleGetVerificationServedModels'],
  ['GET', '/api/admin/verification/alerts', 'handleGetVerificationAlerts'],
];

// By id, not by file: P4c part 2 added more declarations to capabilities/admin/* (admin-capabilities.test.ts).
const P4C1_IDS = new Set(ALL.map((c) => c.id));
const p4c1 = CAPABILITIES.filter((e) => P4C1_IDS.has(e.cap.id));
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;

/** Platform-scoped: the global cord and the super_admin read models. */
const PLATFORM = new Set(['andon', 'verification', 'control_tower']);

describe('P4c part 1 — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    expect(p4c1.map((e) => e.cap.id).sort()).toEqual(ALL.map((c) => c.id).sort());
    for (const e of p4c1) expect(`${e.cap.id} ${/^src\/capabilities\/(observe|admin)\//.test(e.file)}`).toBe(`${e.cap.id} true`);
    const declared = p4c1.map((e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const);
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
    for (const { cap: c } of p4c1) expect(c.openapi?.frozen).toBeUndefined();
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4c1) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(`${c.id} ${ref.module}#${ref.exportName}: function`);
    }
  });

  test('tenancy (platform for the super_admin / fleet-wide surfaces), agent exclusion, principal; operationId = camelCase(id)', () => {
    for (const { cap: c } of p4c1) {
      const tenancy = PLATFORM.has(c.area) ? 'platform' : 'tenant';
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal} ${c.http.operationId}`).toBe(
        `${c.id} ${tenancy} {"expose":false,"reason":"out-of-agent-scope"} user ${camel(c.id)}`,
      );
    }
  });

  test('no path parameter names a project (the project-scoped governance views and the project andon cord stay pinned)', () => {
    for (const { cap: c } of p4c1) expect(pathParams(c.http.path!).join(',')).not.toMatch(/project/i);
  });

  test('the routes are no longer router.add rows (deriveRouter registers them); their pinned neighbours stay', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    for (const { cap: c } of p4c1) {
      const re = new RegExp(`\\.add\\(\\s*'${c.http.method}',\\s*'${c.http.path!.replace(/[/.-]/g, '\\$&')}'`);
      expect(`${c.id} ${re.test(server)}`).toBe(`${c.id} false`);
    }
    for (const m of ["'./routes/admin/verification'", "'./routes/admin/departments'", "'./routes/admin/department-members'", "'./routes/engagements/deliveries'", "'./routes/card-types'", "'./routes/measure'", "'./routes/traceability'"]) {
      expect(server).not.toContain(`from ${m}`);
    }
    // The neighbours P4c part 1 left pinned (the project andon cord, the governance views) were declared by P2
    // (capabilities/projects/assets.ts) — no longer router.add rows either.
    expect(server).not.toContain("router.add('POST', '/api/projects/:id/andon/engage', handleEngageProjectAndon);");
    expect(server).not.toContain("router.add('GET', '/api/governance/architecture/conformance', handleGetArchitectureConformance);");
  });

  test("effects: GETs read; deletes destructive; the cord pull destructive; success statuses are the handlers' own", () => {
    for (const { cap: c } of p4c1) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm}`).toBe(`${c.id} destructive card-typed`);
    }
    const destructive = p4c1.filter((e) => e.cap.effect === 'destructive' && e.cap.http.method !== 'DELETE').map((e) => e.cap.id).sort();
    expect(destructive).toEqual(['andon.engage', 'departments.archive']);
    const nonDefault = Object.fromEntries(p4c1.filter((e) => e.cap.http.successStatus !== undefined).map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(nonDefault).toEqual({
      'departments.create': 201,
      'departments.add_member': 201,
      'departments.remove_member': 204,
    });
  });
});

describe('P4c part 1 — licence: none of these routes is allowlisted', () => {
  test('no route here is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4c1) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4c part 1 — 🔐 secrets, and inputs', () => {
  test('the only secret: a delivery\'s recipient address (output: a Teams address is the incoming-webhook URL)', () => {
    expect(p4c1.filter((e) => e.cap.secrets?.input).map((e) => e.cap.id)).toEqual([]);
    const outputs = Object.fromEntries(p4c1.filter((e) => e.cap.secrets?.output).map((e) => [e.cap.id, e.cap.secrets!.output]));
    expect(outputs).toEqual({
      'engagements.list_deliveries': ['/data/recipient_address'],
      'engagements.get_delivery': ['/data/recipient_address'],
    });
  });

  test("the shared schemas ARE the routes' (moved to side-effect-free modules)", () => {
    expect(byId('asset_assignments.list').input).toBe(assignmentSchemas.QuerySchema);
    expect(byId('engagements.list_deliveries').input).toBe(deliverySchemas.ListQuerySchema);
  });

  test('strict nowhere: no handler here refuses an unknown key', () => {
    const strict = p4c1.filter((e) => (extractJsonSchema(e.cap.input) as { additionalProperties?: unknown }).additionalProperties === false).map((e) => e.cap.id);
    expect(strict).toEqual([]);
    expect(byId('departments.create').input.safeParse({ name: 'n', future: 1 }).success).toBe(true);
  });

  test('lenient query parameters are declared as the strings the handlers read (never narrower)', () => {
    for (const [id, field] of [['measure.get', 'window'], ['measure.get', 'stream'], ['andon.get', 'live'], ['departments.list', 'include_archived'], ['traceability.get_graph', 'depth']] as const) {
      expect(`${id}.${field} ${byId(id).input.safeParse({ [field]: 'anything' }).success}`).toBe(`${id}.${field} true`);
    }
  });
});

describe('P4c part 1 — the served spec', () => {
  test('every NEW operation is tagged with a declared tag and carries its operationId', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    type Op = { tags: string[]; operationId: string; 'x-internal'?: boolean };
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
    for (const { cap: c } of p4c1) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags.length).toBe(1);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
      expect(op['x-internal']).toBeUndefined();
    }
  });
});
