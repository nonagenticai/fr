// tests/unit/capabilities/kag-capabilities.test.ts
//
// fr-agui SPEC §13 P4a1 — spec drain, KAG. The 65 KAG routes are declared as
// capabilities (src/capabilities/kag/{assets,tools}.ts) with NO behaviour change.
// These tests pin what that claim rests on:
//
//   * the declared set is EXACTLY the routes formerly pinned undeclared (minus the
//     two P2 project-document rows), each bound to the SAME handler the route
//     table used — a typo'd `exportName` would otherwise only fail at the first
//     request, because handlers are bound late (lazy.ts);
//   * every declaration is a tenant capability, `out-of-agent-scope`, with a
//     NEW operationId = camelCase(id) (SPEC §3.3);
//   * the tools/kag declarations derive from the very zod objects the `kag.*`
//     AG-UI actions validate with, so the derived spec rejects what the action
//     rejects — and no second agent action is derived (the catalog is P1c's).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Capability } from '../../../src/capabilities/define';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { KAG_ASSET_CAPABILITIES } from '../../../src/capabilities/kag/assets';
import { kagReadsJsonBody } from '../../../src/capabilities/kag/_body';
import { KAG_TOOL_CAPABILITIES } from '../../../src/capabilities/kag/tools';
import * as kagSchemas from '../../../src/routes/tools/kag-schemas';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/**
 * [METHOD, OpenAPI path, handler] for every KAG route the P0b base pinned in
 * GRANDFATHERED_UNDECLARED (check-route-spec-coverage.ts @ 061a9e90f), minus
 * `GET /api/assets/kag/documents` and `DELETE /api/assets/kag/documents/{nodeId}`
 * (reserved for P2). A `(req, id) => handleX(req, id)` pin is listed as handleX.
 */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['POST', '/api/assets/kag/ask', 'handleKagAsk'],
  ['POST', '/api/assets/kag/batch-similarity', 'handleKagBatchSimilarity'],
  ['GET', '/api/assets/kag/benchmarks', 'handleKagBenchmarks'],
  ['POST', '/api/assets/kag/chunk-search', 'handleKagChunkSearch'],
  ['GET', '/api/assets/kag/entities', 'handleKagListEntities'],
  ['GET', '/api/assets/kag/formats', 'handleKagListSupportedFormats'],
  ['POST', '/api/assets/kag/graph-query', 'handleKagExecuteGraphQuery'],
  ['POST', '/api/assets/kag/graph-query/optimized', 'handleKagExecuteOptimizedQuery'],
  ['POST', '/api/assets/kag/graph/analytics/centrality', 'handleKagCalculateCentrality'],
  ['POST', '/api/assets/kag/graph/analytics/community', 'handleKagDetectCommunities'],
  ['POST', '/api/assets/kag/graph/analytics/path', 'handleKagFindGraphPaths'],
  ['POST', '/api/assets/kag/graph/bulk/export', 'handleKagBulkExport'],
  ['GET', '/api/assets/kag/graph/edges', 'handleKagQueryGraphEdges'],
  ['GET', '/api/assets/kag/graph/edges/{edgeId}', 'handleKagGetGraphEdge'],
  ['GET', '/api/assets/kag/graph/node-types', 'handleKagGetGraphNodeTypes'],
  ['GET', '/api/assets/kag/graph/nodes', 'handleKagQueryGraphNodes'],
  ['GET', '/api/assets/kag/graph/nodes/{nodeId}', 'handleKagGetGraphNode'],
  ['GET', '/api/assets/kag/graph/stats', 'handleKagGetGraphStats'],
  ['POST', '/api/assets/kag/hierarchical-retrieval', 'handleKagHierarchicalRetrieval'],
  ['GET', '/api/assets/kag/ingest/documents/jobs', 'handleKagListDocumentJobs'],
  ['POST', '/api/assets/kag/ingest/documents/jobs/clear', 'handleKagClearDocumentJobs'],
  ['DELETE', '/api/assets/kag/ingest/documents/jobs/{jobId}', 'handleKagDeleteDocumentJob'],
  ['POST', '/api/assets/kag/ml/attention', 'handleKagComputeAttention'],
  ['POST', '/api/assets/kag/ml/embeddings', 'handleKagGenerateEmbeddings'],
  ['GET', '/api/assets/kag/ml/models', 'handleKagListMlModels'],
  ['POST', '/api/assets/kag/ml/similarity', 'handleKagMlSimilarity'],
  ['POST', '/api/assets/kag/nlp/detect-language', 'handleKagDetectLanguage'],
  ['POST', '/api/assets/kag/nlp/entities', 'handleKagExtractEntities'],
  ['POST', '/api/assets/kag/nlp/entity-density', 'handleKagEntityDensity'],
  ['POST', '/api/assets/kag/nlp/parse', 'handleKagParseText'],
  ['POST', '/api/assets/kag/nlp/segment', 'handleKagSegmentText'],
  ['POST', '/api/assets/kag/nlp/similarity', 'handleKagTextSimilarity'],
  ['POST', '/api/assets/kag/nlp/text-quality', 'handleKagTextQuality'],
  ['POST', '/api/assets/kag/pipeline/jobs', 'handleKagSubmitPipeline'],
  ['DELETE', '/api/assets/kag/pipeline/jobs/{jobId}', 'handleKagDeleteJob'],
  ['GET', '/api/assets/kag/pipeline/jobs/{jobId}', 'handleKagJobStatus'],
  ['POST', '/api/assets/kag/pipeline/jobs/{jobId}/cancel', 'handleKagCancelJob'],
  ['POST', '/api/assets/kag/pipeline/jobs/{jobId}/resume', 'handleKagResumeJob'],
  ['POST', '/api/assets/kag/process/decompose', 'handleKagDecomposeDocument'],
  ['POST', '/api/assets/kag/process/enrich', 'handleKagEnrichDocument'],
  ['GET', '/api/assets/kag/provenance/source-page', 'handleKagResolveSourcePage'],
  ['GET', '/api/assets/kag/scrape-sessions', 'handleKagListScrapeSessions'],
  ['GET', '/api/assets/kag/scrape-sessions/{sessionId}', 'handleKagGetScrapeSessionDetail'],
  ['POST', '/api/assets/kag/search', 'handleKagSemanticSearch'],
  ['POST', '/api/assets/kag/similar-nodes', 'handleKagFindSimilarNodes'],
  ['POST', '/api/tools/kag/documents', 'handleUploadDocument'],
  ['POST', '/api/tools/kag/documents/batch/{id}/retry-failed', 'handleRetryFailedBatch'],
  ['GET', '/api/tools/kag/documents/batch/{id}/status', 'handleGetBatchStatus'],
  ['GET', '/api/tools/kag/documents/jobs/{id}', 'handleGetDocumentJob'],
  ['GET', '/api/tools/kag/documents/jobs/{id}/images', 'handleListDocumentImages'],
  ['GET', '/api/tools/kag/documents/jobs/{id}/images/{imageId}/download', 'handleDownloadDocumentImage'],
  ['POST', '/api/tools/kag/documents/sync', 'handleUploadDocumentSync'],
  ['POST', '/api/tools/kag/scrape/bulk', 'handleScrapeBulk'],
  ['POST', '/api/tools/kag/scrape/refresh', 'handleScrapeRefresh'],
  ['POST', '/api/tools/kag/scrape/refresh-source', 'handleRefreshSource'],
  ['GET', '/api/tools/kag/scrape/sessions', 'handleListSessions'],
  ['DELETE', '/api/tools/kag/scrape/sessions/{id}', 'handleCancelSession'],
  ['GET', '/api/tools/kag/scrape/sessions/{id}', 'handleGetSession'],
  ['GET', '/api/tools/kag/scrape/sessions/{id}/images', 'handleListSessionImages'],
  ['GET', '/api/tools/kag/scrape/sessions/{id}/images/{imageId}/download', 'handleDownloadSessionImage'],
  ['POST', '/api/tools/kag/scrape/sessions/{id}/pause', 'handlePauseSession'],
  ['POST', '/api/tools/kag/scrape/sessions/{id}/resume', 'handleResumeSession'],
  ['GET', '/api/tools/kag/scrape/sessions/{id}/screenshot', 'handleGetSessionScreenshot'],
  ['POST', '/api/tools/kag/scrape/sitemap', 'handleScrapeSitemap'],
  ['POST', '/api/tools/kag/scrape/url', 'handleScrapeUrl'],
];

// P4d-2c declared the two project-document rows P4a1 reserved for P2 (capabilities/library/asset-surfaces.ts).
// P4d-2e: the Evidence Review passthrough rows (area kag, capabilities/kag/reviews-passthrough.ts) are excluded here (their P4d-2e pinning suite was deleted 2026-10-29).
const kag = CAPABILITIES.filter((e) => e.cap.area === 'kag' && e.file !== 'src/capabilities/library/asset-surfaces.ts' && e.file !== 'src/capabilities/kag/reviews-passthrough.ts');
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;

describe('P4a1 — the KAG declarations', () => {
  test('are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    const declared = kag.map(
      (e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const,
    );
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap } of kag) {
      const ref = handlerRefOf(cap.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(
        `${ref.module}#${ref.exportName}: function`,
      );
    }
  });

  test('tenant-scoped, out-of-agent-scope, with operationId = camelCase(id) (new operations, SPEC §3.3)', () => {
    for (const { cap } of kag) {
      expect(`${cap.id} ${cap.tenancy} ${JSON.stringify(cap.agent)}`).toBe(
        `${cap.id} tenant {"expose":false,"reason":"out-of-agent-scope"}`,
      );
      expect(cap.http.operationId).toBe(camel(cap.id));
    }
  });

  test('the two project-document routes P4a1 reserved for P2 are declared by P4d-2c (asset-surfaces.ts), not here, and are no router.add rows', () => {
    const owner = (k: string) => CAPABILITIES.find((e) => `${e.cap.http.method} ${e.cap.http.path}` === k)?.file;
    expect(owner('GET /api/assets/kag/documents')).toBe('src/capabilities/library/asset-surfaces.ts');
    expect(owner('DELETE /api/assets/kag/documents/:nodeId')).toBe('src/capabilities/library/asset-surfaces.ts');
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    expect(server).not.toContain("router.add('GET', '/api/assets/kag/documents', handleKagListDocuments);");
    expect(server).not.toContain("router.add('DELETE', '/api/assets/kag/documents/:nodeId', handleDeleteKagDocument);");
  });

  test('effects: deletes / clear are destructive; the workspace-admin job verbs declare that rule; GETs read', () => {
    const byId = new Map<string, Capability<unknown, unknown>>(kag.map((e) => [e.cap.id, e.cap]));
    for (const id of ['kag.clear_document_jobs', 'kag.delete_document_job', 'kag.delete_pipeline_job', 'kag.cancel_session']) {
      expect(`${id} ${byId.get(id)!.effect} ${byId.get(id)!.confirm}`).toBe(`${id} destructive card-typed`);
    }
    for (const id of [
      'kag.clear_document_jobs',
      'kag.delete_document_job',
      'kag.submit_pipeline',
      'kag.cancel_pipeline_job',
      'kag.resume_pipeline_job',
      'kag.delete_pipeline_job',
    ]) {
      // isWorkspaceAdminVia, not a realm-string match, and ROUTE-AWARE since P4c part 2 (P4-carry: validateAuth's
      // licence / conveyor doors).
      const c = byId.get(id)!;
      expect(c.auth.rbac).toEqual({ type: 'workspace-admin', route: { method: c.http.method, path: c.http.path! } });
    }
    for (const { cap } of kag) {
      if (cap.http.method === 'GET') expect(`${cap.id} ${cap.effect}`).toBe(`${cap.id} read`);
    }
  });

  test('declared inputs are no stricter than the routes: project_id may be null, ask.mode is any string', () => {
    const byId = new Map<string, Capability<unknown, unknown>>(kag.map((e) => [e.cap.id, e.cap]));
    // scopeKagCallToProject treats null exactly like omitted.
    for (const id of ['kag.semantic_search', 'kag.chunk_search', 'kag.ask']) {
      const base = id === 'kag.ask' ? { query: 'q' } : {};
      expect(`${id} ${byId.get(id)!.input.safeParse({ ...base, project_id: null }).success}`).toBe(`${id} true`);
    }
    // handleKagAsk forwards body.mode unchecked.
    expect(byId.get('kag.ask')!.input.safeParse({ query: 'q', mode: 'some_future_mode' }).success).toBe(true);
  });

  test('the served spec declares the responses the handlers really give (401 admin, 202 park, 429 rate limit)', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, { responses: Record<string, unknown> }>>;
    const op = (c: Capability<unknown, unknown>) => paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
    const codes = (c: Capability<unknown, unknown>) => Object.keys(op(c).responses).sort().join(',');
    const ADMIN = new Set([
      'kag.clear_document_jobs', 'kag.delete_document_job', 'kag.submit_pipeline',
      'kag.cancel_pipeline_job', 'kag.resume_pipeline_job', 'kag.delete_pipeline_job',
    ]);
    // P4d-1 (real-pipeline parity): every one also declares the 403 doors (the server's licence route door,
    // validateAuth's conveyor write door) and, when it reads a JSON body, the 400 a non-JSON one gets.
    const body400 = (c: Capability<unknown, unknown>) =>
      c.http.requestBody === undefined && kagReadsJsonBody(c.http.method, c.http.path!, c.input) ? ['400'] : [];
    for (const c of KAG_ASSET_CAPABILITIES) {
      const want = ['200', '403', ...(ADMIN.has(c.id) ? ['401'] : []), ...body400(c)].sort().join(',');
      expect(`${c.id} ${codes(c)}`).toBe(`${c.id} ${want}`);
    }
    // checkConcurrencyLimit callers (routes/tools/kag.ts).
    const RATE_LIMITED = new Set([
      'kag.upload_document', 'kag.upload_document_sync', 'kag.scrape_url', 'kag.scrape_refresh',
      'kag.scrape_sitemap', 'kag.scrape_urls_bulk', 'kag.refresh_source',
    ]);
    for (const c of KAG_TOOL_CAPABILITIES) {
      const parks = c.approval !== undefined;
      const want = ['200', '403', ...(parks ? ['202'] : []), ...(RATE_LIMITED.has(c.id) ? ['429'] : []), ...body400(c)].sort().join(',');
      expect(`${c.id} ${codes(c)}`).toBe(`${c.id} ${want}`);
      if (RATE_LIMITED.has(c.id)) expect(`${c.id} ${c.description?.includes('429 RATE_LIMITED')}`).toBe(`${c.id} true`);
    }
    const parked = op(KAG_TOOL_CAPABILITIES.find((c) => c.id === 'kag.scrape_url')!).responses['202'] as {
      content: Record<string, { schema: { properties: { data: { required: string[] } } } }>;
    };
    expect([...parked.content['application/json']!.schema.properties.data.required].sort()).toEqual(['actionId', 'status']);
  });
});

describe('P4a1 — tools/kag: one schema, and the agent catalog untouched', () => {
  const tool = new Map<string, Capability<unknown, unknown>>(KAG_TOOL_CAPABILITIES.map((c) => [c.id, c]));

  test('a JSON-body route declares the SAME zod object the kag.* action validates with', () => {
    expect(tool.get('kag.scrape_url')!.input).toBe(kagSchemas.scrapeUrlInput);
    expect(tool.get('kag.scrape_refresh')!.input).toBe(kagSchemas.scrapeRefreshInput);
    expect(tool.get('kag.scrape_sitemap')!.input).toBe(kagSchemas.scrapeSitemapInput);
    expect(tool.get('kag.scrape_urls_bulk')!.input).toBe(kagSchemas.scrapeBulkInput);
    expect(tool.get('kag.refresh_source')!.input).toBe(kagSchemas.refreshSourceInput);
    expect(tool.get('kag.list_sessions')!.input).toBe(kagSchemas.listSessionsInput);
  });

  test('the derived path schema rejects what the action rejects: session / job ids are UUIDs, batch ids are not', () => {
    const uuid = '0190c5b8-6d1a-7c3e-9f00-1234567890ab';
    expect(kagSchemas.sessionIdInput.safeParse({ session_id: 'not-a-uuid' }).success).toBe(false);
    expect(kagSchemas.jobIdInput.safeParse({ job_id: 'not-a-uuid' }).success).toBe(false);
    for (const id of [
      'kag.get_session',
      'kag.pause_session',
      'kag.resume_session',
      'kag.cancel_session',
      'kag.list_session_images',
      'kag.get_document_job',
      'kag.list_document_images',
    ]) {
      expect(`${id} ${tool.get(id)!.input.safeParse({ id: 'not-a-uuid' }).success}`).toBe(`${id} false`);
      expect(`${id} ${tool.get(id)!.input.safeParse({ id: uuid }).success}`).toBe(`${id} true`);
    }
    // batch ids are `batch-<hex>`: a UUID check here would refuse every real one.
    for (const id of ['kag.get_batch_status', 'kag.retry_failed_batch_jobs']) {
      expect(tool.get(id)!.input.safeParse({ id: 'batch-0190c5b86d1a' }).success).toBe(true);
      expect(tool.get(id)!.input.safeParse({ id: '' }).success).toBe(false);
    }
  });

  test('the served spec carries the same constraints (format uuid on a session path, none on a batch path)', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, { parameters?: Array<{ schema: Record<string, unknown> }> }>>;
    expect(paths['/api/tools/kag/scrape/sessions/{id}']!.get!.parameters![0]!.schema.format).toBe('uuid');
    expect(paths['/api/tools/kag/documents/batch/{id}/status']!.get!.parameters![0]!.schema.format).toBeUndefined();
  });

  test('a scrape body the action refuses is refused by the declared schema too', () => {
    const cap = tool.get('kag.scrape_url')!;
    expect(cap.input.safeParse({ url: 'https://x.test/' }).success).toBe(true);
    expect(cap.input.safeParse({ url: 'https://x.test/' + 'a'.repeat(2100) }).success).toBe(false);
    expect(cap.input.safeParse({}).success).toBe(false);
  });

  test('no agent action is derived: the kag.* actions in the catalog are the hand-written ones', async () => {
    // Importing ./kag runs its import-time registration (idempotent).
    await import('../../../src/routes/tools/kag');
    const { listActions, getAction } = await import('../../../src/agui/registry');
    const names = listActions()
      .map((a) => a.name)
      .filter((n) => n.startsWith('kag.'));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(getAction('kag.scrape_url')!.input).toBe(kagSchemas.scrapeUrlInput);
    // The async upload action keeps its byte-cap refine; the declaration describes the multipart form.
    expect(getAction('kag.upload_document')!.input).not.toBe(tool.get('kag.upload_document')!.input);
    for (const { agent } of KAG_TOOL_CAPABILITIES) expect(agent.expose).toBe(false);
  });

  test('routes/tools/index.ts still imports ./kag at load, so the kag.* actions register in their boot order', () => {
    // The HTTP handlers are now bound late (lazy.ts); without this side-effect
    // import, ./kag would first load inside registerAllActions() and the catalog
    // ORDER would change.
    const src = readFileSync(join(BACKEND, 'src/routes/tools/index.ts'), 'utf8');
    // P4d-2b: ./kanban is itself a side-effect import now (its liveness route is capability-derived).
    const kanban = src.indexOf("import './kanban';");
    const kagImport = src.indexOf("import './kag';");
    // P4d-2d: ./coding is a side-effect import too (its routes are capability-derived).
    const coding = src.indexOf("import './coding';");
    expect(kanban).toBeGreaterThan(-1);
    expect(kagImport).toBeGreaterThan(kanban);
    expect(coding).toBeGreaterThan(kagImport);
  });
});
