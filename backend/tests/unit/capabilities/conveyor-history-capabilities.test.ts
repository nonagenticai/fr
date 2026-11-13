// tests/unit/capabilities/conveyor-history-capabilities.test.ts
//
// The declaration of capabilities/projects/conveyor-history.ts, pinned: one project READ
// (GET /api/projects/:id/conveyor-history), user principal, out-of-agent-scope, served once.
import { describe, expect, test } from 'bun:test';

import { PROJECT_CONVEYOR_HISTORY_CAPABILITIES } from '../../../src/capabilities/projects/conveyor-history';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openapiSpec } from '../../../src/capabilities/served-spec';

describe('project conveyor history declaration (pinned)', () => {
  test('id, route, operationId, principal, tenancy, effect, agent face, file', () => {
    expect(
      PROJECT_CONVEYOR_HISTORY_CAPABILITIES.map(
        (c) =>
          `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.auth.principal} ${c.tenancy} ${c.effect} ${c.agent.expose ? 'exposed' : c.agent.reason}`,
      ),
    ).toEqual([
      'projects.get_conveyor_history GET /api/projects/:id/conveyor-history projectsGetConveyorHistory user project read out-of-agent-scope',
    ]);
    const files = CAPABILITIES.filter((e) => e.cap.id === 'projects.get_conveyor_history').map((e) => e.file);
    expect(files).toEqual(['src/capabilities/projects/conveyor-history.ts']);
  });

  test('served once, with its operationId', () => {
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, { operationId: string }>>;
    expect(paths['/api/projects/{id}/conveyor-history']!.get!.operationId).toBe('projectsGetConveyorHistory');
  });
});
