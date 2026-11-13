// tests/unit/capabilities/project-quality-people-capabilities.test.ts
//
// fr-agui SPEC §13 P2 (P2-c1) — the three project READS declared in
// capabilities/projects/quality-people.ts (spec drain of three openapi.ts literal
// operations): tenancy 'project', read-only, agent-exposed with the project as
// `/api/projects/:id`, the operationIds the literal had (frozen baseline). Pinned
// exactly, each handler ref resolves to a real export, the literal no longer
// carries these operations, and the served spec serves each once.

import { describe, expect, test } from 'bun:test';

import { PROJECT_QUALITY_PEOPLE_CAPABILITIES, QUALITY_PEOPLE_READ_TABLE } from '../../../src/capabilities/projects/quality-people';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openapiSpec, SERVED_SPEC_ORDER } from '../../../src/capabilities/served-spec';
import { getCapability, handlerRefOf } from '../../helpers/capabilities';

const ROUTE_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  'src/routes/project-quality.ts': () => import('../../../src/routes/project-quality'),
  'src/routes/project-knowledge-allocation.ts': () => import('../../../src/routes/project-knowledge-allocation'),
};

describe('the P2-c1 read declarations (pinned)', () => {
  test('ids, operationIds, routes, tenancy, effect, tier', () => {
    expect(
      PROJECT_QUALITY_PEOPLE_CAPABILITIES.map(
        (c) => `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.tenancy} ${c.effect} ${c.confirm} ${c.agent.expose ? c.agent.tier : 'hidden'}`,
      ),
    ).toEqual([
      'projects.get_quality GET /api/projects/:id/quality getProjectQuality project read none core',
      'projects.get_quality_history GET /api/projects/:id/quality/history getProjectQualityHistory project read none searchable',
      'projects.get_knowledge_allocation GET /api/projects/:id/knowledge-allocation getProjectKnowledgeAllocation project read none searchable',
    ]);
    const files = new Map(CAPABILITIES.map((e) => [e.cap.id, e.file]));
    for (const c of PROJECT_QUALITY_PEOPLE_CAPABILITIES) {
      expect(files.get(c.id)).toBe('src/capabilities/projects/quality-people.ts');
      expect(c.auth.rbac).toEqual({ type: 'project-member' });
    }
  });

  test('every handler ref names a real export (route and agent action)', async () => {
    const actions = (await import('../../../src/agui/actions/project-scope-people-quality')) as Record<string, unknown>;
    for (const c of PROJECT_QUALITY_PEOPLE_CAPABILITIES) {
      const legacy = handlerRefOf(c.legacyHandler)!;
      const agent = handlerRefOf(c.handler)!;
      const routes = await ROUTE_MODULES[legacy.module]!();
      expect(typeof routes[legacy.exportName]).toBe('function');
      expect([agent.module, typeof actions[agent.exportName]]).toEqual(['src/agui/actions/project-scope-people-quality.ts', 'function']);
    }
    expect(QUALITY_PEOPLE_READ_TABLE.map((r) => r.id)).toEqual(PROJECT_QUALITY_PEOPLE_CAPABILITIES.map((c) => c.id));
  });

  test('spec drain: the literal marks each operation as capability-placed; the served spec serves it once, same operationId', () => {
    const served = openapiSpec.paths as Record<string, Record<string, { operationId?: string }>>;
    for (const c of PROJECT_QUALITY_PEOPLE_CAPABILITIES) {
      const path = c.http.path!.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      // P4d-2e: the literal markers are gone; the served position is the served-spec lock's.
      expect(SERVED_SPEC_ORDER).toContain(`GET ${path}`);
      expect(served[path]?.get?.operationId).toBe(c.http.operationId);
    }
    // The writes of this unit were drained by P4d-2a as FROZEN operations: the allocation write
    // (knowledge_areas.set_project_allocation) and, in part 2, the analysis trigger.
    expect(getCapability('projects.analyze_quality')?.http.path).toBe('/api/projects/:id/quality/analyze');
    expect(getCapability('knowledge_areas.set_project_allocation')?.http.path).toBe('/api/projects/:id/knowledge-allocation/:userId');
  });

  test("the agent's input schema never lets the model name the project (the `id` is injected)", async () => {
    const { PROJECT_QUALITY_PEOPLE_READS } = await import('../../../src/agui/actions/project-scope-people-quality');
    for (const a of PROJECT_QUALITY_PEOPLE_READS) expect(a.projectParam).toBe('id');
  });
});
