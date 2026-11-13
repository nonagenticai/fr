// tests/unit/capabilities/conveyor-failures-capabilities.test.ts
//
// R311 PR 5 — the declarations of capabilities/conveyor/failures.ts, pinned:
// the two licence-only conveyor callbacks and the start-retry route. The
// callbacks are the conveyor seat's (licence allowlist, ops project.startFailed /
// project.coachFailed, never through the agent); the retry is a member's route
// whose agent face is the hand-written `projects.retry_conveyor_start` action.
import { describe, expect, test } from 'bun:test';

import {
  CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES,
  PROJECT_CONVEYOR_RETRY_CAPABILITIES,
} from '../../../src/capabilities/conveyor/failures';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openapiSpec } from '../../../src/capabilities/served-spec';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';

const ALL = [...CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES, ...PROJECT_CONVEYOR_RETRY_CAPABILITIES];
type Op = { operationId: string; security?: unknown; requestBody?: { content: Record<string, { schema: { required?: string[]; properties: Record<string, unknown> } }> }; 'x-internal'?: boolean };
const served = (path: string): Op => (openapiSpec.paths as unknown as Record<string, Record<string, Op>>)[path]!.post!;

describe('R311 PR 5 declarations (pinned)', () => {
  test('ids, routes, operationIds, principal, tenancy, effect, agent face', () => {
    expect(
      ALL.map(
        (c) =>
          `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.auth.principal} ${c.tenancy} ${c.effect} ${c.agent.expose ? 'exposed' : c.agent.reason}`,
      ),
    ).toEqual([
      'webhooks.n8n_project_start_failed POST /api/webhooks/n8n/project-start-failed n8nProjectStartFailed service tenant write service-to-service',
      'webhooks.n8n_project_coach_failed POST /api/webhooks/n8n/project-coach-failed n8nProjectCoachFailed service tenant write service-to-service',
      'projects.conveyor_start_retry POST /api/projects/:id/conveyor-start/retry projectsConveyorStartRetry user project write out-of-agent-scope',
    ]);
    const files = new Map(CAPABILITIES.map((e) => [e.cap.id, e.file]));
    for (const c of ALL) expect(files.get(c.id)).toBe('src/capabilities/conveyor/failures.ts');
  });

  test('licence parity: the two callbacks are exactly their allowlist rows; the retry has none', () => {
    for (const c of CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES) {
      const row = LICENCE_ROUTE_ALLOWLIST.find((r) => r.method === c.http.method && r.pattern === c.http.path);
      expect(row?.ops).toEqual(c.licence!.ops);
    }
    expect(CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES.map((c) => c.licence!.ops)).toEqual([
      ['project.startFailed'],
      ['project.coachFailed'],
    ]);
    expect(PROJECT_CONVEYOR_RETRY_CAPABILITIES[0]!.licence).toBeUndefined();
    expect(LICENCE_ROUTE_ALLOWLIST.some((r) => r.pattern === '/api/projects/:id/conveyor-start/retry')).toBe(false);
  });

  test('served: licence-token security, typed-client ops (not x-internal), the documented bodies', () => {
    const start = served('/api/webhooks/n8n/project-start-failed');
    expect(start.operationId).toBe('n8nProjectStartFailed');
    expect(start.security).toEqual([{ licenceToken: [] }]);
    expect(start['x-internal']).toBeUndefined();
    const sb = start.requestBody!.content['application/json']!.schema;
    expect([...sb.required!].sort()).toEqual(['error_text', 'execution_id', 'fr_project_id', 'stage']);
    expect(Object.keys(sb.properties).sort()).toEqual(['error_text', 'execution_id', 'fr_project_id', 'idempotency_key', 'rm_project_id', 'stage']);

    const coach = served('/api/webhooks/n8n/project-coach-failed');
    expect(coach.security).toEqual([{ licenceToken: [] }]);
    const cb = coach.requestBody!.content['application/json']!.schema;
    expect([...cb.required!].sort()).toEqual(['coach_execution_id', 'error_class', 'error_text', 'flow', 'node']);
    expect(Object.keys(cb.properties).sort()).toEqual([
      'card_id',
      'coach_execution_id',
      'error_class',
      'error_text',
      'flow',
      'fr_project_id',
      'node',
      'rm_project_id',
    ]);
    expect(served('/api/projects/{id}/conveyor-start/retry').operationId).toBe('projectsConveyorStartRetry');
  });
});
