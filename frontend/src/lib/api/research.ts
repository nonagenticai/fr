/**
 * Scientific Research workspace frontend client (Slice 0).
 *
 * Thin wrapper over `assetFetch` for the backend's read-style
 * `/api/research/discover/*` proxy routes (which forward to the KAG gateway's
 * Discovery Engine surface). All three return `{ data }` envelopes that
 * `assetFetch` unwraps; on failure it throws `AssetError` with the upstream
 * message. Response shapes are owned by the Discovery Engine and kept loose —
 * the page reads them defensively.
 */

import { assetFetch } from './assets';
import { withOpenProject } from './kagProjectScope';

/** A single federated-search result. `paper_id` (aliased `id`) is the UUIDv7. */
export interface PaperResult {
  paper_id?: string;
  id?: string;
  title?: string;
  authors?: Array<{ name?: string } | string>;
  year?: number | null;
  abstract?: string | null;
  source?: string;
  venue?: string | null;
  citation_count?: number | null;
  is_open_access?: boolean | null;
  pdf_url?: string | null;
  trust_score?: number | null;
  external_ids?: Record<string, string>;
  [key: string]: unknown;
}

export interface SearchResponse {
  session_id?: string | null;
  query?: string;
  total_results?: number;
  results?: PaperResult[];
  sources_queried?: string[];
  sources_failed?: string[];
  [key: string]: unknown;
}

/**
 * Source scoping — mirrors the Discovery Engine's nested `SourceFilter`.
 * `sources` is an explicit allow-list of adapter names; it NARROWS the live
 * registered+enabled set (it cannot enable a default-off source). Omit it for
 * a broad search across all registered sources.
 */
export interface SourceFilter {
  sources?: string[];
  year_min?: number;
  year_max?: number;
  fields_of_study?: string[];
}

export interface SearchRequest {
  query: string;
  session_id?: string;
  sources?: SourceFilter;
  /** Inclusive [min, max] publication-year bounds; either may be null. */
  year_range?: [number | null, number | null];
  max_results_per_source?: number;
  open_access_only?: boolean;
  sort_by?: 'relevance' | 'citation_count' | 'year';
  [key: string]: unknown;
}

/** A single registered search source + whether it is enabled live. */
export interface SourceInfo {
  name: string;
  enabled?: boolean;
}

export interface SourcesResponse {
  sources?: SourceInfo[];
  [key: string]: unknown;
}

/**
 * Per-paper ingest outcome, enriched by the Discovery Engine's push-status
 * endpoint from the paper's ingestion job: the orchestrator job, the created
 * graph `document_id` (the verify handle), the terminal `kag_status`, and the
 * `entity_ids` extracted+linked into the tenant KAG graph.
 */
export interface OrchestratorJob {
  paper_id?: string;
  orchestrator_job_id?: string;
  status?: string;
  document_id?: string | null;
  kag_status?: string | null;
  entity_ids?: string[];
  [key: string]: unknown;
}

export interface IngestPushResponse {
  push_id?: string;
  session_id?: string;
  status?: string;
  paper_count?: number;
  orchestrator_jobs?: OrchestratorJob[];
  [key: string]: unknown;
}

/** The 6 structured, tenant-safe graph query types (raw cypher/dsl are retired). */
export type GraphQueryType =
  | 'entity_search'
  | 'full_text_search'
  | 'similarity_search'
  | 'graph_traversal'
  | 'relationship_query'
  | 'aggregation';

/** Normalised envelope returned by the KAG structured graph-query surface. */
export interface GraphQueryResponse {
  results: Array<Record<string, unknown>>;
  result_count: number;
  execution_time_ms: number;
  metadata?: Record<string, unknown> | null;
}

export const researchApi = {
  /** Federated academic search across the Discovery Engine's sources. */
  async search(body: SearchRequest): Promise<SearchResponse> {
    return await assetFetch<SearchResponse>('/api/research/discover/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** Push selected papers into the tenant KAG graph (async; poll status). */
  async ingestPush(body: {
    session_id?: string;
    paper_ids: string[];
    mode?: 'quick_ingest' | 'deep_discovery';
  }): Promise<IngestPushResponse> {
    return await assetFetch<IngestPushResponse>(
      '/api/research/discover/ingest/push',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Poll the status of an async ingest push by its push_id. */
  async getIngestPushStatus(pushId: string): Promise<IngestPushResponse> {
    return await assetFetch<IngestPushResponse>(
      `/api/research/discover/ingest/push/${encodeURIComponent(pushId)}`,
    );
  },

  /** List the live registered search sources (for the advanced source picker). */
  async listSources(): Promise<SourcesResponse> {
    return await assetFetch<SourcesResponse>(
      '/api/research/discover/sources',
    );
  },

  /**
   * Ask the tenant KAG graph a question (RAG over the curated corpus). Optionally
   * scope to a single pushed document via `doc_id`. Routes through the existing
   * KAG-gateway ask surface (`/api/assets/kag/ask`).
   */
  async askCorpus(body: {
    query: string;
    doc_id?: string;
    top_k?: number;
  }): Promise<AskResponse> {
    return await assetFetch<AskResponse>('/api/assets/kag/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withOpenProject(body)),
    });
  },

  /**
   * Run a structured, tenant-scoped graph query. `query_type` selects one of the
   * 6 structured types; each dispatches (server-side, in the KAG gateway) to a
   * graph-adapter endpoint that enforces tenant isolation in the query itself.
   * `query` is the primary input for that type (a search term, entity id, source
   * node id, …); `aggregation` needs none. Routes through `/api/assets/kag/graph-query`.
   */
  async graphQuery(body: {
    query_type: GraphQueryType;
    query?: string;
    parameters?: Record<string, unknown>;
    limit?: number;
  }): Promise<GraphQueryResponse> {
    return await assetFetch<GraphQueryResponse>('/api/assets/kag/graph-query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /**
   * Cost-based optimizer twin of `graphQuery` (P2-4). Same structured query types
   * and response shape; the graph-adapter picks a cost-optimized plan.
   * Read-only — raw cypher/dsl are rejected upstream.
   *
   * ⚠️ `use_cache` IS ACCEPTED AND DELIBERATELY IGNORED — corrected 2026-09-04.
   * This used to say the adapter "may use its cache (`use_cache`)", which reads
   * as "sometimes caches, sometimes does not" and invites a caller to tune it.
   * Measured on kag `origin/main`: the field is declared (`src/models/query.py`)
   * and the router never forwards it (`src/routers/query.py`), which states in
   * its own comment that it is "accepted for contract compatibility". So setting
   * it changes nothing, in either direction, and there is no two-repo ownership
   * question to resolve — only this comment was misleading.
   * Routes through `/api/assets/kag/graph-query/optimized`.
   */
  async graphQueryOptimized(body: {
    query_type: GraphQueryType;
    query?: string;
    parameters?: Record<string, unknown>;
    limit?: number;
    use_cache?: boolean;
  }): Promise<GraphQueryResponse> {
    return await assetFetch<GraphQueryResponse>('/api/assets/kag/graph-query/optimized', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /**
   * Verify a graph entity's integrity (Scientific Processor). `entity_id` is a
   * KAG node id — e.g. an `entity_id` linked by the discovery push. Read-only.
   */
  async verifyIntegrity(body: {
    entity_id: string;
    max_hops?: number;
  }): Promise<IntegrityResponse> {
    return await assetFetch<IntegrityResponse>(
      '/api/research/scientific/verify/integrity',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Chain-of-Verification for a free-text claim (no graph entity required). */
  async verifyCove(body: {
    claim_text: string;
    claim_node_id?: string;
  }): Promise<CoveResponse> {
    return await assetFetch<CoveResponse>('/api/research/scientific/verify/cove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** RAGAS faithfulness / answer-relevance scoring for a generated answer. */
  async verifyRagas(body: Record<string, unknown>): Promise<RagasResponse> {
    return await assetFetch<RagasResponse>('/api/research/scientific/verify/ragas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** Contradiction detection in the subgraph around an entity. */
  async topologyContradictions(body: {
    entity_id: string;
    max_hops?: number;
  }): Promise<ContradictionResponse> {
    return await assetFetch<ContradictionResponse>(
      '/api/research/scientific/topology/contradictions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Extract the local subgraph around an entity. */
  async topologySubgraph(body: {
    entity_id: string;
    max_hops?: number;
  }): Promise<SubgraphResponse> {
    return await assetFetch<SubgraphResponse>(
      '/api/research/scientific/topology/subgraph',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Authority / centrality scoring for an entity. */
  async topologyAuthority(body: {
    entity_id: string;
  }): Promise<AuthorityResponse> {
    return await assetFetch<AuthorityResponse>(
      '/api/research/scientific/topology/authority',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Graph-wide community detection (no entity required). */
  async topologyCommunities(
    body: Record<string, unknown> = {},
  ): Promise<CommunityResponse> {
    return await assetFetch<CommunityResponse>(
      '/api/research/scientific/topology/communities',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Kick off an async SubgraphX/GNN explainability job for a node. */
  async explainSubgraphx(body: {
    node_id: string;
  }): Promise<ExplainJob> {
    return await assetFetch<ExplainJob>(
      '/api/research/scientific/explain/subgraphx',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Poll an async explainability job to terminal (completed | failed). */
  async getExplainJob(jobId: string): Promise<ExplainJob> {
    return await assetFetch<ExplainJob>(
      `/api/research/scientific/explain/jobs/${encodeURIComponent(jobId)}`,
    );
  },

  /** Statistical trend analysis over a series (pure stats, no entity). */
  async statsTrend(body: Record<string, unknown>): Promise<TrendResponse> {
    return await assetFetch<TrendResponse>('/api/research/scientific/stats/trend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** Formal (Z3/SymPy/Lean4) verification of a claim/expression. */
  async formalVerify(body: Record<string, unknown>): Promise<FormalResponse> {
    return await assetFetch<FormalResponse>(
      '/api/research/scientific/formal/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /**
   * Fixed/random-effects meta-analysis: pool extracted study effect sizes into a
   * single estimate + CI + heterogeneity. Body = { studies: StudyResult[],
   * method?, confidence_level? }.
   */
  async metaAnalysis(
    body: Record<string, unknown>,
  ): Promise<MetaAnalysisResponse> {
    return await assetFetch<MetaAnalysisResponse>(
      '/api/research/scientific/stats/meta-analysis',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Confidence interval for an aggregated sample. Body = { values: number[], ... }. */
  async confidenceInterval(
    body: Record<string, unknown>,
  ): Promise<ConfidenceIntervalResponse> {
    return await assetFetch<ConfidenceIntervalResponse>(
      '/api/research/scientific/stats/confidence-interval',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Translate a natural-language claim into a formal-logic expression. */
  async formalTranslate(
    body: Record<string, unknown>,
  ): Promise<FormalTranslateResponse> {
    return await assetFetch<FormalTranslateResponse>(
      '/api/research/scientific/formal/translate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Persist a formal proof for a claim id. Body = { expression, language?, is_valid?, proof? }. */
  async formalProofStore(
    claimId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/research/scientific/formal/proofs/${encodeURIComponent(claimId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Retrieve stored formal proofs for a claim id. */
  async formalProofGet(claimId: string): Promise<FormalProof[]> {
    return await assetFetch<FormalProof[]>(
      `/api/research/scientific/formal/proofs/${encodeURIComponent(claimId)}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
  },

  /** Verification-pipeline health (queue depth, throughput, processed/failed totals). */
  async pipelineStatus(): Promise<PipelineStatus> {
    return await assetFetch<PipelineStatus>(
      '/api/research/scientific/pipeline/status',
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
  },

  /** Entities whose verification score dropped beyond `threshold` (optional). */
  async pipelineAnomalies(threshold?: number): Promise<PipelineAnomalies> {
    const qs =
      threshold === undefined ? '' : `?threshold=${encodeURIComponent(threshold)}`;
    return await assetFetch<PipelineAnomalies>(
      `/api/research/scientific/pipeline/anomalies${qs}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
  },

  /** Verification score history for one entity. */
  async pipelineHistory(entityId: string): Promise<PipelineHistory> {
    return await assetFetch<PipelineHistory>(
      `/api/research/scientific/pipeline/history/${encodeURIComponent(entityId)}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
  },

  /** Find + (re)verify unscored entities. Body = { batch_size?, max_hops?, write_back? }. */
  async pipelineBatch(body: Record<string, unknown>): Promise<unknown> {
    return await assetFetch<unknown>(
      '/api/research/scientific/pipeline/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /**
   * Manually (re)verify a specific list of entities. Body = `PipelineTriggerRequest`
   * ({ entity_ids: string[] (1–100), write_back?=true, run_cove?=false, run_formal?=false }).
   * Vs `pipelineBatch`, which auto-discovers unscored entities.
   */
  async pipelineTrigger(body: PipelineTriggerRequest): Promise<unknown> {
    return await assetFetch<unknown>(
      '/api/research/scientific/pipeline/trigger',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Submit code for sandboxed execution. Body = { code, language?, timeout_seconds? }. Returns { job_id }. */
  async sandboxExecute(
    body: Record<string, unknown>,
  ): Promise<{ job_id?: string }> {
    return await assetFetch<{ job_id?: string }>(
      '/api/research/scientific/sandbox/execute',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Poll a sandbox job's status. */
  async sandboxJob(jobId: string): Promise<SandboxJobStatus> {
    return await assetFetch<SandboxJobStatus>(
      `/api/research/scientific/sandbox/jobs/${encodeURIComponent(jobId)}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
  },

  /** Fetch a completed sandbox job's results (stdout/stderr/result). */
  async sandboxResult(jobId: string): Promise<SandboxResult> {
    return await assetFetch<SandboxResult>(
      `/api/research/scientific/sandbox/results/${encodeURIComponent(jobId)}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
  },

  /**
   * Compute 7-signal trust scores for a batch of result papers. The papers must
   * already be persisted from the search that returned them (tenant-scoped).
   * Returns scores sorted by overall_score desc.
   */
  async scoreBatch(paperIds: string[]): Promise<TrustScore[]> {
    return await assetFetch<TrustScore[]>(
      '/api/research/discover/score/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paper_ids: paperIds }),
      },
    );
  },

  /**
   * Fetch citation-graph neighbours of a paper: `similar` (embedding),
   * `citations` (forward) or `references` (backward).
   */
  async getPaperRelated(
    paperId: string,
    kind: RelatedKind,
  ): Promise<RelatedResponse> {
    return await assetFetch<RelatedResponse>(
      `/api/research/discover/papers/${encodeURIComponent(paperId)}/${kind}`,
    );
  },

  /** Full metadata for one paper (`PaperDetail`). */
  async getPaper(paperId: string): Promise<PaperDetail> {
    return await assetFetch<PaperDetail>(
      `/api/research/discover/papers/${encodeURIComponent(paperId)}`,
      { method: 'GET' },
    );
  },

  /** Score a single paper (vs `scoreBatch`); returns one `TrustScore`. */
  async scorePaper(paperId: string): Promise<TrustScore> {
    return await assetFetch<TrustScore>('/api/research/discover/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paper_id: paperId }),
    });
  },

  /**
   * Create the discovery session that backs the workspace. Threading its id
   * into search persists every result into the session (survives reload,
   * exportable) and enables push.
   */
  async createSession(name: string): Promise<SessionResponse> {
    return await assetFetch<SessionResponse>(
      '/api/research/discover/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );
  },

  /** Export the session's papers as json | bibtex | ris (returns the data string). */
  async exportSession(
    sessionId: string,
    format: ExportFormat,
  ): Promise<SessionExport> {
    return await assetFetch<SessionExport>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`,
    );
  },

  /**
   * Freeze the session as a citable review-export batch, and get the receipt.
   *
   * NOT `exportSession`. That one reads the session as it is right now and
   * hands back a download; the engine rewrites `Paper` rows on every later
   * search, so the same read answers differently on two days with nothing in
   * either answer saying so. This one is an ACT: the engine serialises once,
   * stores those exact bytes, digests them, and returns a `batch_id` that
   * replays them forever.
   *
   * The receipt is all that comes back here. The DOCUMENT is never fetched by
   * this browser — Evidence Review pulls it server-to-server, because bytes
   * that pass through `HttpClient` are parsed and re-serialised and are
   * therefore no longer the bytes that were digested.
   */
  async takeReviewExport(sessionId: string): Promise<ReviewExportBatch> {
    return await assetFetch<ReviewExportBatch>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}/review-export`,
      { method: 'POST' },
    );
  },

  /**
   * Start an async citation-graph snowball walk from the selected seed papers.
   * Discovered papers are persisted into the session; poll `getSnowballStatus`
   * and re-export the session (json) to surface them.
   */
  async startSnowball(body: SnowballRequest): Promise<SnowballStatus> {
    return await assetFetch<SnowballStatus>('/api/research/discover/snowball', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** Poll the status of an async snowball job by its job_id. */
  async getSnowballStatus(jobId: string): Promise<SnowballStatus> {
    return await assetFetch<SnowballStatus>(
      `/api/research/discover/snowball/${encodeURIComponent(jobId)}`,
    );
  },

  /** Cancel an in-flight snowball job. */
  async cancelSnowball(jobId: string): Promise<SnowballStatus> {
    return await assetFetch<SnowballStatus>(
      `/api/research/discover/snowball/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST' },
    );
  },

  /** Pause an active discovery session; returns the updated session (status flipped). */
  async pauseSession(sessionId: string): Promise<SessionResponse> {
    return await assetFetch<SessionResponse>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}/pause`,
      { method: 'POST' },
    );
  },

  /** Resume a paused discovery session; returns the updated session. */
  async resumeSession(sessionId: string): Promise<SessionResponse> {
    return await assetFetch<SessionResponse>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: 'POST' },
    );
  },

  /** Fetch a single session's detail/state. */
  async getSession(sessionId: string): Promise<SessionResponse> {
    return await assetFetch<SessionResponse>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    );
  },

  /**
   * Update a session's editable fields. Body = `SessionUpdate`
   * ({ name?, description?, status?, config? }). Returns the updated session.
   */
  async updateSession(
    sessionId: string,
    body: SessionUpdate,
  ): Promise<SessionResponse> {
    return await assetFetch<SessionResponse>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  /** Delete a discovery session. */
  async deleteSession(sessionId: string): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  },

  /** Ingest-event health for a session (total/pending/failed events). */
  async sessionInsights(sessionId: string): Promise<SessionInsights> {
    return await assetFetch<SessionInsights>(
      `/api/research/discover/sessions/${encodeURIComponent(sessionId)}/insights`,
      { method: 'GET' },
    );
  },

  /** Session-wide trust distribution + top papers + recommended-for-ingest. */
  async scoreReport(sessionId: string): Promise<QualityReport> {
    return await assetFetch<QualityReport>(
      `/api/research/discover/score/report/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    );
  },

  /** Semantic similarity search over a session's discovered papers. */
  async semanticSearch(
    body: Record<string, unknown>,
  ): Promise<SemanticSearchResponse> {
    return await assetFetch<SemanticSearchResponse>(
      '/api/research/discover/search/semantic',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },
};

export type ExportFormat = 'json' | 'bibtex' | 'ris';

export interface SessionResponse {
  id?: string;
  name?: string;
  mode?: string;
  status?: string;
  paper_count?: number;
  [key: string]: unknown;
}

/** Editable session fields (`SessionUpdate`) — all optional. */
export interface SessionUpdate {
  name?: string;
  description?: string;
  /** active | paused | completed | cancelled */
  status?: string;
  config?: Record<string, unknown>;
}

export interface SessionExport {
  session_id?: string;
  format?: ExportFormat;
  data?: string;
  paper_count?: number;
  [key: string]: unknown;
}

/**
 * The receipt for a frozen review-export batch. No records travel in it.
 *
 * `digest` is `sha256:<hex>` over the exact bytes the engine stored. It is what
 * Evidence Review is asked to reproduce when it fetches the batch itself, so
 * this value is the whole point of the receipt — everything else is context.
 */
export interface ReviewExportBatch {
  batch_id: string;
  session_id: string;
  digest: string;
  record_count: number;
  created_at?: string;
}

export type RelatedKind = 'similar' | 'citations' | 'references';

/** A related-paper row (union of the similar + citation/reference shapes). */
export interface RelatedItem {
  paper_id?: string;
  id?: string;
  title?: string;
  year?: number | null;
  authors?: string[];
  citation_count?: number | null;
  similarity_score?: number;
  source?: string;
  [key: string]: unknown;
}

export interface RelatedResponse {
  paper_id?: string;
  /** `similar` returns `results`; citations/references return `items`. */
  results?: RelatedItem[];
  items?: RelatedItem[];
  total?: number;
  message?: string | null;
  [key: string]: unknown;
}

/** 7-signal trust components (each 0–1; consensus may be null). */
export interface TrustComponents {
  peer_review_status?: number;
  citation_impact?: number;
  author_h_index?: number;
  venue_prestige?: number;
  recency?: number;
  cross_reference_reliability?: number;
  consensus_confidence?: number | null;
  [key: string]: unknown;
}

export interface TrustScore {
  paper_id: string;
  overall_score: number;
  components?: TrustComponents;
  [key: string]: unknown;
}

/** Full single-paper metadata (`PaperDetail` from `GET /papers/{id}`). */
export interface PaperDetail {
  id: string;
  title?: string;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  external_ids?: Record<string, unknown>;
  citation_count?: number | null;
  citation_count_forward?: number;
  citation_count_backward?: number;
  influence_score?: number | null;
  is_open_access?: boolean | null;
  pdf_url?: string | null;
  authors?: unknown[];
  [key: string]: unknown;
}

/** One signal contributing to the composite integrity score. */
export interface IntegrityComponent {
  name?: string;
  score?: number;
  weight?: number;
  [key: string]: unknown;
}

export interface IntegrityResponse {
  entity_id?: string;
  integrity_score?: number;
  components?: IntegrityComponent[];
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single CoVe verification question + its resolved answer (shape loose — upstream-owned).
 *  Upstream (`scientific_processor` CoVeQuestion) emits `verdict` + `source_node_ids`; older
 *  `supported` kept for defensive fallback. */
export interface CoveQuestion {
  question?: string;
  answer?: string;
  verdict?: string;
  source_node_ids?: string[];
  /** @deprecated upstream emits `verdict`, not `supported`. */
  supported?: boolean;
  [key: string]: unknown;
}

/** Chain-of-Verification result. Upstream field is `overall_verdict`
 *  ("verified" | "disputed" | "inconclusive"); `verdict`/`supported` are legacy read-fallbacks. */
export interface CoveResponse {
  claim_text?: string;
  overall_verdict?: string;
  supporting_evidence?: number;
  refuting_evidence?: number;
  confidence?: number;
  questions?: CoveQuestion[];
  /** @deprecated upstream emits `overall_verdict`, not `verdict`. */
  verdict?: string;
  /** @deprecated upstream emits `overall_verdict`, not `supported`. */
  supported?: boolean;
  [key: string]: unknown;
}

/** RAGAS scoring. Upstream (`scientific_processor` RagasResponse) emits `answer_relevancy`
 *  (not `answer_relevance`) plus `factual_accuracy`. Rendered defensively (every numeric key). */
export interface RagasResponse {
  faithfulness?: number;
  answer_relevancy?: number;
  factual_accuracy?: number;
  context_precision?: number;
  /** @deprecated upstream emits `answer_relevancy`, not `answer_relevance`. */
  answer_relevance?: number;
  [key: string]: unknown;
}

/** One contradiction pair from `topology/contradictions` (`ContradictionPair` upstream). */
export interface ContradictionPair {
  target_id?: string;
  target_label?: string;
  supporting_nodes?: Array<string | Record<string, unknown>>;
  refuting_nodes?: Array<string | Record<string, unknown>>;
  net_support_score?: number;
  [key: string]: unknown;
}

/** `topology/contradictions` — upstream `ContradictionResponse`. The load-bearing fields are
 *  `contradiction_pairs` + `total_contradictions` (NOT a `contradictions` array). */
export interface ContradictionResponse {
  entity_id?: string;
  contradiction_pairs?: ContradictionPair[];
  total_contradictions?: number;
  computation_time_ms?: number;
  [key: string]: unknown;
}

/** `topology/authority` — upstream `AuthorityResponse`. Scores are a `scores{}` map + ranked
 *  `top_entities[]` (there is NO scalar `authority_score`). */
export interface AuthorityResponse {
  algorithm?: string;
  scores?: Record<string, number>;
  top_entities?: Array<Record<string, unknown>>;
  entity_count?: number;
  computation_time_ms?: number;
  [key: string]: unknown;
}

/** `topology/subgraph` — upstream `SubgraphResponse`. `nodes`/`edges` (+ counts). */
export interface SubgraphResponse {
  entity_id?: string;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  node_count?: number;
  edge_count?: number;
  max_hops_used?: number;
  computation_time_ms?: number;
  [key: string]: unknown;
}

/** `topology/communities` — upstream `CommunityResponse`. The count is `number_of_communities`
 *  (NOT a `communities` array); members are in `entity_communities{}`. */
export interface CommunityResponse {
  algorithm?: string;
  number_of_communities?: number;
  entity_communities?: Record<string, number>;
  community_sizes?: Record<string, number>;
  modularity?: number;
  computation_time_ms?: number;
  [key: string]: unknown;
}

/**
 * @deprecated Loose union of every topology analytic — retained only so the older
 * `library/research` surface keeps compiling. New code should use the precise per-analytic
 * interfaces above (`ContradictionResponse` / `AuthorityResponse` / `SubgraphResponse` /
 * `CommunityResponse`). Legacy fields (`contradictions` / `communities` / `authority_score`)
 * are the wrong keys and are never populated by upstream.
 */
export interface TopologyResponse
  extends ContradictionResponse,
    AuthorityResponse,
    SubgraphResponse,
    CommunityResponse {
  /** @deprecated upstream emits `contradiction_pairs`, not `contradictions`. */
  contradictions?: Array<Record<string, unknown>>;
  /** @deprecated upstream emits `number_of_communities`, not a `communities` array. */
  communities?: Array<Record<string, unknown>>;
  /** @deprecated upstream emits a `scores{}` map, not a scalar `authority_score`. */
  authority_score?: number;
  [key: string]: unknown;
}

/** An async SubgraphX explainability job + (when complete) its explanation. */
export interface ExplainJob {
  job_id?: string;
  status?: string;
  explanation?: Record<string, unknown>;
  error?: string | null;
  [key: string]: unknown;
}

/** A single point in a citation/value time-series for `stats/trend`. The
 *  Scientific Processor requires numeric `timestamp` + `value` (≥3 points). */
export interface TrendPoint {
  timestamp: number;
  value: number;
}

export interface TrendResponse {
  /** Mann-Kendall / linear-regression verdict, e.g. "increasing" | "no_trend". */
  trend?: string;
  slope?: number;
  p_value?: number;
  statistic?: number;
  intercept?: number | null;
  [key: string]: unknown;
}

export interface FormalResponse {
  /** Validity of the formal expression; null when undecidable / parse error. */
  is_valid?: boolean | null;
  expression?: string;
  proof?: string;
  counterexample?: unknown;
  [key: string]: unknown;
}

/** A natural-language claim translated into a formal-logic expression. */
export interface FormalTranslateResponse {
  claim_text?: string;
  formal_expression?: string;
  target_language?: string;
  /** 0–1 translator confidence. */
  confidence?: number;
  computation_time_ms?: number;
  [key: string]: unknown;
}

/** A stored formal proof for a claim (`formal/proofs/{claim_id}`). */
export interface FormalProof {
  expression?: string;
  language?: string;
  is_valid?: boolean | null;
  proof?: string | null;
  [key: string]: unknown;
}

/** Verification-pipeline health (`pipeline/status`). */
export interface PipelineStatus {
  running?: boolean;
  queue_depth?: number;
  processed_total?: number;
  failed_total?: number;
  last_run_at?: string | null;
  throughput_per_minute?: number;
  [key: string]: unknown;
}

/** Entities with verification score drops (`pipeline/anomalies`). */
export interface PipelineAnomalies {
  anomalies?: Array<Record<string, unknown>>;
  total?: number;
  [key: string]: unknown;
}

/** Verification score history for one entity (`pipeline/history/{id}`). */
export interface PipelineHistory {
  entity_id?: string;
  history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Manual re-verification request for specific entities (`pipeline/trigger`). */
export interface PipelineTriggerRequest {
  /** 1–100 entity ids to (re)verify. */
  entity_ids: string[];
  /** Persist the resulting scores back to the graph (default true upstream). */
  write_back?: boolean;
  /** Also run chain-of-verification (default false upstream). */
  run_cove?: boolean;
  /** Also run formal verification (default false upstream). */
  run_formal?: boolean;
}

/** Status of a sandboxed-execution job (`sandbox/jobs/{id}`). */
export interface SandboxJobStatus {
  job_id?: string;
  /** pending | running | completed | failed (free-form string). */
  status?: string;
  created_at?: string;
  completed_at?: string | null;
  result_url?: string | null;
  error?: string | null;
  execution_time_ms?: number | null;
  [key: string]: unknown;
}

/** Results of a completed sandboxed-execution job (`sandbox/results/{id}`). */
export interface SandboxResult {
  stdout?: string;
  stderr?: string;
  result?: unknown;
  [key: string]: unknown;
}

/** One extracted study result fed into a meta-analysis (`stats/meta-analysis`). */
export interface StudyResult {
  effect_size: number;
  standard_error: number;
  sample_size: number;
  weight?: number | null;
  label?: string | null;
}

/** Pooled estimate from a fixed/random-effects meta-analysis. */
export interface MetaAnalysisResponse {
  pooled_effect?: number;
  pooled_se?: number;
  ci_lower?: number;
  ci_upper?: number;
  /** Cochran's Q heterogeneity statistic. */
  heterogeneity_q?: number;
  /**
   * I² — proportion of variation due to heterogeneity, as a 0–1 FRACTION.
   *
   * This doc used to say "(0–100)" and it was wrong, which is worse than
   * having no doc at all: it reads as a contract, and a reader who trusts it
   * concludes that `displayI2`'s ×100 in EvidenceSynthesisPanel is a 100× bug
   * and deletes it — turning a genuine I²=0.8 (severe heterogeneity, 80%) into
   * a rendered "0.8%", i.e. a homogeneous pool. That is the wrong verdict on
   * the headline synthesis number, and nothing on screen would disagree.
   *
   * MEASURED, not assumed. The emitter is the Scientific Processor, which fr's
   * backend proxies verbatim (`backend/src/routes/research/scientific.ts:234`):
   *
   *   knowledge/scientific_processor/src/services/stats_service.py:40
   *     i_squared = max(0.0, (q - (k - 1)) / q) if q > 0 else 0.0
   *   …:66  heterogeneity_i_squared=round(i_squared, 4)
   *
   * `(q - (k-1)) / q` is structurally bounded to [0,1] for k ≥ 1 — there is no
   * ×100 anywhere on the path — and the service's own test asserts the bound:
   *   knowledge/scientific_processor/tests/unit/test_stats_service.py:549
   *     assert 0.0 <= result.heterogeneity_i_squared <= 1.0
   *
   * The rescale to a percentage therefore belongs in the display layer.
   */
  heterogeneity_i_squared?: number;
  method?: string;
  /** Per-study weights, aligned with the request's `studies` order. */
  study_weights?: number[];
  computation_time_ms?: number;
  [key: string]: unknown;
}

/** Confidence interval for an aggregated sample (`stats/confidence-interval`). */
export interface ConfidenceIntervalResponse {
  mean?: number;
  ci_lower?: number;
  ci_upper?: number;
  confidence_level?: number;
  method?: string;
  computation_time_ms?: number;
  [key: string]: unknown;
}

/** Terminal explainability-job states — stop polling when reached. */
export function isExplainTerminal(status: string | undefined | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === 'completed' || s === 'failed';
}

/** Terminal sandbox-execution-job states — stop polling when reached. */
export function isSandboxTerminal(status: string | undefined | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return (
    s === 'completed' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'timeout' ||
    s === 'cancelled'
  );
}

/** Terminal per-paper KAG ingestion states — a push job has finished extracting
 *  + linking entities (or failed) and no longer needs status polling. */
export function isKagTerminal(status: string | undefined | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return (
    s === 'completed' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'skipped' ||
    s === 'partial_failure'
  );
}

/** A citation in a corpus answer (shape kept loose — owned upstream). */
export interface AskCitation {
  doc_id?: string;
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  [key: string]: unknown;
}

export interface AskResponse {
  answer?: string;
  citations?: AskCitation[];
  chunks?: Array<Record<string, unknown>>;
  latency_ms?: number;
  [key: string]: unknown;
}

/** Terminal push states — stop polling when reached. */
export function isPushTerminal(status: string | undefined | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === 'completed' || s === 'partial_failure' || s === 'failed';
}

export type SnowballDirection = 'forward' | 'backward' | 'both';

/** Body for an async snowball walk (engine `SnowballRequest`). */
export interface SnowballRequest {
  seed_paper_ids: string[];
  session_id: string;
  direction?: SnowballDirection;
  max_depth?: number;
  max_papers?: number;
}

/** Status of an async snowball job (engine `SnowballStatus`). */
export interface SnowballStatus {
  job_id?: string;
  session_id?: string;
  status?: string;
  papers_discovered?: number;
  edges_discovered?: number;
  current_depth?: number;
  error?: string | null;
  [key: string]: unknown;
}

/** Ingest-event health for a session (`sessions/{id}/insights`). */
export interface SessionInsights {
  session_id?: string;
  total_events?: number;
  pending_events?: number;
  failed_events?: number;
  [key: string]: unknown;
}

/** Session-wide scoring report (`score/report/{id}`). */
export interface QualityReport {
  session_id?: string;
  total_papers?: number;
  /** Histogram buckets, e.g. { "0.6-0.8": 5 }. */
  score_distribution?: Record<string, number>;
  top_papers?: TrustScore[];
  recommended_for_ingest?: PaperResult[];
  threshold?: number;
  [key: string]: unknown;
}

/** One semantic-search hit (`search/semantic`). */
export interface SemanticSearchResult {
  paper_id: string;
  title: string;
  year?: number;
  external_ids?: Record<string, unknown>;
  similarity_score: number;
  [key: string]: unknown;
}

export interface SemanticSearchResponse {
  query?: string;
  results?: SemanticSearchResult[];
  total?: number;
  [key: string]: unknown;
}

/** Terminal snowball states — stop polling when reached. */
export function isSnowballTerminal(status: string | undefined | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

/** Resolve a result's identifier across the `paper_id`/`id` alias. */
export function paperIdOf(p: PaperResult): string | undefined {
  return p.paper_id ?? p.id;
}
