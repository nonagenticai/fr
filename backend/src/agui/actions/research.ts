/**
 * AG-UI agent-callable read actions for the `research` upstream (Discovery
 * Engine + Scientific Processor, both fronted by the KAG gateway). Same shape
 * as the other integration read catalogs — see `actions/principles.ts`.
 *
 * Tenant scoping: every `integrations/research` function takes `tenantId` as an
 * EXPLICIT argument (it becomes `X-Tenant-Id` upstream). We thread
 * `ctx.tenantId` verbatim via `requireTenantId` and throw when it is absent —
 * we never fall back to an empty/wildcard tenant, which would widen scope
 * across the shared KAG graph.
 *
 * READ-ONLY discipline. Registered here are only calls that do not mutate:
 * GETs, plus three POSTs whose upstream bodies are documented read-only
 * analyses (`/search/semantic`, and `/search` without a session — see below).
 * Deliberately NOT registered, because they mutate or invoke work:
 *   - `ingestPush`        — writes Document nodes into the tenant KAG graph
 *   - `scoreBatch` / `scorePaper` — POST scoring runs
 *   - `startSnowball` / `cancelSnowball` — start/cancel background crawls
 *   - `createSession` / `updateSession` / `deleteSession` / `pauseSession` /
 *     `resumeSession` — session lifecycle writes
 *   - `formalProofStore`  — upsert of a stored proof
 *   - `pipelineBatch` / `pipelineTrigger` — re-scoring runs with `write_back`
 *   - `sandboxExecute`    — arbitrary code execution
 *   - `explainSubgraphx` / `verify*` / `topology*` / `stats*` / `formalVerify` /
 *     `formalTranslate` — job submissions or compute invocations; out of scope
 *     for a v1 read catalog.
 *
 * `research.search` note: `discoverSearch` is a POST, and upstream it PERSISTS
 * every result into a discovery session when `session_id` is supplied. The
 * input schema therefore deliberately OMITS `session_id` and is `.strict()`,
 * so an agent cannot reach the persisting variant through this surface; what
 * remains is an ephemeral federated query with no upstream side effect.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { RbacDeniedError } from '../rbac';
import {
  discoverSearch,
  discoverSources,
  getPaper,
  getPaperRelated,
  getSession,
  sessionInsights,
  scoreReport,
  semanticSearch,
  snowballStatus,
  explainJobStatus,
  formalProofGet,
  pipelineStatus,
  pipelineHistory,
} from '../../integrations/research';

function requireTenantId(ctx: ActionContext): string {
  if (!ctx.tenantId) {
    // Non-retriable BY DESIGN. A raw Error here mapped to
    // `internal_error, retriable:true`, so an agent would retry a call that
    // can never succeed, and the operator saw a stack trace instead of a
    // cause. A caller with no resolved tenant cannot be scoped to tenant data,
    // so this is an authorization outcome, not a fault.
    //
    // Deliberately NOT "return unfiltered" (the `ActionContext.tenantId`
    // docstring's advice): that guidance is for post-hoc result filtering via
    // applyEffectiveFilter. Here tenantId is a REQUIRED upstream scope
    // parameter — dropping it would widen a tenant-scoped read, which is
    // strictly worse than failing.
    throw new RbacDeniedError(
      'tenant_unresolved',
      'research.*',
      'caller is not in a resolved tenant context (no tenant on the agent token and no user_roles row)',
    );
  }
  return ctx.tenantId;
}

// -------- schemas --------

const searchInputSchema = z
  .object({
    query: z.string().min(1),
    sources: z.array(z.string()).optional(),
    max_results_per_source: z.number().int().min(1).max(200).optional(),
    open_access_only: z.boolean().optional(),
    sort_by: z.string().optional(),
  })
  .strict();
type SearchInput = z.infer<typeof searchInputSchema>;
const searchOutputSchema = z.object({ result: z.unknown() });

const sourcesInputSchema = z.object({}).strict();
type SourcesInput = z.infer<typeof sourcesInputSchema>;
const sourcesOutputSchema = z.object({ result: z.unknown() });

const getPaperInputSchema = z.object({ paper_id: z.string().min(1) }).strict();
type GetPaperInput = z.infer<typeof getPaperInputSchema>;
const getPaperOutputSchema = z.object({ item: z.unknown() });

const getPaperRelatedInputSchema = z
  .object({
    paper_id: z.string().min(1),
    kind: z.enum(['similar', 'citations', 'references']),
  })
  .strict();
type GetPaperRelatedInput = z.infer<typeof getPaperRelatedInputSchema>;
const getPaperRelatedOutputSchema = z.object({ result: z.unknown() });

const getSessionInputSchema = z.object({ session_id: z.string().min(1) }).strict();
type GetSessionInput = z.infer<typeof getSessionInputSchema>;
const getSessionOutputSchema = z.object({ session: z.unknown() });

const sessionInsightsInputSchema = z.object({ session_id: z.string().min(1) }).strict();
type SessionInsightsInput = z.infer<typeof sessionInsightsInputSchema>;
const sessionInsightsOutputSchema = z.object({ insights: z.unknown() });

const scoreReportInputSchema = z.object({ session_id: z.string().min(1) }).strict();
type ScoreReportInput = z.infer<typeof scoreReportInputSchema>;
const scoreReportOutputSchema = z.object({ report: z.unknown() });

const semanticSearchInputSchema = z
  .object({
    query: z.string().min(1),
    session_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
type SemanticSearchInput = z.infer<typeof semanticSearchInputSchema>;
const semanticSearchOutputSchema = z.object({ result: z.unknown() });

const snowballStatusInputSchema = z.object({ job_id: z.string().min(1) }).strict();
type SnowballStatusInput = z.infer<typeof snowballStatusInputSchema>;
const snowballStatusOutputSchema = z.object({ status: z.unknown() });

const explainJobStatusInputSchema = z.object({ job_id: z.string().min(1) }).strict();
type ExplainJobStatusInput = z.infer<typeof explainJobStatusInputSchema>;
const explainJobStatusOutputSchema = z.object({ status: z.unknown() });

const getProofsInputSchema = z.object({ claim_id: z.string().min(1) }).strict();
type GetProofsInput = z.infer<typeof getProofsInputSchema>;
const getProofsOutputSchema = z.object({ proofs: z.unknown() });

const pipelineStatusInputSchema = z.object({}).strict();
type PipelineStatusInput = z.infer<typeof pipelineStatusInputSchema>;
const pipelineStatusOutputSchema = z.object({ status: z.unknown() });

const pipelineHistoryInputSchema = z.object({ entity_id: z.string().min(1) }).strict();
type PipelineHistoryInput = z.infer<typeof pipelineHistoryInputSchema>;
const pipelineHistoryOutputSchema = z.object({ history: z.unknown() });

// -------- actions --------

const searchAction: AgentCallableAction<SearchInput, z.infer<typeof searchOutputSchema>> = {
  name: 'research.search',
  kind: 'read',
  description:
    'Federated academic search across the Discovery Engine sources. Ephemeral: results are returned, not persisted into a discovery session. `sources` narrows to specific live sources (see research.list_sources).',
  input: searchInputSchema,
  output: searchOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `research.search:${i.query}:${(i.sources ?? []).join(',')}:${i.max_results_per_source ?? ''}:${i.open_access_only ?? ''}:${i.sort_by ?? ''}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    // Only the ephemeral (session-less) fields are forwarded — see file header.
    const result = await discoverSearch(input, tenantId);
    return { result };
  },
};

const listSourcesAction: AgentCallableAction<
  SourcesInput,
  z.infer<typeof sourcesOutputSchema>
> = {
  name: 'research.list_sources',
  kind: 'read',
  description:
    'List the Discovery Engine\'s registered search sources and their live enabled state. Only enabled sources can actually be queried.',
  input: sourcesInputSchema,
  output: sourcesOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: () => 'research.list_sources',
  handler: async (_input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const result = await discoverSources(tenantId);
    return { result };
  },
};

const getPaperAction: AgentCallableAction<
  GetPaperInput,
  z.infer<typeof getPaperOutputSchema>
> = {
  name: 'research.get_paper',
  kind: 'read',
  description:
    'Full metadata for a single discovered paper (title, abstract, year, venue, external ids, citation counts, authors). The paper must already be persisted from a prior search.',
  input: getPaperInputSchema,
  output: getPaperOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.get_paper:${i.paper_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const item = await getPaper(input.paper_id, tenantId);
    return { item };
  },
};

const getPaperRelatedAction: AgentCallableAction<
  GetPaperRelatedInput,
  z.infer<typeof getPaperRelatedOutputSchema>
> = {
  name: 'research.get_paper_related',
  kind: 'read',
  description:
    'Papers related to a discovered paper via the citation graph. `kind`: similar (embedding neighbours), citations (papers citing this one), references (papers this one cites).',
  input: getPaperRelatedInputSchema,
  output: getPaperRelatedOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.get_paper_related:${i.paper_id}:${i.kind}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const result = await getPaperRelated(input.paper_id, input.kind, tenantId);
    return { result };
  },
};

const getSessionAction: AgentCallableAction<
  GetSessionInput,
  z.infer<typeof getSessionOutputSchema>
> = {
  name: 'research.get_session',
  kind: 'read',
  description:
    'Fetch a discovery session\'s detail/state (name, mode, status, paper_count).',
  input: getSessionInputSchema,
  output: getSessionOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.get_session:${i.session_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const session = await getSession(input.session_id, tenantId);
    return { session };
  },
};

const sessionInsightsAction: AgentCallableAction<
  SessionInsightsInput,
  z.infer<typeof sessionInsightsOutputSchema>
> = {
  name: 'research.session_insights',
  kind: 'read',
  description:
    'Ingest-event health for a discovery session (total_events, pending_events, failed_events).',
  input: sessionInsightsInputSchema,
  output: sessionInsightsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.session_insights:${i.session_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const insights = await sessionInsights(input.session_id, tenantId);
    return { insights };
  },
};

const scoreReportAction: AgentCallableAction<
  ScoreReportInput,
  z.infer<typeof scoreReportOutputSchema>
> = {
  name: 'research.score_report',
  kind: 'read',
  description:
    'Session-wide trust-score report (total_papers, score_distribution, top_papers, recommended_for_ingest, threshold). Reads an already-computed distribution; does not score anything.',
  input: scoreReportInputSchema,
  output: scoreReportOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.score_report:${i.session_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const report = await scoreReport(input.session_id, tenantId);
    return { report };
  },
};

const semanticSearchAction: AgentCallableAction<
  SemanticSearchInput,
  z.infer<typeof semanticSearchOutputSchema>
> = {
  name: 'research.semantic_search',
  kind: 'read',
  description:
    'Semantic similarity search over already-discovered papers, optionally scoped to one session. Returns ranked { paper_id, title, similarity_score }.',
  input: semanticSearchInputSchema,
  output: semanticSearchOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `research.semantic_search:${i.query}:${i.session_id ?? ''}:${i.limit ?? ''}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const result = await semanticSearch(input, tenantId);
    return { result };
  },
};

const snowballStatusAction: AgentCallableAction<
  SnowballStatusInput,
  z.infer<typeof snowballStatusOutputSchema>
> = {
  name: 'research.snowball_status',
  kind: 'read',
  description:
    'Status of an async citation-graph snowball job (pending|running|completed|failed|cancelled) with papers_discovered / edges_discovered / current_depth. Polls only; never starts or cancels a walk.',
  input: snowballStatusInputSchema,
  output: snowballStatusOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.snowball_status:${i.job_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const status = await snowballStatus(input.job_id, tenantId);
    return { status };
  },
};

const explainJobStatusAction: AgentCallableAction<
  ExplainJobStatusInput,
  z.infer<typeof explainJobStatusOutputSchema>
> = {
  name: 'research.explain_job_status',
  kind: 'read',
  description:
    'Status of an async SubgraphX/GNN explainability job (pending|running|completed|failed), carrying the explanation payload when completed. Polls only; never submits a job.',
  input: explainJobStatusInputSchema,
  output: explainJobStatusOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.explain_job_status:${i.job_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const status = await explainJobStatus(input.job_id, tenantId);
    return { status };
  },
};

const getProofsAction: AgentCallableAction<
  GetProofsInput,
  z.infer<typeof getProofsOutputSchema>
> = {
  name: 'research.get_proofs',
  kind: 'read',
  description:
    'Retrieve the stored formal proofs (Z3/SymPy/Lean4) for a claim. Read-only; storing a proof is not exposed here.',
  input: getProofsInputSchema,
  output: getProofsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.get_proofs:${i.claim_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const proofs = await formalProofGet(input.claim_id, tenantId);
    return { proofs };
  },
};

const pipelineStatusAction: AgentCallableAction<
  PipelineStatusInput,
  z.infer<typeof pipelineStatusOutputSchema>
> = {
  name: 'research.pipeline_status',
  kind: 'read',
  description:
    'Verification-pipeline health: running flag, queue depth, throughput, processed/failed totals.',
  input: pipelineStatusInputSchema,
  output: pipelineStatusOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: () => 'research.pipeline_status',
  handler: async (_input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const status = await pipelineStatus(tenantId);
    return { status };
  },
};

const pipelineHistoryAction: AgentCallableAction<
  PipelineHistoryInput,
  z.infer<typeof pipelineHistoryOutputSchema>
> = {
  name: 'research.pipeline_history',
  kind: 'read',
  description: 'Verification-score history for a single graph entity.',
  input: pipelineHistoryInputSchema,
  output: pipelineHistoryOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `research.pipeline_history:${i.entity_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const history = await pipelineHistory(input.entity_id, tenantId);
    return { history };
  },
};

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') {
      return;
    }
    throw err;
  }
}

export function registerResearchActions(): void {
  safeRegister(searchAction);
  safeRegister(listSourcesAction);
  safeRegister(getPaperAction);
  safeRegister(getPaperRelatedAction);
  safeRegister(getSessionAction);
  safeRegister(sessionInsightsAction);
  safeRegister(scoreReportAction);
  safeRegister(semanticSearchAction);
  safeRegister(snowballStatusAction);
  safeRegister(explainJobStatusAction);
  safeRegister(getProofsAction);
  safeRegister(pipelineStatusAction);
  safeRegister(pipelineHistoryAction);
}
