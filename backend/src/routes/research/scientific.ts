// Research workspace — Scientific Processor route handlers.
//
// Read-style proxy over the KAG gateway's `/scientific/*` surface, mirroring
// routes/research/discover.ts: `validateAuth` → read body → `handle(() =>
// integration.fn(...), data => jsonResponse({ data }))`. Tenant is resolved
// from the authenticated user (ctxTenantId) and threaded explicitly.
//
// The processor only READS the graph (write_back defaults false), so every
// handler here is read-style — no approval bus. The full live surface is
// wired: integrity + cove + ragas (verify), the four topology analyses,
// async SubgraphX explainability (+ job-status poll), stats/trend +
// stats/meta-analysis + stats/confidence-interval, and formal verification.
// (the pipeline/* and sandbox/* surfaces are served live but wired in later PRs.)

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { IntegrationError } from '../../integrations/_lib/errors';
import {
  verifyIntegrity,
  verifyCove,
  verifyRagas,
  topologyContradictions,
  topologySubgraph,
  topologyAuthority,
  topologyCommunities,
  explainSubgraphx,
  explainJobStatus,
  statsTrend,
  statsMetaAnalysis,
  statsConfidenceInterval,
  formalVerify,
  formalTranslate,
  formalProofStore,
  formalProofGet,
  pipelineStatus,
  pipelineAnomalies,
  pipelineHistory,
  pipelineBatch,
  pipelineTrigger,
  sandboxExecute,
  sandboxJob,
  sandboxResult,
} from '../../integrations/research';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { readJsonBody, requireArrayField, requireStringField } from '../_lib';


/** Throw a 400-style UPSTREAM_BAD_BODY when a required string field is missing. */

/** Throw a 400-style UPSTREAM_BAD_BODY when a required non-empty array field is missing. */

/** POST /api/research/scientific/verify/integrity — integrity score for an entity. */
export async function handleResearchVerifyIntegrity(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'entity_id');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => verifyIntegrity(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/verify/cove — Chain-of-Verification for a claim. */
export async function handleResearchVerifyCove(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'claim_text');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => verifyCove(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/verify/ragas — RAGAS faithfulness scoring. */
export async function handleResearchVerifyRagas(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => verifyRagas(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/topology/contradictions — contradictions around an entity. */
export async function handleResearchTopologyContradictions(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'entity_id');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => topologyContradictions(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/topology/subgraph — local subgraph around an entity. */
export async function handleResearchTopologySubgraph(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'entity_id');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => topologySubgraph(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/topology/authority — authority/centrality for an entity. */
export async function handleResearchTopologyAuthority(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'entity_id');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => topologyAuthority(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/topology/communities — graph-wide community detection. */
export async function handleResearchTopologyCommunities(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => topologyCommunities(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/explain/subgraphx — kick off an async explainability job. */
export async function handleResearchExplainSubgraphx(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'node_id');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => explainSubgraphx(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/explain/jobs/:jobId — poll an explainability job. */
export async function handleResearchExplainJobStatus(
  req: Request,
  jobId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => explainJobStatus(jobId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/stats/trend — statistical trend analysis over a series. */
export async function handleResearchStatsTrend(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => statsTrend(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/formal/verify — formal (Z3/SymPy/Lean4) verification. */
export async function handleResearchFormalVerify(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => formalVerify(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/stats/meta-analysis — pool study effect sizes (random/fixed effects). */
export async function handleResearchStatsMetaAnalysis(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireArrayField(body, 'studies');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => statsMetaAnalysis(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/stats/confidence-interval — CI for an aggregated sample of values. */
export async function handleResearchStatsConfidenceInterval(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireArrayField(body, 'values');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => statsConfidenceInterval(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/formal/translate — NL claim → formal-logic expression. */
export async function handleResearchFormalTranslate(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'claim_text');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => formalTranslate(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/formal/proofs/:claimId — persist a formal proof for a claim. */
export async function handleResearchFormalProofStore(
  req: Request,
  claimId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'expression');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => formalProofStore(claimId, body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/formal/proofs/:claimId — stored proofs for a claim. */
export async function handleResearchFormalProofGet(
  req: Request,
  claimId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => formalProofGet(claimId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/pipeline/status — verification-pipeline health. */
export async function handleResearchPipelineStatus(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => pipelineStatus(tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/pipeline/anomalies — entities with verification score drops. */
export async function handleResearchPipelineAnomalies(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const threshold = new URL(req.url).searchParams.get('threshold') ?? '';
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => pipelineAnomalies(threshold, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/pipeline/history/:entityId — score history for one entity. */
export async function handleResearchPipelineHistory(
  req: Request,
  entityId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => pipelineHistory(entityId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/pipeline/batch — find + (re)verify unscored entities. */
export async function handleResearchPipelineBatch(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => pipelineBatch(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/pipeline/trigger — (re)verify specific entities. */
export async function handleResearchPipelineTrigger(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireArrayField(body, 'entity_ids');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => pipelineTrigger(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/scientific/sandbox/execute — submit code for sandboxed execution. */
export async function handleResearchSandboxExecute(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'code');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => sandboxExecute(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/sandbox/jobs/:jobId — poll a sandbox job. */
export async function handleResearchSandboxJob(
  req: Request,
  jobId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => sandboxJob(jobId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/scientific/sandbox/results/:jobId — results of a completed sandbox job. */
export async function handleResearchSandboxResult(
  req: Request,
  jobId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => sandboxResult(jobId, tenantId),
    (data) => jsonResponse({ data }),
  );
}
