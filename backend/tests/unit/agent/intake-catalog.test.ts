// tests/unit/agent/intake-catalog.test.ts
//
// fr-agui SPEC §6.0 / §13 P1b acceptance: "the doorway catalog equals the
// declared set (guard)" — the RUNTIME half. Over the production registry
// (`registerAllActions()`, exactly what server.ts boots), the intake catalog a
// signed-in tenant user is shown equals DOORWAY_INTAKE_ACTIONS minus the
// explicitly pending DOORWAY_NOT_YET_REGISTERED members — no more (nothing
// outside the declared set leaks in) and no less (no declared member silently
// missing).

import { beforeAll, describe, expect, test } from 'bun:test';

import { listActions } from '../../../src/agui/registry';
import { registerAllActions } from '../../../src/agui/register-all-actions';
import type { ActionContext } from '../../../src/agui/types';
import { buildToolCatalog } from '../../../src/agent/tool-catalog';
import { DOORWAY_INTAKE_ACTIONS, DOORWAY_NOT_YET_REGISTERED } from '../../../src/agent/intake-catalog';
import { markAgentTokenContext } from '../../../src/agui/context-provenance';
import { catalogModeForThread } from '../../../src/routes/agent';

const ctx: ActionContext = {
  userId: 'u-intake',
  projectId: null,
  correlationId: 'cid-intake',
  initiator: 'agent',
  channel: 'web',
  tenantRoles: ['user'],
  tenantId: '0195f48b-d000-7000-8000-00000000a0c1',
};

beforeAll(async () => {
  await registerAllActions();
});

describe('the doorway catalog equals the declared set (booted registry)', () => {
  test('intake catalog == declared − not-yet-registered, exactly', async () => {
    const names = (await buildToolCatalog(ctx, { mode: 'intake' })).map((c) => c.name).sort();
    const expected = [...DOORWAY_INTAKE_ACTIONS].filter((id) => !DOORWAY_NOT_YET_REGISTERED.has(id)).sort();
    expect(names).toEqual(expected);
    expect(names).toEqual(
      [
        'conveyor.list_priority_levels',
        'conveyor.list_project_types',
        'project_requests.approve',
        'project_requests.draft_from_text',
        'project_requests.get',
        'project_requests.list',
        'project_requests.list_outlines',
        'project_requests.patch',
        'project_requests.reject',
        'project_requests.submit',
        'project_requests.verify_repo_access',
        'project_requests.withdraw',
        'projects.create',
        'projects.get',
        'projects.list',
        // P1c: the doorway's navigation intents (agui/actions/ui-navigate.ts).
        'ui.navigate',
        'ui.open_project',
      ].sort(),
    );
  });

  // fr-agui SPEC §13 P1c rail-retirement test (2): the doorway catalog equals the
  // declared intake set ON THE SERVER-DECIDED PATH — an unbound rail turn
  // (routes/agent.ts: mode from the thread, context marked as the rail). The client
  // can no longer ask for a wider catalog: `default` is gone from the rail.
  test('P1c (2): an UNBOUND rail turn gets exactly the declared doorway set, whatever the client sent', async () => {
    const rail = markAgentTokenContext({ ...ctx });
    const mode = catalogModeForThread(null);
    expect(mode).toBe('intake');
    const names = (await buildToolCatalog(rail, { mode })).map((c) => c.name).sort();
    expect(names).toEqual([...DOORWAY_INTAKE_ACTIONS].filter((id) => !DOORWAY_NOT_YET_REGISTERED.has(id)).sort());
    // Even the unfiltered mode cannot widen a RAIL context: agentSurfaceRefusal
    // (run by the RBAC dry-run) admits only doorway members when unbound.
    const widened = (await buildToolCatalog(rail, { mode: 'default' })).map((c) => c.name).sort();
    expect(widened).toEqual(names);
  });

  test('every pending member is genuinely unregistered (a registered one must leave the pending set)', () => {
    const registered = new Set(listActions().map((a) => a.name));
    for (const id of DOORWAY_NOT_YET_REGISTERED) expect({ id, registered: registered.has(id) }).toEqual({ id, registered: false });
  });

  test('the full registry is much larger than the doorway (the narrowing is real, not vacuous)', async () => {
    const all = listActions();
    const intake = await buildToolCatalog(ctx, { mode: 'intake' });
    expect(all.length).toBeGreaterThan(intake.length + 50);
    expect(intake.map((c) => c.name)).not.toContain('approvals.decide');
    expect(intake.map((c) => c.name)).not.toContain('project_requests.create');
  });
});
