// fr-agui SPEC §13 P4a1 — spec drain, KAG: the `/api/assets/kag/*` routes
// (routes/assets/kag.ts), re-expressed as capabilities with NO behaviour change.
//
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts, schemas
// come from integrations/_lib/kag-params.ts (zod only).
//
// What this declares, and what it does not:
//   * Every route keeps its existing `Request` handler (`legacyHandler`), so the
//     declared `input` / `auth.rbac` are the route CONTRACT for the derived spec,
//     not a second validator. Where the route itself parses with zod (the GET
//     query params) the declaration uses that SAME schema object.
//   * Bodies the route forwards verbatim to the KAG gateway are declared as
//     `.passthrough()` objects: the spec says `additionalProperties: true` and
//     names the upstream request type, rather than inventing a contract fr does
//     not enforce. Only the keys fr itself reads (`project_id`, ask's `query`)
//     are listed.
//   * Agent: `out-of-agent-scope` (George OQ-6) — the KAG library is tenant-
//     scoped. Deferred, not dropped (SPEC §8.2).
//   * The responses are fr's `{ data }` envelope over the upstream payload.
//
// RESERVED FOR P2 (project documents, SPEC §8.1 P2 "documents list/upload/delete")
// and therefore NOT declared here — they stay `router.add` rows in server.ts and
// pinned in LEGACY_UNDECLARED:
//   GET    /api/assets/kag/documents            (project_id filter + project-scope headers)
//   DELETE /api/assets/kag/documents/:nodeId
import { z } from 'zod';

import {
  getGraphStatsParamsSchema,
  listScrapeSessionsParamsSchema,
  queryGraphEdgesParamsSchema,
  queryGraphNodesParamsSchema,
} from '../../integrations/_lib/kag-params';
import { defaultConfirm, defineCapability, type Capability, type HttpMethod } from '../define';
import { DOOR_403 } from '../library/_shared';
import { KAG_INVALID_JSON_400, kagReadsJsonBody } from './_body';
import { preHandlerRefusalBody } from '../settings/_shared';
import { lazyHandler } from '../lazy';
import { isAuthenticatedUser, type CapabilityRoute } from '../rbac-rules';

/** fr's response envelope over the upstream KAG payload. */
const dataEnvelope = z.object({ data: z.unknown() });

/** A body forwarded verbatim to the gateway; `type` is the upstream request type. */
function upstreamBody(type: string) {
  return z.object({}).passthrough().describe(`Forwarded verbatim to the KAG gateway (${type}, @fr/service-client-kag).`);
}

/** An optional project to scope the call to (routes/assets/kag.ts scopeKagCallToProject). */
const projectId = z
  .string()
  .min(1)
  .nullable()
  .optional()
  .describe(
    'Optional. A project of the caller tenant (archived allowed). An unknown or foreign id is a 404 and KAG is not called; omitted or null = tenant-level fallback; a blank string is a 400.',
  );

/** validateAuth's bar for ONE route: signed in, and past its licence / conveyor doors (rbac-rules.ts). */
function authenticated(route: CapabilityRoute) {
  return { type: 'custom' as const, check: (ctx: Parameters<typeof isAuthenticatedUser>[0]) => isAuthenticatedUser(ctx, route) };
}
/**
 * The handler gates on `requireWorkspaceAdmin` (routes/assets/kag.ts), i.e.
 * `isWorkspaceAdminVia(user, ctxTenantId(user.tenantId))`: a `user_roles`
 * 'workspace-admin' row OR a realm `tenant_admin` / `admin` pinned to the raw
 * `tenant_id` claim, both checked against the REQUEST-CONTEXT tenant (the
 * accepted X-Active-Tenant of a switched super_admin, else the JWT tenant). The
 * `workspace-admin` rule (agui/rbac.ts) calls that same predicate with the same
 * `ctxTenantId(ctx.tenantId)` resolution, so the declaration and the route
 * decide identically, switched or not. The route keeps
 * enforcing it inline until the handler is ported (SPEC §3.3).
 *
 * fr-agui P4c part 2 (P4-carry): ROUTE-AWARE. `requireWorkspaceAdmin` runs after
 * validateAuth, whose licence / conveyor doors refuse a licence caller (403
 * licence_route_not_allowed; none of these is allowlisted) and the conveyor identity
 * (every one is a write) before the role is read — so the rule carries the route and
 * applies the same doors (`principalDoorAdmits`), or it would admit a licence caller
 * whose user holds a workspace-admin grant.
 */
function workspaceAdmin(route: CapabilityRoute) {
  return { type: 'workspace-admin' as const, route };
}

/**
 * Every 401 these routes answer, rendered by `handleError` as `{ error }` with
 * no `code` (so `CodedError` would misdescribe it). The `error` strings are
 * those the real handlers answer.
 */
const NOT_WORKSPACE_ADMIN = {
  status: 401,
  description:
    "Unauthorized, `{ error }` with no `code`. `error` is one of: 'Missing or invalid Authorization header' " +
    "(no `Bearer` header); 'Invalid or expired token' or 'unauthorized' (the bearer failed verification); " +
    "'workspace-admin role required' (authenticated, but not a workspace-admin of the request tenant).",
  schema: z.object({ error: z.string() }),
};

/**
 * P4d-1 (real-pipeline parity): the 403s fr answers before / at validateAuth — the server's licence route
 * door (a licence-shaped bearer; none of these routes is allowlisted) and validateAuth's conveyor write door.
 */
const KAG_DOORS_403 = {
  status: 403,
  description: 'Forbidden, `{ error, code }`. ' + DOOR_403.replace(/^403: /, ''),
  schema: preHandlerRefusalBody,
};

interface KagAssetRoute {
  id: `kag.${string}`;
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  effect: Capability['effect'];
  handler: string;
  admin?: boolean;
}

function kagAssetCapability(r: KagAssetRoute): Capability<unknown, unknown> {
  return defineCapability({
    id: r.id,
    area: 'kag',
    summary: r.summary,
    ...(r.description !== undefined ? { description: r.description } : {}),
    http: { method: r.method, path: r.path, operationId: r.operationId },
    input: r.input,
    output: dataEnvelope,
    errors: [],
    auth: { principal: 'user', rbac: r.admin ? workspaceAdmin({ method: r.method, path: r.path }) : authenticated({ method: r.method, path: r.path }) },
    tenancy: 'tenant',
    effect: r.effect,
    confirm: defaultConfirm(r.effect),
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { tags: ['KAG'], responses: [...(r.admin ? [NOT_WORKSPACE_ADMIN] : []), KAG_DOORS_403, ...(kagReadsJsonBody(r.method, r.path, r.input) ? [KAG_INVALID_JSON_400] : [])] },
    legacyHandler: lazyHandler(() => import('../../routes/assets/kag'), {
      module: 'src/routes/assets/kag.ts',
      exportName: r.handler,
    }),
  });
}

const nodeId = z.object({ nodeId: z.string().min(1).describe('KAG graph node id') });
const edgeId = z.object({ edgeId: z.string().min(1).describe('KAG graph edge id') });
const jobId = z.object({ jobId: z.string().min(1).describe('KAG job id') });

const ROUTES: KagAssetRoute[] = [
  // ── Retrieval ────────────────────────────────────────────────────────────
  {
    id: 'kag.semantic_search', method: 'POST', path: '/api/assets/kag/search', operationId: 'kagSemanticSearch',
    summary: 'KAG semantic (entity-node) search', effect: 'read', handler: 'handleKagSemanticSearch',
    input: upstreamBody('SemanticSearchRequest').extend({ project_id: projectId }),
  },
  {
    id: 'kag.chunk_search', method: 'POST', path: '/api/assets/kag/chunk-search', operationId: 'kagChunkSearch',
    summary: 'KAG passage (chunk) search', effect: 'read', handler: 'handleKagChunkSearch',
    input: upstreamBody('KagChunkSearchRequest').extend({ project_id: projectId }),
  },
  {
    id: 'kag.find_similar_nodes', method: 'POST', path: '/api/assets/kag/similar-nodes', operationId: 'kagFindSimilarNodes',
    summary: 'Find KAG graph nodes similar to a node or text', effect: 'read', handler: 'handleKagFindSimilarNodes',
    input: upstreamBody('SimilarNodesRequest'),
  },
  {
    id: 'kag.hierarchical_retrieval', method: 'POST', path: '/api/assets/kag/hierarchical-retrieval',
    operationId: 'kagHierarchicalRetrieval', summary: 'KAG hierarchical retrieval', effect: 'read',
    handler: 'handleKagHierarchicalRetrieval', input: upstreamBody('HierarchicalRetrievalRequest'),
  },
  {
    id: 'kag.execute_graph_query', method: 'POST', path: '/api/assets/kag/graph-query', operationId: 'kagExecuteGraphQuery',
    summary: 'Run a structured (read-only) KAG graph query', effect: 'read', handler: 'handleKagExecuteGraphQuery',
    input: upstreamBody('GraphQueryRequest'),
  },
  {
    id: 'kag.execute_optimized_query', method: 'POST', path: '/api/assets/kag/graph-query/optimized',
    operationId: 'kagExecuteOptimizedQuery', summary: 'Run a cost-optimised (read-only) KAG graph query', effect: 'read',
    handler: 'handleKagExecuteOptimizedQuery', input: upstreamBody('OptimizedQueryRequest'),
  },
  {
    id: 'kag.batch_similarity', method: 'POST', path: '/api/assets/kag/batch-similarity', operationId: 'kagBatchSimilarity',
    summary: 'KAG batch similarity', effect: 'read', handler: 'handleKagBatchSimilarity',
    input: upstreamBody('BatchSimilarityRequest'),
  },
  {
    id: 'kag.ask', method: 'POST', path: '/api/assets/kag/ask', operationId: 'kagAsk',
    summary: "RAG question over the tenant's KAG, with citations", effect: 'read', handler: 'handleKagAsk',
    description:
      'Only `query`, `mode`, `doc_id`, `top_k` (and `project_id`, for scoping) are read; other keys are ignored. ' +
      'A non-string `doc_id` or non-number `top_k` is dropped, not refused.',
    input: z.object({
      query: z.string().min(1).describe('The question; blank after trimming is a 400'),
      mode: z
        .string()
        .optional()
        .describe(
          'Forwarded to KAG unchecked; omitted = the upstream default. Known values: dense, hybrid, hybrid_rerank, full.',
        ),
      doc_id: z.string().optional().describe('Restrict the answer to one document'),
      top_k: z.number().optional(),
      project_id: projectId,
    }),
  },
  // ── Curated on-demand compute (NLP + ML): stateless read-style POSTs ─────
  {
    id: 'kag.extract_entities', method: 'POST', path: '/api/assets/kag/nlp/entities', operationId: 'kagExtractEntities',
    summary: 'Extract entities from text', effect: 'read', handler: 'handleKagExtractEntities',
    input: upstreamBody('EntityExtractionRequest'),
  },
  {
    id: 'kag.parse_text', method: 'POST', path: '/api/assets/kag/nlp/parse', operationId: 'kagParseText',
    summary: 'Parse text (NLP)', effect: 'read', handler: 'handleKagParseText', input: upstreamBody('ParseRequest'),
  },
  {
    id: 'kag.segment_text', method: 'POST', path: '/api/assets/kag/nlp/segment', operationId: 'kagSegmentText',
    summary: 'Segment text (NLP)', effect: 'read', handler: 'handleKagSegmentText', input: upstreamBody('SegmentRequest'),
  },
  {
    id: 'kag.text_similarity', method: 'POST', path: '/api/assets/kag/nlp/similarity', operationId: 'kagTextSimilarity',
    summary: 'Text similarity (NLP)', effect: 'read', handler: 'handleKagTextSimilarity',
    input: upstreamBody('SimilarityRequest'),
  },
  {
    id: 'kag.detect_language', method: 'POST', path: '/api/assets/kag/nlp/detect-language', operationId: 'kagDetectLanguage',
    summary: 'Detect the language of a text', effect: 'read', handler: 'handleKagDetectLanguage',
    input: upstreamBody('LanguageDetectRequest'),
  },
  {
    id: 'kag.text_quality', method: 'POST', path: '/api/assets/kag/nlp/text-quality', operationId: 'kagTextQuality',
    summary: 'Assess text quality', effect: 'read', handler: 'handleKagTextQuality',
    input: upstreamBody('TextQualityRequest'),
  },
  {
    id: 'kag.entity_density', method: 'POST', path: '/api/assets/kag/nlp/entity-density', operationId: 'kagEntityDensity',
    summary: 'Compute entity density of a text', effect: 'read', handler: 'handleKagEntityDensity',
    input: upstreamBody('EntityDensityRequest'),
  },
  {
    id: 'kag.generate_embeddings', method: 'POST', path: '/api/assets/kag/ml/embeddings', operationId: 'kagGenerateEmbeddings',
    summary: 'Generate embeddings', effect: 'read', handler: 'handleKagGenerateEmbeddings',
    input: upstreamBody('EmbeddingsRequest'),
  },
  {
    id: 'kag.compute_attention', method: 'POST', path: '/api/assets/kag/ml/attention', operationId: 'kagComputeAttention',
    summary: 'Compute attention weights', effect: 'read', handler: 'handleKagComputeAttention',
    input: upstreamBody('AttentionRequest'),
  },
  {
    id: 'kag.ml_similarity', method: 'POST', path: '/api/assets/kag/ml/similarity', operationId: 'kagMlSimilarity',
    summary: 'ML similarity', effect: 'read', handler: 'handleKagMlSimilarity', input: upstreamBody('MLSimilarityRequest'),
  },
  // ── Graph reads + analytics ──────────────────────────────────────────────
  {
    id: 'kag.get_graph_stats', method: 'GET', path: '/api/assets/kag/graph/stats', operationId: 'kagGetGraphStats',
    summary: 'KAG graph statistics', effect: 'read', handler: 'handleKagGetGraphStats', input: getGraphStatsParamsSchema,
  },
  {
    id: 'kag.get_graph_node_types', method: 'GET', path: '/api/assets/kag/graph/node-types',
    operationId: 'kagGetGraphNodeTypes', summary: "Distinct node labels in the tenant's graph", effect: 'read',
    handler: 'handleKagGetGraphNodeTypes', input: z.object({}),
  },
  {
    id: 'kag.detect_communities', method: 'POST', path: '/api/assets/kag/graph/analytics/community',
    operationId: 'kagDetectCommunities', summary: 'Detect graph communities', effect: 'read',
    handler: 'handleKagDetectCommunities', input: upstreamBody('CommunityRequest'),
  },
  {
    id: 'kag.calculate_centrality', method: 'POST', path: '/api/assets/kag/graph/analytics/centrality',
    operationId: 'kagCalculateCentrality', summary: 'Calculate node centrality', effect: 'read',
    handler: 'handleKagCalculateCentrality', input: upstreamBody('CentralityRequest'),
  },
  {
    id: 'kag.find_graph_paths', method: 'POST', path: '/api/assets/kag/graph/analytics/path',
    operationId: 'kagFindGraphPaths', summary: 'Find paths between graph nodes', effect: 'read',
    handler: 'handleKagFindGraphPaths', input: upstreamBody('PathRequest'),
  },
  {
    id: 'kag.query_graph_nodes', method: 'GET', path: '/api/assets/kag/graph/nodes', operationId: 'kagQueryGraphNodes',
    summary: 'Query KAG graph nodes', effect: 'read', handler: 'handleKagQueryGraphNodes', input: queryGraphNodesParamsSchema,
  },
  {
    id: 'kag.get_graph_node', method: 'GET', path: '/api/assets/kag/graph/nodes/:nodeId', operationId: 'kagGetGraphNode',
    summary: 'Get one KAG graph node', effect: 'read', handler: 'handleKagGetGraphNode', input: nodeId,
  },
  {
    id: 'kag.query_graph_edges', method: 'GET', path: '/api/assets/kag/graph/edges', operationId: 'kagQueryGraphEdges',
    summary: 'Query KAG graph edges', effect: 'read', handler: 'handleKagQueryGraphEdges', input: queryGraphEdgesParamsSchema,
  },
  {
    id: 'kag.get_graph_edge', method: 'GET', path: '/api/assets/kag/graph/edges/:edgeId', operationId: 'kagGetGraphEdge',
    summary: 'Get one KAG graph edge', effect: 'read', handler: 'handleKagGetGraphEdge', input: edgeId,
  },
  {
    id: 'kag.bulk_export_graph', method: 'POST', path: '/api/assets/kag/graph/bulk/export', operationId: 'kagBulkExportGraph',
    summary: 'Bulk-export the KAG graph (read-only)', effect: 'read', handler: 'handleKagBulkExport',
    input: upstreamBody('BulkExportRequest'),
  },
  {
    id: 'kag.list_entities', method: 'GET', path: '/api/assets/kag/entities', operationId: 'kagListEntities',
    summary: 'List KAG entities (asset-manifest shape: { items, total })', effect: 'read', handler: 'handleKagListEntities',
    input: queryGraphNodesParamsSchema,
  },
  // ── Scrape sessions, provenance, catalogues ──────────────────────────────
  {
    id: 'kag.list_scrape_sessions', method: 'GET', path: '/api/assets/kag/scrape-sessions',
    operationId: 'kagListScrapeSessions', summary: 'List KAG scrape sessions', effect: 'read',
    handler: 'handleKagListScrapeSessions', input: listScrapeSessionsParamsSchema,
  },
  {
    id: 'kag.get_scrape_session_detail', method: 'GET', path: '/api/assets/kag/scrape-sessions/:sessionId',
    operationId: 'kagGetScrapeSessionDetail', summary: 'Get one KAG scrape session', effect: 'read',
    handler: 'handleKagGetScrapeSessionDetail',
    input: z.object({ sessionId: z.string().min(1).describe('Scrape session id') }),
  },
  {
    id: 'kag.resolve_source_page', method: 'GET', path: '/api/assets/kag/provenance/source-page',
    operationId: 'kagResolveSourcePage', summary: "Resolve a chunk's doc_id / url to its scrape session", effect: 'read',
    handler: 'handleKagResolveSourcePage',
    input: z.object({ doc_id: z.string().optional(), url: z.string().optional() }),
  },
  {
    id: 'kag.list_supported_formats', method: 'GET', path: '/api/assets/kag/formats', operationId: 'kagListSupportedFormats',
    summary: 'List document formats KAG can ingest', effect: 'read', handler: 'handleKagListSupportedFormats',
    input: z.object({}),
  },
  {
    id: 'kag.list_ml_models', method: 'GET', path: '/api/assets/kag/ml/models', operationId: 'kagListMlModels',
    summary: 'List KAG ML models', effect: 'read', handler: 'handleKagListMlModels', input: z.object({}),
  },
  {
    id: 'kag.get_benchmarks', method: 'GET', path: '/api/assets/kag/benchmarks', operationId: 'kagGetBenchmarks',
    summary: 'KAG retrieval-quality benchmark summary (committed contract, no upstream call)', effect: 'read',
    handler: 'handleKagBenchmarks', input: z.object({}),
  },
  // ── Write passthroughs (PR-F, George 2026-07-11): document jobs ─────────
  {
    id: 'kag.enrich_document', method: 'POST', path: '/api/assets/kag/process/enrich', operationId: 'kagEnrichDocument',
    summary: 'Enrich a document (KARMA pipeline)', effect: 'write', handler: 'handleKagEnrichDocument',
    input: upstreamBody('EnrichRequest'),
  },
  {
    id: 'kag.decompose_document', method: 'POST', path: '/api/assets/kag/process/decompose',
    operationId: 'kagDecomposeDocument', summary: 'Decompose a document (HiRAG pipeline)', effect: 'write',
    handler: 'handleKagDecomposeDocument', input: upstreamBody('DecomposeRequest'),
  },
  {
    id: 'kag.list_document_jobs', method: 'GET', path: '/api/assets/kag/ingest/documents/jobs',
    operationId: 'kagListDocumentJobs', summary: 'List KAG document-ingestion jobs', effect: 'read',
    handler: 'handleKagListDocumentJobs', input: z.object({}),
  },
  {
    id: 'kag.clear_document_jobs', method: 'POST', path: '/api/assets/kag/ingest/documents/jobs/clear',
    operationId: 'kagClearDocumentJobs', summary: "Clear the tenant's document-job history (workspace-admin)",
    effect: 'destructive', handler: 'handleKagClearDocumentJobs', input: z.object({}), admin: true,
  },
  {
    id: 'kag.delete_document_job', method: 'DELETE', path: '/api/assets/kag/ingest/documents/jobs/:jobId',
    operationId: 'kagDeleteDocumentJob', summary: 'Delete one document-ingestion job (workspace-admin)',
    effect: 'destructive', handler: 'handleKagDeleteDocumentJob', input: jobId, admin: true,
  },
  // ── Orchestrated-pipeline job control (P2-5, George 2026-07-12) ─────────
  {
    id: 'kag.submit_pipeline', method: 'POST', path: '/api/assets/kag/pipeline/jobs', operationId: 'kagSubmitPipeline',
    summary: 'Submit a KAG ingestion pipeline job (workspace-admin)', effect: 'write', handler: 'handleKagSubmitPipeline',
    input: upstreamBody('KAGIngestRequest'), admin: true,
  },
  {
    id: 'kag.get_pipeline_job', method: 'GET', path: '/api/assets/kag/pipeline/jobs/:jobId', operationId: 'kagGetPipelineJob',
    summary: 'Get a KAG pipeline job status', effect: 'read', handler: 'handleKagJobStatus', input: jobId,
  },
  {
    id: 'kag.cancel_pipeline_job', method: 'POST', path: '/api/assets/kag/pipeline/jobs/:jobId/cancel',
    operationId: 'kagCancelPipelineJob', summary: 'Cancel a KAG pipeline job (workspace-admin)', effect: 'write',
    handler: 'handleKagCancelJob', input: jobId, admin: true,
  },
  {
    id: 'kag.resume_pipeline_job', method: 'POST', path: '/api/assets/kag/pipeline/jobs/:jobId/resume',
    operationId: 'kagResumePipelineJob', summary: 'Resume a KAG pipeline job (workspace-admin)', effect: 'write',
    handler: 'handleKagResumeJob', input: jobId, admin: true,
  },
  {
    id: 'kag.delete_pipeline_job', method: 'DELETE', path: '/api/assets/kag/pipeline/jobs/:jobId',
    operationId: 'kagDeletePipelineJob', summary: 'Delete a KAG pipeline job (workspace-admin)', effect: 'destructive',
    handler: 'handleKagDeleteJob', input: jobId, admin: true,
  },
];

export const KAG_ASSET_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = ROUTES.map(kagAssetCapability);
