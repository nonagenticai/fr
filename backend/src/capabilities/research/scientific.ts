// fr-agui SPEC §13 P4a2 — spec drain, research: the 24 `/api/research/scientific/*`
// routes (routes/research/scientific.ts, the Scientific Processor proxy)
// re-expressed as capabilities with NO behaviour change (`legacyHandler`).
//
// Effects: the processor reads the graph by default; `write` marks the routes
// that can change state upstream — `write_back` (integrity, pipeline batch /
// trigger, where the pipeline defaults it to true), the proof upsert, and
// sandboxed code execution. Shared responses / rule: ./_shared.ts.
import { z } from 'zod';

import type { Capability } from '../define';
import { pathId, requiredArray, requiredString, researchCapabilities, upstreamBody, type ResearchRoute } from './_shared';

const body = (type: string) => upstreamBody('Scientific Processor', type);
const entity = (type: string) => body(type).extend({ entity_id: requiredString('KAG graph node id') });
const job = z.object({ jobId: pathId('Job id') });

const ROUTES: ResearchRoute[] = [
  // ── Verify ───────────────────────────────────────────────────────────────
  {
    id: 'research.verify_integrity', method: 'POST', path: '/api/research/scientific/verify/integrity',
    handler: 'handleResearchVerifyIntegrity', summary: 'Composite integrity score for a graph entity', effect: 'write',
    input: entity('IntegrityRequest'),
    description: 'Body `{ entity_id, max_hops?, include_topology?, include_cove?, include_ragas?, write_back? }`; `write_back: true` writes the score to the graph (default false).',
  },
  {
    id: 'research.verify_cove', method: 'POST', path: '/api/research/scientific/verify/cove',
    handler: 'handleResearchVerifyCove', summary: 'Chain-of-Verification for a claim', effect: 'read',
    input: body('CoveRequest').extend({ claim_text: requiredString('The claim') }),
  },
  {
    id: 'research.verify_ragas', method: 'POST', path: '/api/research/scientific/verify/ragas',
    handler: 'handleResearchVerifyRagas', summary: 'RAGAS faithfulness scoring for a generated answer', effect: 'read',
    input: body('RagasRequest'),
  },
  // ── Topology ─────────────────────────────────────────────────────────────
  {
    id: 'research.topology_contradictions', method: 'POST', path: '/api/research/scientific/topology/contradictions',
    handler: 'handleResearchTopologyContradictions', summary: 'Contradictions around a graph entity', effect: 'read',
    input: entity('TopologyRequest'),
  },
  {
    id: 'research.topology_subgraph', method: 'POST', path: '/api/research/scientific/topology/subgraph',
    handler: 'handleResearchTopologySubgraph', summary: 'The local subgraph around a graph entity', effect: 'read',
    input: entity('TopologyRequest'),
  },
  {
    id: 'research.topology_authority', method: 'POST', path: '/api/research/scientific/topology/authority',
    handler: 'handleResearchTopologyAuthority', summary: 'Authority / centrality of a graph entity', effect: 'read',
    input: entity('TopologyRequest'),
  },
  {
    id: 'research.topology_communities', method: 'POST', path: '/api/research/scientific/topology/communities',
    handler: 'handleResearchTopologyCommunities', summary: 'Graph-wide community detection', effect: 'read',
    input: body('CommunitiesRequest'),
  },
  // ── Explain ──────────────────────────────────────────────────────────────
  {
    id: 'research.explain_subgraphx', method: 'POST', path: '/api/research/scientific/explain/subgraphx',
    handler: 'handleResearchExplainSubgraphx', summary: 'Start a SubgraphX explainability job for a node', effect: 'read',
    input: body('SubgraphXRequest').extend({ node_id: requiredString('KAG graph node id') }),
    description: 'Answers `{ job_id }`; poll GET /api/research/scientific/explain/jobs/{jobId}.',
  },
  {
    id: 'research.explain_job_status', method: 'GET', path: '/api/research/scientific/explain/jobs/:jobId',
    handler: 'handleResearchExplainJobStatus', summary: 'An explainability job status', effect: 'read', input: job,
  },
  // ── Stats ────────────────────────────────────────────────────────────────
  {
    id: 'research.stats_trend', method: 'POST', path: '/api/research/scientific/stats/trend',
    handler: 'handleResearchStatsTrend', summary: 'Statistical trend analysis over a series', effect: 'read',
    input: body('TrendRequest'),
  },
  {
    id: 'research.stats_meta_analysis', method: 'POST', path: '/api/research/scientific/stats/meta-analysis',
    handler: 'handleResearchStatsMetaAnalysis', summary: 'Pool study effect sizes (meta-analysis)', effect: 'read',
    input: body('MetaAnalysisRequest').extend({
      studies: requiredArray('`[{ effect_size, standard_error, sample_size, weight?, label? }]`'),
    }),
  },
  {
    id: 'research.stats_confidence_interval', method: 'POST', path: '/api/research/scientific/stats/confidence-interval',
    handler: 'handleResearchStatsConfidenceInterval', summary: 'Confidence interval for a sample', effect: 'read',
    input: body('ConfidenceIntervalRequest').extend({ values: requiredArray('The sample values') }),
  },
  // ── Formal ───────────────────────────────────────────────────────────────
  {
    id: 'research.formal_verify', method: 'POST', path: '/api/research/scientific/formal/verify',
    handler: 'handleResearchFormalVerify', summary: 'Formal (Z3 / SymPy / Lean4) verification', effect: 'read',
    input: body('FormalRequest'),
  },
  {
    id: 'research.formal_translate', method: 'POST', path: '/api/research/scientific/formal/translate',
    handler: 'handleResearchFormalTranslate', summary: 'Translate a claim into a formal-logic expression', effect: 'read',
    input: body('FormalTranslateRequest').extend({ claim_text: requiredString('The claim') }),
  },
  {
    id: 'research.store_proof', method: 'POST', path: '/api/research/scientific/formal/proofs/:claimId',
    handler: 'handleResearchFormalProofStore', summary: 'Store a formal proof for a claim (upsert)', effect: 'write',
    input: body('ProofStoreRequest').extend({
      claimId: pathId('Claim id'),
      expression: requiredString('The formal expression'),
    }),
  },
  {
    id: 'research.get_proofs', method: 'GET', path: '/api/research/scientific/formal/proofs/:claimId',
    handler: 'handleResearchFormalProofGet', summary: "A claim's stored formal proofs", effect: 'read',
    input: z.object({ claimId: pathId('Claim id') }),
  },
  // ── Pipeline ─────────────────────────────────────────────────────────────
  {
    id: 'research.pipeline_status', method: 'GET', path: '/api/research/scientific/pipeline/status',
    handler: 'handleResearchPipelineStatus', summary: 'Verification-pipeline health', effect: 'read', input: z.object({}),
  },
  {
    id: 'research.pipeline_anomalies', method: 'GET', path: '/api/research/scientific/pipeline/anomalies',
    handler: 'handleResearchPipelineAnomalies', summary: 'Entities whose verification score dropped', effect: 'read',
    input: z.object({
      threshold: z.string().optional().describe('Forwarded verbatim (e.g. `0.1`); omitted = the processor default'),
    }),
  },
  {
    id: 'research.pipeline_history', method: 'GET', path: '/api/research/scientific/pipeline/history/:entityId',
    handler: 'handleResearchPipelineHistory', summary: "An entity's verification score history", effect: 'read',
    input: z.object({ entityId: pathId('KAG graph node id') }),
  },
  {
    id: 'research.pipeline_batch', method: 'POST', path: '/api/research/scientific/pipeline/batch',
    handler: 'handleResearchPipelineBatch', summary: 'Find and (re)verify unscored entities', effect: 'write',
    input: body('PipelineBatchRequest'),
    description: 'Body `{ batch_size?, max_hops?, write_back? }`; `write_back` defaults to true upstream.',
  },
  {
    id: 'research.pipeline_trigger', method: 'POST', path: '/api/research/scientific/pipeline/trigger',
    handler: 'handleResearchPipelineTrigger', summary: '(Re)verify specific entities', effect: 'write',
    input: body('PipelineTriggerRequest').extend({ entity_ids: requiredArray('KAG graph node ids') }),
    description: 'Body `{ entity_ids[], write_back?, run_cove?, run_formal? }`; `write_back` defaults to true upstream.',
  },
  // ── Sandbox ──────────────────────────────────────────────────────────────
  {
    id: 'research.sandbox_execute', method: 'POST', path: '/api/research/scientific/sandbox/execute',
    handler: 'handleResearchSandboxExecute', summary: 'Run code in the processor sandbox', effect: 'write',
    input: body('SandboxRequest').extend({ code: requiredString('The code') }),
    description: 'Body `{ code, language?, timeout_seconds?, input_data? }`; answers `{ job_id }`. Poll GET /api/research/scientific/sandbox/jobs/{jobId}.',
  },
  {
    id: 'research.sandbox_job', method: 'GET', path: '/api/research/scientific/sandbox/jobs/:jobId',
    handler: 'handleResearchSandboxJob', summary: 'A sandbox job status', effect: 'read', input: job,
  },
  {
    id: 'research.sandbox_result', method: 'GET', path: '/api/research/scientific/sandbox/results/:jobId',
    handler: 'handleResearchSandboxResult', summary: "A completed sandbox job's results", effect: 'read', input: job,
  },
];

export const RESEARCH_SCIENTIFIC_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = researchCapabilities(
  'research',
  'Research',
  'src/routes/research/scientific.ts',
  () => import('../../routes/research/scientific'),
  ROUTES,
);
