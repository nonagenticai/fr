// tests/unit/capabilities/conveyor-flow-runs-capabilities.test.ts
//
// Cockpit A5 / R-CK5 — the declaration of capabilities/conveyor/flow-runs.ts, pinned: the n8n
// execution hook's ingest. Service-account only, never through the agent, not on the licence
// route allowlist, served as an x-internal operation.
import { describe, expect, test } from 'bun:test';

import { CONVEYOR_FLOW_RUN_CAPABILITIES } from '../../../src/capabilities/conveyor/flow-runs';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openapiSpec } from '../../../src/capabilities/served-spec';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';

type Op = { operationId: string; security?: unknown; 'x-internal'?: boolean };

describe('cockpit A5 flow-run ingest declaration (pinned)', () => {
  test('id, route, operationId, principal, tenancy, effect, agent face, file', () => {
    expect(
      CONVEYOR_FLOW_RUN_CAPABILITIES.map(
        (c) =>
          `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.auth.principal} ${c.tenancy} ${c.effect} ${c.agent.expose ? 'exposed' : c.agent.reason}`,
      ),
    ).toEqual([
      'internal.ingest_conveyor_flow_runs POST /api/internal/conveyor/flow-runs internalIngestConveyorFlowRuns service tenant write service-to-service',
    ]);
    const files = new Map(CAPABILITIES.map((e) => [e.cap.id, e.file]));
    expect(files.get('internal.ingest_conveyor_flow_runs')).toBe('src/capabilities/conveyor/flow-runs.ts');
  });

  test('not on the licence route allowlist (a licence token can never write flow runs)', () => {
    expect(LICENCE_ROUTE_ALLOWLIST.some((r) => r.pattern === '/api/internal/conveyor/flow-runs')).toBe(false);
    expect(CONVEYOR_FLOW_RUN_CAPABILITIES[0]!.licence).toBeUndefined();
  });

  test('served: bearer security, x-internal', () => {
    const op = (openapiSpec.paths as unknown as Record<string, Record<string, Op>>)['/api/internal/conveyor/flow-runs']!.post!;
    expect(op.operationId).toBe('internalIngestConveyorFlowRuns');
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op['x-internal']).toBe(true);
  });
});
