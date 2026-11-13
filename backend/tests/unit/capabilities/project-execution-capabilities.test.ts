// tests/unit/capabilities/project-execution-capabilities.test.ts
//
// fr-agui SPEC §13 P3 — the six execution-observability reads declared in
// capabilities/projects/execution.ts: NEW project routes, tenancy 'project',
// read-only, agent-exposed with the project as `/api/projects/:id`. Pinned
// exactly (ids, operationIds, routes, tiers), each handler ref resolves to a
// real export, and the agent's input schema never lets the model choose the
// project (the `id` is stripped and injected, SPEC §5.7 rule 3).

import { describe, expect, test } from 'bun:test';

import { PROJECT_EXECUTION_CAPABILITIES, EXECUTION_READ_TABLE } from '../../../src/capabilities/projects/execution';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { PROJECT_AREAS } from '../../../src/agui/actions/ui-navigate';
import { handlerRefOf } from '../../helpers/capabilities';

describe('the P3 declarations (pinned)', () => {
  test('ids, operationIds, routes, tenancy, effect, tier', () => {
    expect(
      PROJECT_EXECUTION_CAPABILITIES.map(
        (c) => `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.tenancy} ${c.effect} ${c.confirm} ${c.agent.expose ? c.agent.tier : 'hidden'}`,
      ),
    ).toEqual([
      'projects.list_executions GET /api/projects/:id/executions projectsListExecutions project read none core',
      'projects.get_wip GET /api/projects/:id/wip projectsGetWip project read none core',
      'projects.list_blocked_cards GET /api/projects/:id/blocked-cards projectsListBlockedCards project read none core',
      'projects.list_agent_actions GET /api/projects/:id/agent-actions projectsListAgentActions project read none searchable',
      'projects.list_cards_by_type GET /api/projects/:id/cards-by-type projectsListCardsByType project read none searchable',
      'projects.list_conveyor_executions GET /api/projects/:id/conveyor-executions projectsListConveyorExecutions project read none searchable',
      'projects.list_conveyor_notices GET /api/projects/:id/conveyor-notices projectsListConveyorNotices project read none core',
      'projects.list_flow_runs GET /api/projects/:id/flow-runs projectsListFlowRuns project read none searchable',
    ]);
    const files = new Map(CAPABILITIES.map((e) => [e.cap.id, e.file]));
    for (const c of PROJECT_EXECUTION_CAPABILITIES) expect(files.get(c.id)).toBe('src/capabilities/projects/execution.ts');
    for (const c of PROJECT_EXECUTION_CAPABILITIES) expect(c.auth.rbac).toEqual({ type: 'project-member' });
  });

  test('every handler ref names a real export (route and agent action)', async () => {
    const routes = (await import('../../../src/routes/project-execution')) as Record<string, unknown>;
    const actions = (await import('../../../src/agui/actions/project-execution')) as Record<string, unknown>;
    for (const c of PROJECT_EXECUTION_CAPABILITIES) {
      const legacy = handlerRefOf(c.legacyHandler)!;
      const agent = handlerRefOf(c.handler)!;
      expect([legacy.module, typeof routes[legacy.exportName]]).toEqual(['src/routes/project-execution.ts', 'function']);
      expect([agent.module, typeof actions[agent.exportName]]).toEqual(['src/agui/actions/project-execution.ts', 'function']);
    }
    expect(EXECUTION_READ_TABLE.map((r) => r.id)).toEqual(PROJECT_EXECUTION_CAPABILITIES.map((c) => c.id));
  });

  test('Flow runs (R5: the Execution hub + Project executions, merged) is an area the project agent may open', () => {
    expect(PROJECT_AREAS).toContain('flow-runs');
    // The old pages are 308 stubs to it; the agent is never sent through a redirect.
    expect(PROJECT_AREAS).not.toContain('execution');
    expect(PROJECT_AREAS).not.toContain('executions');
  });
});
