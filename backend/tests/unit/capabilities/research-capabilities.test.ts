// tests/unit/capabilities/research-capabilities.test.ts
//
// fr-agui SPEC §13 P4a2 — spec drain, research. The 58 research / media routes
// are declared as capabilities (src/capabilities/research/{discover,scientific,media}.ts)
// with NO behaviour change. These tests pin what that claim rests on:
//
//   * the declared set is EXACTLY the routes the P4a1 base (3dd76721e) pinned in
//     GRANDFATHERED_UNDECLARED under /api/research, each bound to the SAME
//     handler the route table used (handlers bind late, lazy.ts, so a typo'd
//     export would otherwise fail only at the first request);
//   * every declaration is a tenant capability, out-of-agent-scope, with a NEW
//     operationId = camelCase(id) (SPEC §3.3), and none is project-scoped;
//   * the declared inputs are no stricter than what the handlers accept;
//   * no agent action is derived: the research.* / media.* actions in the
//     catalog are still the hand-written ones (P1c retires them).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';

import type { Capability } from '../../../src/capabilities/define';
import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { RESEARCH_DISCOVER_CAPABILITIES } from '../../../src/capabilities/research/discover';
import { RESEARCH_MEDIA_CAPABILITIES } from '../../../src/capabilities/research/media';
import { RESEARCH_SCIENTIFIC_CAPABILITIES } from '../../../src/capabilities/research/scientific';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the /api/research pins of check-route-spec-coverage.ts @ 3dd76721e. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['GET', '/api/research/media/collections/{collectionId}', 'handleMediaCollection'],
  ['GET', '/api/research/media/collections', 'handleMediaCollections'],
  ['GET', '/api/research/media/items/{itemId}', 'handleMediaItem'],
  ['GET', '/api/research/media/items/{itemId}/related', 'handleMediaItemRelated'],
  ['GET', '/api/research/media/items/{itemId}/score', 'handleMediaItemScore'],
  ['GET', '/api/research/media/items/{itemId}/transcript', 'handleMediaItemTranscript'],
  ['POST', '/api/research/media/score/batch', 'handleMediaScoreBatch'],
  ['GET', '/api/research/media/score/report/{sessionId}', 'handleMediaScoreReport'],
  ['POST', '/api/research/media/search', 'handleMediaSearch'],
  ['GET', '/api/research/media/sources', 'handleMediaSources'],
  ['POST', '/api/research/discover/sessions/{sessionId}/review-export', 'handleResearchCreateReviewExport'],
  ['POST', '/api/research/discover/sessions', 'handleResearchCreateSession'],
  ['DELETE', '/api/research/discover/sessions/{sessionId}', 'handleResearchDeleteSession'],
  ['GET', '/api/research/scientific/explain/jobs/{jobId}', 'handleResearchExplainJobStatus'],
  ['POST', '/api/research/scientific/explain/subgraphx', 'handleResearchExplainSubgraphx'],
  ['GET', '/api/research/discover/sessions/{sessionId}/export', 'handleResearchExportSession'],
  ['GET', '/api/research/scientific/formal/proofs/{claimId}', 'handleResearchFormalProofGet'],
  ['POST', '/api/research/scientific/formal/proofs/{claimId}', 'handleResearchFormalProofStore'],
  ['POST', '/api/research/scientific/formal/translate', 'handleResearchFormalTranslate'],
  ['POST', '/api/research/scientific/formal/verify', 'handleResearchFormalVerify'],
  ['GET', '/api/research/discover/papers/{paperId}', 'handleResearchGetPaper'],
  ['GET', '/api/research/discover/sessions/{sessionId}/review-export/{batchId}', 'handleResearchGetReviewExport'],
  ['GET', '/api/research/discover/sessions/{sessionId}', 'handleResearchGetSession'],
  ['POST', '/api/research/discover/ingest/push', 'handleResearchIngestPush'],
  ['GET', '/api/research/discover/ingest/push/{pushId}', 'handleResearchIngestPushStatus'],
  ['GET', '/api/research/discover/sessions/{sessionId}/review-export', 'handleResearchListReviewExports'],
  ['GET', '/api/research/discover/papers/{paperId}/{kind}', 'handleResearchPaperRelated'],
  ['POST', '/api/research/discover/sessions/{sessionId}/pause', 'handleResearchPauseSession'],
  ['GET', '/api/research/scientific/pipeline/anomalies', 'handleResearchPipelineAnomalies'],
  ['POST', '/api/research/scientific/pipeline/batch', 'handleResearchPipelineBatch'],
  ['GET', '/api/research/scientific/pipeline/history/{entityId}', 'handleResearchPipelineHistory'],
  ['GET', '/api/research/scientific/pipeline/status', 'handleResearchPipelineStatus'],
  ['POST', '/api/research/scientific/pipeline/trigger', 'handleResearchPipelineTrigger'],
  ['POST', '/api/research/discover/sessions/{sessionId}/resume', 'handleResearchResumeSession'],
  ['POST', '/api/research/scientific/sandbox/execute', 'handleResearchSandboxExecute'],
  ['GET', '/api/research/scientific/sandbox/jobs/{jobId}', 'handleResearchSandboxJob'],
  ['GET', '/api/research/scientific/sandbox/results/{jobId}', 'handleResearchSandboxResult'],
  ['POST', '/api/research/discover/score/batch', 'handleResearchScoreBatch'],
  ['POST', '/api/research/discover/score', 'handleResearchScorePaper'],
  ['GET', '/api/research/discover/score/report/{sessionId}', 'handleResearchScoreReport'],
  ['POST', '/api/research/discover/search', 'handleResearchSearch'],
  ['POST', '/api/research/discover/search/semantic', 'handleResearchSemanticSearch'],
  ['GET', '/api/research/discover/sessions/{sessionId}/insights', 'handleResearchSessionInsights'],
  ['POST', '/api/research/discover/snowball/{jobId}/cancel', 'handleResearchSnowballCancel'],
  ['POST', '/api/research/discover/snowball', 'handleResearchSnowballStart'],
  ['GET', '/api/research/discover/snowball/{jobId}', 'handleResearchSnowballStatus'],
  ['GET', '/api/research/discover/sources', 'handleResearchSources'],
  ['POST', '/api/research/scientific/stats/confidence-interval', 'handleResearchStatsConfidenceInterval'],
  ['POST', '/api/research/scientific/stats/meta-analysis', 'handleResearchStatsMetaAnalysis'],
  ['POST', '/api/research/scientific/stats/trend', 'handleResearchStatsTrend'],
  ['POST', '/api/research/scientific/topology/authority', 'handleResearchTopologyAuthority'],
  ['POST', '/api/research/scientific/topology/communities', 'handleResearchTopologyCommunities'],
  ['POST', '/api/research/scientific/topology/contradictions', 'handleResearchTopologyContradictions'],
  ['POST', '/api/research/scientific/topology/subgraph', 'handleResearchTopologySubgraph'],
  ['PATCH', '/api/research/discover/sessions/{sessionId}', 'handleResearchUpdateSession'],
  ['POST', '/api/research/scientific/verify/cove', 'handleResearchVerifyCove'],
  ['POST', '/api/research/scientific/verify/integrity', 'handleResearchVerifyIntegrity'],
  ['POST', '/api/research/scientific/verify/ragas', 'handleResearchVerifyRagas'],
];

const research = CAPABILITIES.filter((e) => e.cap.http.path?.startsWith('/api/research/'));
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;
const byId = new Map<string, Capability<unknown, unknown>>(research.map((e) => [e.cap.id, e.cap]));
function cap(id: string): Capability<unknown, unknown> {
  const c = byId.get(id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
}

describe('P4a2 — the research declarations', () => {
  test('are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    const declared = research.map(
      (e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const,
    );
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
  });

  test('each group is declared in its own module and binds its own route module', () => {
    const groups: Array<[ReadonlyArray<Capability<unknown, unknown>>, string, string]> = [
      [RESEARCH_DISCOVER_CAPABILITIES, '/api/research/discover/', 'src/routes/research/discover.ts'],
      [RESEARCH_SCIENTIFIC_CAPABILITIES, '/api/research/scientific/', 'src/routes/research/scientific.ts'],
      [RESEARCH_MEDIA_CAPABILITIES, '/api/research/media/', 'src/routes/research/media.ts'],
    ];
    for (const [caps, prefix, module] of groups) {
      expect(caps.length).toBeGreaterThan(0);
      for (const c of caps) {
        expect(`${c.id} ${c.http.path!.startsWith(prefix)} ${handlerRefOf(c.legacyHandler)?.module}`).toBe(
          `${c.id} true ${module}`,
        );
      }
    }
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of research) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(
        `${ref.module}#${ref.exportName}: function`,
      );
    }
  });

  test('tenant-scoped (none project-scoped), out-of-agent-scope, operationId = camelCase(id)', () => {
    for (const { cap: c } of research) {
      const area = c.http.path!.startsWith('/api/research/media/') ? 'media' : 'research';
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.area} ${c.auth.principal}`).toBe(
        `${c.id} tenant {"expose":false,"reason":"out-of-agent-scope"} ${area} user`,
      );
      expect(c.http.operationId).toBe(camel(c.id));
    }
  });

  test('no route in these groups takes a project: no handler or integration mentions one', () => {
    for (const f of [
      'src/routes/research/discover.ts',
      'src/routes/research/scientific.ts',
      'src/routes/research/media.ts',
      'src/integrations/research.ts',
      'src/integrations/media.ts',
    ]) {
      const src = readFileSync(join(BACKEND, f), 'utf8');
      expect(`${f} ${/project/i.test(src)}`).toBe(`${f} false`);
    }
  });

  test('the research routes are no longer router.add rows in server.ts (deriveRouter registers them)', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    expect(server).not.toMatch(/router\.add\(\s*'[A-Z]+',\s*'\/api\/research\//);
    expect(server).not.toContain("from './routes/research/");
  });

  test('effects: GETs read; the writes and the one delete are what the handlers can change upstream', () => {
    for (const { cap: c } of research) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
    }
    const del = cap('research.delete_session');
    expect(`${del.effect} ${del.confirm}`).toBe('destructive card-typed');
    const writes = research
      .filter((e) => e.cap.effect === 'write')
      .map((e) => e.cap.id)
      .sort();
    expect(writes).toEqual([
      'research.cancel_snowball',
      'research.create_review_export',
      'research.create_session',
      'research.ingest_push',
      'research.pause_session',
      'research.pipeline_batch',
      'research.pipeline_trigger',
      'research.resume_session',
      'research.sandbox_execute',
      'research.search',
      'research.start_snowball',
      'research.store_proof',
      'research.update_session',
      'research.verify_integrity',
    ]);
    for (const c of RESEARCH_MEDIA_CAPABILITIES) expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
  });

  test('the create_review_export route declares 201', () => {
    const non200 = research
      .filter((e) => e.cap.http.successStatus !== undefined)
      .map((e) => [e.cap.id, e.cap.http.successStatus]);
    expect(non200).toEqual([['research.create_review_export', 201]]);
  });
});

describe('P4a2 — declared inputs are no stricter than the routes', () => {
  test('a forwarded body keeps every key the caller sent (passthrough), e.g. search.session_id', () => {
    const parsed = cap('research.search').input.safeParse({ query: 'q', session_id: 's', anything: { nested: 1 } });
    expect(parsed.success && (parsed.data as Record<string, unknown>).session_id).toBe('s');
    expect(cap('media.search').input.safeParse({ q: 'x', extra: true }).success).toBe(true);
    expect(cap('research.update_session').input.safeParse({ sessionId: 's', status: 'whatever-upstream-accepts' }).success).toBe(true);
  });

  test('a require*Field field accepts any non-empty value of its type; an array field any items', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['research.semantic_search', { query: 'q' }],
      ['research.verify_integrity', { entity_id: 'e' }],
      ['research.verify_cove', { claim_text: 'c' }],
      ['research.topology_contradictions', { entity_id: 'e' }],
      ['research.topology_subgraph', { entity_id: 'e' }],
      ['research.topology_authority', { entity_id: 'e' }],
      ['research.explain_subgraphx', { node_id: 'n' }],
      ['research.stats_meta_analysis', { studies: [1, 'two', { three: 3 }] }],
      ['research.stats_confidence_interval', { values: ['not-a-number'] }],
      ['research.formal_translate', { claim_text: 'c' }],
      ['research.store_proof', { claimId: 'x', expression: 'e' }],
      ['research.pipeline_trigger', { entity_ids: [{}] }],
      ['research.sandbox_execute', { code: 'c' }],
    ];
    for (const [id, input] of cases) expect(`${id} ${cap(id).input.safeParse(input).success}`).toBe(`${id} true`);
    // …and the declared refusals are refusals the handler makes too (400).
    expect(cap('research.semantic_search').input.safeParse({}).success).toBe(false);
    expect(cap('research.pipeline_trigger').input.safeParse({ entity_ids: [] }).success).toBe(false);
  });

  test('query parameters: export format is optional; anomalies threshold is any string', () => {
    const exp = cap('research.export_session');
    expect(exp.input.safeParse({ sessionId: 's' }).success).toBe(true);
    for (const f of ['json', 'bibtex', 'ris']) expect(exp.input.safeParse({ sessionId: 's', format: f }).success).toBe(true);
    expect(cap('research.pipeline_anomalies').input.safeParse({}).success).toBe(true);
    expect(cap('research.pipeline_anomalies').input.safeParse({ threshold: 'not-a-number' }).success).toBe(true);
  });

  test('path ids are free strings (the integrations encodeURIComponent them)', () => {
    expect(cap('media.get_item').input.safeParse({ itemId: 'a b/c?d' }).success).toBe(true);
    expect(cap('research.get_paper_related').input.safeParse({ paperId: 'x', kind: 'references' }).success).toBe(true);
  });

  test('the served spec: query params optional, the body admits extra keys, required fields listed', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    type Op = {
      parameters?: Array<{ name: string; in: string; required: boolean }>;
      requestBody?: { content: Record<string, { schema: { additionalProperties?: boolean; required?: string[] } }> };
    };
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
    const exp = paths['/api/research/discover/sessions/{sessionId}/export']!.get!;
    expect(exp.parameters!.map((p) => `${p.in}:${p.name}:${p.required}`)).toEqual(['path:sessionId:true', 'query:format:false']);
    const search = paths['/api/research/discover/search']!.post!;
    expect(search.requestBody!.content['application/json']!.schema.additionalProperties).toBe(true);
    const sem = paths['/api/research/discover/search/semantic']!.post!;
    expect(sem.requestBody!.content['application/json']!.schema.required).toEqual(['query']);
  });
});

describe('P4a2 — the agent catalog is untouched', () => {
  test('no research / media capability is agent-exposed, so none is derived into the catalog', () => {
    for (const { cap: c } of research) expect(c.agent.expose).toBe(false);
  });

  test('the hand-written research.* / media.* actions keep their own (stricter) schemas', async () => {
    // Idempotent (safeRegister), and no reset: the registry is process-global and
    // other files in the same run may rely on what is already registered.
    const { getAction } = await import('../../../src/agui/registry');
    const { registerResearchActions } = await import('../../../src/agui/actions/research');
    const { registerMediaActions } = await import('../../../src/agui/actions/media');
    registerResearchActions();
    registerMediaActions();
    // research.search refuses a session_id (no persisting variant via the agent); the route accepts one.
    const action = getAction('research.search')!;
    expect((action.input as z.ZodTypeAny).safeParse({ query: 'q', session_id: 's' }).success).toBe(false);
    expect(cap('research.search').input.safeParse({ query: 'q', session_id: 's' }).success).toBe(true);
    expect(getAction('media.search')).toBeDefined();
  });
});
