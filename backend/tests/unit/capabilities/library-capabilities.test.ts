// tests/unit/capabilities/library-capabilities.test.ts
//
// fr-agui SPEC §13 P4a3 — spec drain, the rest of the tenant library. The 58
// routes the P4a2 base (294d51d57) pinned in GRANDFATHERED_UNDECLARED under
// /api/assets/{architecture,toc,kaizen}, /api/kaizen and /api/library, plus the
// 12 conveyor-catalogue and 2 licence-allowlisted kaizen routes that ALREADY had a
// spec operation, are declared as capabilities (src/capabilities/library/*,
// src/capabilities/conveyor/catalogue.ts) with NO behaviour change. Pinned here:
//
//   * the NEW set is EXACTLY the former pins, each on the handler the route
//     table used (handlers bind late, lazy.ts, so a typo'd export would otherwise
//     fail only at the first request); the FROZEN set keeps its operationIds;
//   * tenancy, agent exclusion, operationId = camelCase(id) for a new operation;
//   * licence: nothing in these groups is on the allowlist (the two kaizen
//     writes were deleted with the v3 kaizen loop, 2026-11-03);
//   * the declared inputs are no stricter than what the handlers accept;
//   * no router.add row is left in server.ts for them (deriveRouter registers them).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Capability } from '../../../src/capabilities/define';
import { CATALOGUE_RESOURCES } from '../../../src/capabilities/conveyor/catalogue';
import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { PM_CATALOGUE_RESOURCES } from '../../../src/integrations/pm-catalogue';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4a3-group pins of check-route-spec-coverage.ts @ 294d51d57. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['DELETE', '/api/assets/architecture/elements/{eid}', 'handleDeleteArchitectureElement'],
  ['DELETE', '/api/assets/architecture/relationships/{rid}', 'handleDeleteArchitectureRelationship'],
  ['DELETE', '/api/assets/architecture/standards/{sid}', 'handleDeleteArchitectureStandard'],
  ['DELETE', '/api/assets/architecture/views/{vid}', 'handleDeleteArchitectureView'],
  ['DELETE', '/api/assets/toc/{treeId}', 'handleDeleteTocTree'],
  ['DELETE', '/api/assets/toc/{treeId}/edges/{edgeId}', 'handleDeleteTocEdge'],
  ['DELETE', '/api/assets/toc/{treeId}/nodes/{nodeId}', 'handleDeleteTocNode'],
  ['GET', '/api/assets/architecture/elements', 'handleListArchitectureElements'],
  ['GET', '/api/assets/architecture/elements/{eid}', 'handleGetArchitectureElement'],
  ['GET', '/api/assets/architecture/relationships', 'handleListArchitectureRelationships'],
  ['GET', '/api/assets/architecture/relationships/{rid}', 'handleGetArchitectureRelationship'],
  ['GET', '/api/assets/architecture/standards', 'handleListArchitectureStandards'],
  ['GET', '/api/assets/architecture/standards/{sid}', 'handleGetArchitectureStandard'],
  ['GET', '/api/assets/architecture/views', 'handleListArchitectureViews'],
  ['GET', '/api/assets/architecture/views/{vid}', 'handleGetArchitectureView'],
  ['GET', '/api/assets/toc', 'handleListTocTrees'],
  ['GET', '/api/assets/toc/config', 'handleGetTocConfig'],
  ['GET', '/api/assets/toc/{treeId}', 'handleGetTocTree'],
  ['GET', '/api/assets/toc/{treeId}/edges', 'handleListTocEdges'],
  ['GET', '/api/assets/toc/{treeId}/graph', 'handleGetTocGraph'],
  ['GET', '/api/assets/toc/{treeId}/nodes', 'handleListTocNodes'],
  ['POST', '/api/assets/architecture/elements', 'handleCreateArchitectureElement'],
  ['POST', '/api/assets/architecture/relationships', 'handleCreateArchitectureRelationship'],
  ['POST', '/api/assets/architecture/standards', 'handleCreateArchitectureStandard'],
  ['POST', '/api/assets/architecture/views', 'handleCreateArchitectureView'],
  ['POST', '/api/assets/toc', 'handleCreateTocTree'],
  ['POST', '/api/assets/toc/{treeId}/edges', 'handleCreateTocEdge'],
  ['POST', '/api/assets/toc/{treeId}/nodes', 'handleCreateTocNode'],
  ['POST', '/api/assets/toc/{treeId}/quality', 'handleGetTocQuality'],
  ['PUT', '/api/assets/architecture/elements/{eid}', 'handleUpdateArchitectureElement'],
  ['PUT', '/api/assets/architecture/standards/{sid}', 'handleUpdateArchitectureStandard'],
  ['PUT', '/api/assets/architecture/views/{vid}', 'handleUpdateArchitectureView'],
  ['PUT', '/api/assets/toc/config', 'handleUpdateTocConfig'],
  ['PUT', '/api/assets/toc/{treeId}', 'handleUpdateTocTree'],
  ['PUT', '/api/assets/toc/{treeId}/nodes/{nodeId}', 'handleUpdateTocNode'],
];

/** The routes that already had a spec operation: operationId FROZEN (as served at 294d51d57). */
const FROZEN: Readonly<Record<string, [string, string, string]>> = {
  'conveyor.get_taxonomy': ['GET', '/api/conveyor/taxonomy', 'getConveyorTaxonomy'],
  'conveyor.get_catalogue_enums': ['GET', '/api/conveyor/catalogue/enums', 'getConveyorCatalogueEnums'],
  'conveyor.import_catalogue_defaults': ['POST', '/api/conveyor/catalogue/import-defaults', 'importConveyorCatalogueDefaults'],
  'conveyor.get_project_type_card_types': ['GET', '/api/conveyor/catalogue/project-types/{id}/card-types', 'getConveyorProjectTypeCardTypes'],
  'conveyor.set_project_type_card_types': ['PUT', '/api/conveyor/catalogue/project-types/{id}/card-types', 'setConveyorProjectTypeCardTypes'],
  'conveyor.resolve_wip_limit': ['GET', '/api/conveyor/catalogue/wip-limits/resolve', 'resolveConveyorWipLimit'],
  'conveyor.list_catalogue': ['GET', '/api/conveyor/catalogue/{resource}', 'listConveyorCatalogue'],
  'conveyor.create_catalogue_item': ['POST', '/api/conveyor/catalogue/{resource}', 'createConveyorCatalogueItem'],
  'conveyor.get_catalogue_item': ['GET', '/api/conveyor/catalogue/{resource}/{id}', 'getConveyorCatalogueItem'],
  'conveyor.update_catalogue_item': ['PUT', '/api/conveyor/catalogue/{resource}/{id}', 'updateConveyorCatalogueItem'],
  'conveyor.delete_catalogue_item': ['DELETE', '/api/conveyor/catalogue/{resource}/{id}', 'deleteConveyorCatalogueItem'],
};

// P4d-2c's library-group files are excluded from this suite's pin table.
const P4D2C_FILES = new Set(['src/capabilities/library/governed-assets.ts', 'src/capabilities/library/asset-surfaces.ts', 'src/capabilities/library/asset-authoring.ts']);
// The ArchiMate modeling routes are pinned in their own suite (architecture-modeling-capabilities.test.ts).
const MODELING_FILE = 'src/capabilities/library/architecture-modeling.ts';
const p4a3 = CAPABILITIES.filter(
  (e) => (e.file.startsWith('src/capabilities/library/') && !P4D2C_FILES.has(e.file) && e.file !== MODELING_FILE) || e.file === 'src/capabilities/conveyor/catalogue.ts',
);
const fresh = p4a3.filter((e) => e.cap.openapi?.frozen === undefined);
const frozen = p4a3.filter((e) => e.cap.openapi?.frozen !== undefined);
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;
const byId = new Map<string, Capability<unknown, unknown>>(p4a3.map((e) => [e.cap.id, e.cap]));
function cap(id: string): Capability<unknown, unknown> {
  const c = byId.get(id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
}

describe('P4a3 — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    const declared = fresh.map(
      (e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const,
    );
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
  });

  test('the FROZEN operations are the ones that were already served, with their operationIds unchanged', () => {
    expect(Object.fromEntries(frozen.map((e) => [e.cap.id, [e.cap.http.method, openApiPath(e.cap.http.path!), e.cap.http.operationId]]))).toEqual(FROZEN);
    for (const { cap: c } of frozen) expect((c.openapi!.frozen as { operationId: string }).operationId).toBe(c.http.operationId);
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4a3) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(
        `${c.id} ${ref.module}#${ref.exportName}: function`,
      );
    }
  });

  test('tenant-scoped, out-of-agent-scope; NEW operationId = camelCase(id)', () => {
    for (const { cap: c } of p4a3) {
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal}`).toBe(
        `${c.id} tenant {"expose":false,"reason":"out-of-agent-scope"} user`,
      );
    }
    for (const { cap: c } of fresh) expect(c.http.operationId).toBe(camel(c.id));
    expect(new Set(p4a3.map((e) => e.cap.area))).toEqual(
      new Set(['conveyor', 'architecture', 'toc']),
    );
  });

  test('no route here takes a project: no path parameter names one, and no handler gates on one', () => {
    // (`project-types` in the catalogue paths is a catalogue resource, not a project.)
    for (const { cap: c } of p4a3) expect(c.http.path!.replace('project-types', 'TYPES')).not.toMatch(/project/i);
    // The handlers authorise on validateAuth + the request tenant only (a project_id is at most an upstream filter).
    for (const f of ['src/routes/assets/architecture.ts', 'src/routes/assets/toc.ts']) {
      const src = readFileSync(join(BACKEND, f), 'utf8');
      expect(`${f} ${/loadProjectFor|assertProjectAccess|canMutateProject|findTenantScopedProject/.test(src)}`).toBe(`${f} false`);
    }
  });

  test('the routes are no longer router.add rows in server.ts (deriveRouter registers them)', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    for (const { cap: c } of p4a3) expect(server).not.toContain(`router.add('${c.http.method}', '${c.http.path}'`);
    for (const m of ["'./routes/assets/toc'", "'./routes/assets/architecture'", "'./routes/conveyor-taxonomy'"]) {
      expect(server).not.toContain(`from ${m}`);
    }
    // The doorway's priority-levels read was declared by P4d-2d as `conveyor.list_tenant_priority_levels` (frozen,
    // capabilities/platform/admin-frozen.ts); the hand-written doorway agent action keeps its own id.
    expect(server).toContain('// GET /api/conveyor/priority-levels is capability-derived (P4d-2d');
  });

  test('effects: GETs read; deletes destructive', () => {
    for (const { cap: c } of p4a3) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm}`).toBe(`${c.id} destructive card-typed`);
      if (c.http.method !== 'GET' && c.http.method !== 'DELETE') expect(`${c.id} ${c.effect !== 'read'}`).toBe(`${c.id} true`);
    }
  });

  test('success statuses are the handlers\' own: 201 creates, 204 deletes', () => {
    const non200 = Object.fromEntries(fresh.filter((e) => e.cap.http.successStatus !== undefined).map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(non200).toEqual({
      'architecture.create_element': 201,
      'architecture.delete_element': 204,
      'architecture.create_relationship': 201,
      'architecture.delete_relationship': 204,
      'architecture.create_view': 201,
      'architecture.delete_view': 204,
      'architecture.create_standard': 201,
      'architecture.delete_standard': 204,
      'toc.create_tree': 201,
      'toc.delete_tree': 204,
      'toc.create_node': 201,
      'toc.delete_node': 204,
      'toc.create_edge': 201,
      'toc.delete_edge': 204,
    });
  });
});

describe('P4a3 — licence: nothing in these groups is on the licence allowlist', () => {
  test('no route here is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4a3) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4a3 — declared inputs are no stricter than the routes', () => {
  test('architecture / TOC: forwarded bodies keep every key; list filters are free; a junk limit is not refused', () => {
    expect(cap('architecture.create_element').input.safeParse({ name: 'x', element_type: 'any', anything: { nested: 1 } }).success).toBe(true);
    const parsed = cap('architecture.update_view').input.safeParse({ vid: 'v-1', extra: true });
    expect(parsed.success && (parsed.data as Record<string, unknown>).extra).toBe(true);
    expect(cap('architecture.list_elements').input.safeParse({ limit: 'abc', project_id: 'p', layer: 'business' }).success).toBe(true);
    expect(cap('toc.list_trees').input.safeParse({ project_id: 'p', status: 'any' }).success).toBe(true);
    expect(cap('toc.get_graph').input.safeParse({ treeId: 't', fresh: 'yes' }).success).toBe(true);
    expect(cap('toc.create_node').input.safeParse({ treeId: 't', label: 'x', whatever: [1] }).success).toBe(true);
    expect(cap('architecture.get_element').input.safeParse({ eid: 'a b/c?d' }).success).toBe(true);
  });

  test('conveyor catalogue: the resource vocabulary is the integration\'s; bodies and filters forwarded', () => {
    expect([...CATALOGUE_RESOURCES]).toEqual([...PM_CATALOGUE_RESOURCES]);
    expect(cap('conveyor.create_catalogue_item').input.safeParse({ resource: 'card-types', anything: 1 }).success).toBe(true);
    expect(cap('conveyor.list_catalogue').input.safeParse({ resource: 'gates', limit: 'x', phase_id: 'p' }).success).toBe(true);
    // An unknown resource is the handler's own refusal (404, RM not called): library-tenant-parity / conveyor-catalogue tests.
    expect(cap('conveyor.list_catalogue').input.safeParse({ resource: 'nope' }).success).toBe(false);
  });

});

describe('P4a3 — the served spec', () => {
  test('every NEW operation is tagged with a declared tag and answers its declared responses', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, { tags: string[]; operationId: string; responses: Record<string, unknown> }>>;
    for (const { cap: c } of fresh) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags.length).toBe(1);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
      expect(Object.keys(op.responses).sort()).toEqual(
        [String(c.http.successStatus ?? 200), ...(c.openapi?.responses ?? []).map((r) => String(r.status))].sort(),
      );
    }
  });

  test('a FROZEN operation is served verbatim', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, unknown>>;
    for (const { cap: c } of frozen) expect(paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]).toEqual(c.openapi!.frozen);
  });
});
