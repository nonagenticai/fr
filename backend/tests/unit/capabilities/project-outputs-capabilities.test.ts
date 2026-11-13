// tests/unit/capabilities/project-outputs-capabilities.test.ts
//
// fr-agui SPEC §13 P2 (P2-c2) — capabilities/projects/outputs.ts: the artifact
// FileCard's mint route (F15). The governance.list_proposals read that lived here
// was removed with requirements_management's proposals route (RM #238); the
// Governance tab (conformance) is still an area the project agent may open.

import { describe, expect, test } from 'bun:test';

import { ARTIFACT_DOWNLOAD_TOKEN_CAPABILITIES } from '../../../src/capabilities/projects/outputs';
import { openapiSpec } from '../../../src/capabilities/served-spec';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { PROJECT_AREAS } from '../../../src/agui/actions/ui-navigate';
import { handlerRefOf } from '../../helpers/capabilities';

describe('the P2-c2 declarations (pinned)', () => {
  test('no governance proposals capability survives (RM #238 removed the upstream)', () => {
    const ids = CAPABILITIES.map((e) => e.cap.id);
    expect(ids).not.toContain('governance.list_proposals');
    expect(ids).not.toContain('architecture.list_governance_proposals');
  });

  test("F15: the FileCard's mint route is declared, never agent-exposed, its url + token secrets.output (x-secret in the served spec)", () => {
    expect(
      ARTIFACT_DOWNLOAD_TOKEN_CAPABILITIES.map(
        (c) => `${c.id} ${c.http.method} ${c.http.path} ${c.http.operationId} ${c.tenancy} ${c.agent.expose ? 'exposed' : c.agent.reason}`,
      ),
    ).toEqual(['artifacts.mint_download_token POST /api/assets/artifacts/:id/download-token artifactsMintDownloadToken tenant out-of-agent-scope']);
    const cap = ARTIFACT_DOWNLOAD_TOKEN_CAPABILITIES[0]!;
    expect(cap.secrets).toEqual({ output: ['/data/url', '/data/token'] });
    expect(handlerRefOf(cap.legacyHandler)).toEqual({ module: 'src/routes/assets/artifacts.ts', exportName: 'handleMintDownloadToken' });
    const op = (openapiSpec as any).paths['/api/assets/artifacts/{id}/download-token'].post;
    const data = op.responses['201'].content['application/json'].schema.properties.data.properties;
    expect([data.url['x-secret'], data.token['x-secret'], data.expires_at['x-secret']]).toEqual([true, true, undefined]);
  });

  test('the Governance tab is an area the project agent may open', () => {
    expect(PROJECT_AREAS).toContain('governance');
  });
});
