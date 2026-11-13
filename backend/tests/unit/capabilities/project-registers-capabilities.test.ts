// tests/unit/capabilities/project-registers-capabilities.test.ts
//
// R2 / REG-3 — the declaration of capabilities/projects/registers.ts, pinned: the project's
// registers, a read-only proxy of RM #240. A user principal on the project read lane, project
// tenancy, out of agent scope, not on the licence route allowlist, served as a public operation.
import { describe, expect, test } from 'bun:test';

import { PROJECT_REGISTER_CAPABILITIES } from '../../../src/capabilities/projects/registers';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openapiSpec } from '../../../src/capabilities/served-spec';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import { handlerRefOf } from '../../helpers/capabilities';

type Op = { operationId: string; parameters?: Array<{ name: string; in: string }> };

describe('R2 project registers declaration (pinned)', () => {
  test('id, route, operationId, principal, tenancy, effect, agent face, file, handler', () => {
    expect(
      PROJECT_REGISTER_CAPABILITIES.map(
        (c) =>
          `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.auth.principal} ${c.tenancy} ${c.effect} ${c.agent.expose ? 'exposed' : c.agent.reason}`,
      ),
    ).toEqual(['projects.get_registers GET /api/projects/:id/registers projectsGetRegisters user project read out-of-agent-scope']);
    const files = new Map(CAPABILITIES.map((e) => [e.cap.id, e.file]));
    expect(files.get('projects.get_registers')).toBe('src/capabilities/projects/registers.ts');
    expect(handlerRefOf(PROJECT_REGISTER_CAPABILITIES[0]!.legacyHandler)).toMatchObject({
      module: 'src/routes/project-registers.ts',
      exportName: 'handleGetProjectRegisters',
    });
  });

  test('not on the licence route allowlist', () => {
    expect(LICENCE_ROUTE_ALLOWLIST.some((r) => r.pattern.includes('/registers'))).toBe(false);
  });

  test('served with its id path parameter and the phase query parameter', () => {
    const op = (openapiSpec.paths as unknown as Record<string, Record<string, Op>>)['/api/projects/{id}/registers']!.get!;
    expect(op.operationId).toBe('projectsGetRegisters');
    expect((op.parameters ?? []).map((p) => `${p.in}:${p.name}`).sort()).toEqual(['path:id', 'query:phase']);
  });
});
