// tests/unit/capabilities/project-documents-capabilities.test.ts
//
// R3 / DOC-3 — the declaration of capabilities/projects/documents.ts, pinned: the project's outputs
// (document trail) and the document reader's render proxy. User principal on the project read lane,
// project tenancy, out of agent scope, not on the licence route allowlist, served.
import { describe, expect, test } from 'bun:test';

import { PROJECT_DOCUMENT_CAPABILITIES } from '../../../src/capabilities/projects/documents';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openapiSpec } from '../../../src/capabilities/served-spec';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import { handlerRefOf } from '../../helpers/capabilities';

type Op = { operationId: string; parameters?: Array<{ name: string; in: string }> };

describe('R3 / DOC-3 project documents declaration (pinned)', () => {
  test('ids, routes, operationIds, principal, tenancy, effect, agent face, file, handlers', () => {
    expect(
      PROJECT_DOCUMENT_CAPABILITIES.map(
        (c) =>
          `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.auth.principal} ${c.tenancy} ${c.effect} ${c.agent.expose ? 'exposed' : c.agent.reason}`,
      ),
    ).toEqual([
      'projects.list_outputs GET /api/projects/:id/outputs projectsListOutputs user project read out-of-agent-scope',
      'projects.render_document GET /api/projects/:id/documents/:artifactId/render projectsRenderDocument user project read out-of-agent-scope',
    ]);
    const files = new Map(CAPABILITIES.map((e) => [e.cap.id, e.file]));
    expect(files.get('projects.list_outputs')).toBe('src/capabilities/projects/documents.ts');
    expect(files.get('projects.render_document')).toBe('src/capabilities/projects/documents.ts');
    expect(PROJECT_DOCUMENT_CAPABILITIES.map((c) => handlerRefOf(c.legacyHandler))).toEqual([
      expect.objectContaining({ module: 'src/routes/project-outputs.ts', exportName: 'handleGetProjectOutputs' }),
      expect.objectContaining({ module: 'src/routes/project-outputs.ts', exportName: 'handleRenderProjectDocument' }),
    ]);
  });

  test('neither is on the licence route allowlist', () => {
    expect(LICENCE_ROUTE_ALLOWLIST.some((r) => r.pattern.startsWith('/api/projects/') && (r.pattern.includes('/outputs') || r.pattern.includes('/documents/')))).toBe(false);
  });

  test('served: the render takes both path ids and the format query parameter', () => {
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
    expect(paths['/api/projects/{id}/outputs']!.get!.operationId).toBe('projectsListOutputs');
    const op = paths['/api/projects/{id}/documents/{artifactId}/render']!.get!;
    expect(op.operationId).toBe('projectsRenderDocument');
    expect((op.parameters ?? []).map((p) => `${p.in}:${p.name}`).sort()).toEqual(['path:artifactId', 'path:id', 'query:format']);
  });
});
