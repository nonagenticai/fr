/**
 * coding-gateway "spine" reads — the namespaced Stack-2 surface behind
 * `/api/coding/*` (capabilities/platform/coding.ts). Thin, gated pass-throughs to
 * coding-gateway, typed off the generated `@fr/service-client-coding` wire
 * contract so an upstream shape change breaks the fr build (area-2 drift gate).
 *
 * These mirror the legacy `services/codeGraph.ts` (Stack-1) reads 1:1 but route
 * through the shared HttpClient (`client.ts`), which:
 *   - sends NO `Authorization` header (client.ts `sendAuthorization: false`) —
 *     the 2026-04-26 outage class (S8);
 *   - forwards `X-User-Id`/`X-Subject-Id`/`X-Correlation-Id` from ALS.
 * Tenant is passed EXPLICITLY (not read from ALS) so the caller's resolved
 * `ctxTenantId(user.tenantId)` — which honours the super-admin workspace
 * override — is the value that reaches the graph (S6). An explicit
 * `x-tenant-id` header wins over the ALS one in `buildHeaders`.
 *
 * Stack-1 (`services/codeGraph.ts` + `routes/quality.ts`) has been RETIRED — the
 * namespaced coding handlers (routes/coding/handlers.ts) now own the shaping +
 * cache the reads used to carry.
 */

import type {
  GetArchitectureGraph200,
  QualityGateResult,
  ContainerListResponse,
  DependencyRiskReport,
  DependencySnapshot,
  GithubGitHubRepoRequest,
  ProvisionResponse,
  CodebaseInitRequest,
  InitResponse,
  AnalysisRequest,
  ApiAnalysisResponse,
  QualityResultOutput,
} from '@fr/service-client-coding';

import { isIntegrationError } from '../_lib/errors';
import { http } from './client';

const enc = encodeURIComponent;

function tenantHeaders(tenantId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId };
}

/**
 * Architecture graph. S1: the real graph is at `/augmented` — the plain
 * `/{container}` path is metadata-only (node_count/edge_count) and would crash
 * a `.nodes.map` consumer. This spine method returns the raw augmented payload;
 * the surface (Wave 3) does its own shaping.
 */
export function getAugmentedGraph(
  container: string,
  tenantId: string,
): Promise<GetArchitectureGraph200> {
  return http().json<GetArchitectureGraph200>(
    `/api/graphs/${enc(container)}/augmented`,
    { headers: tenantHeaders(tenantId) },
  );
}

export function getQualityGate(
  container: string,
  tenantId: string,
): Promise<QualityGateResult> {
  return http().json<QualityGateResult>(
    `/api/quality/${enc(container)}/gate`,
    { headers: tenantHeaders(tenantId) },
  );
}

export function listCodingContainers(
  tenantId: string,
): Promise<ContainerListResponse> {
  return http().json<ContainerListResponse>(`/api/containers/`, {
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Stored dependency-report snapshot persisted by coding-analysis at analysis
 * time. S2: dependency data comes from `/api/analysis/dependency-report/{c}`
 * (proxied to coding-analysis) — NOT the retired `/api/stats/{c}` path (no
 * handler → 404).
 */
export function getDependencySnapshot(
  container: string,
  tenantId: string,
): Promise<DependencySnapshot> {
  return http().json<DependencySnapshot>(
    `/api/analysis/dependency-report/${enc(container)}`,
    { headers: tenantHeaders(tenantId) },
  );
}

export interface DependencyReportResult {
  report: DependencyRiskReport | Record<string, unknown>;
  degraded: boolean;
  stale_as_of?: string | null;
}

/**
 * Live dependency report. S2: sourced from `/api/dependencies/{c}/report`
 * (proxied to coding-security), never `/api/stats/{c}`. S7: the live report is
 * computed by exec'ing into the running job container; once it is deprovisioned
 * the live path 404s (gone) or 502s (exec/proxy fail). Rather than surface
 * "service unavailable", fall back to the persisted snapshot as a degraded,
 * honestly-labelled result — never a fabricated value. A never-analyzed
 * container has no snapshot (404) and correctly re-throws the original upstream
 * error.
 */
export async function getDependencyReport(
  container: string,
  tenantId: string,
): Promise<DependencyReportResult> {
  try {
    const report = await http().json<DependencyRiskReport>(
      `/api/dependencies/${enc(container)}/report`,
      { headers: tenantHeaders(tenantId) },
    );
    return { report, degraded: false };
  } catch (err) {
    if (
      isIntegrationError(err) &&
      (err.upstreamStatus === 404 || err.upstreamStatus === 502)
    ) {
      try {
        const snap = await getDependencySnapshot(container, tenantId);
        if (snap?.report) {
          return {
            report: snap.report,
            degraded: true,
            stale_as_of: snap.computed_at ?? null,
          };
        }
      } catch {
        // Snapshot also unavailable (never analyzed) — fall through and
        // re-throw the original upstream error, not the snapshot's 404.
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Writes — pass-through POSTs to coding-gateway. The request body is forwarded
// VERBATIM (S3: provision must not silently drop secret_config_id). Auth-safe
// (no Authorization, S8) and tenant-scoped (X-Tenant-Id, S6) like the reads.
// Per-write timeouts match the legacy Stack-1 contract.
// ---------------------------------------------------------------------------

/**
 * S10: provisioning clones + docker-runs + indexes — needs the long timeout.
 *
 * ⚠️ THERE IS A CEILING ABOVE THIS ONE AND IT IS NOT OURS. Cloudflare's proxy
 * read timeout (~100s on this plan) sits between the browser and istio, so a
 * SYNCHRONOUS provision or analyze that genuinely runs past ~100s is killed at
 * the edge with a 5xx while fr keeps working server-side. The caller then cannot
 * tell whether the container was created — and `provisionRepository` is
 * deliberately NOT retried at the BFF precisely because creating one is not
 * idempotent, so a client that retries on that edge 5xx can double-create.
 *
 * These 120s values are LEFT AS THEY ARE on purpose. `integrations/kag.ts:284`
 * records the same interaction and the measured reasoning for the same number:
 * raising fr's budget removes fr as the limiter and is a strict improvement,
 * and when something genuinely runs past ~100s "the fix is upstream latency,
 * not another bump here". Lowering these to sit under the edge would contradict
 * a measured decision on the strength of an inference, and would trade an edge
 * 5xx for an fr timeout without telling the caller any more about whether the
 * write landed.
 *
 * The real fix for the long tail is to stop doing this work synchronously
 * (return a job id and poll, as the ingestion path already does). That is a
 * design change, so it is written down here rather than guessed at — noted so a
 * later sweep does not re-flag the constant and "fix" the number instead.
 */
export const PROVISION_TIMEOUT_MS = 120_000;
export const INITIALIZE_TIMEOUT_MS = 60_000;
export const ANALYZE_TIMEOUT_MS = 120_000;
export const SCAN_TIMEOUT_MS = 30_000;

/**
 * Provision a repo through coding-github. The body is forwarded verbatim — S3:
 * `secret_config_id` (private-repo GIT_TOKEN resolver) was historically dropped
 * silently, so a pass-through that preserves it is the fix. Not retried
 * (creating a container is not idempotent at the BFF).
 */
export function provisionRepository(
  body: GithubGitHubRepoRequest,
  tenantId: string,
): Promise<ProvisionResponse> {
  return http().json<ProvisionResponse>('/api/repositories/provision', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
    timeoutMs: PROVISION_TIMEOUT_MS,
  });
}

export interface InitializeGraphResult {
  response: InitResponse | null;
  alreadyExists: boolean;
}

/**
 * Create the per-container code-graph database. S5: upstream returns 409 when
 * the graph already exists (and `force_rebuild` is unset) — that is a no-op
 * SUCCESS, not an error, so it resolves `{alreadyExists:true}` instead of
 * throwing. The 409-dedup makes a timeout retry safe (`retryNonIdempotent`).
 */
export async function initializeGraph(
  body: CodebaseInitRequest,
  tenantId: string,
): Promise<InitializeGraphResult> {
  try {
    const response = await http().json<InitResponse>('/api/graphs/initialize', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: tenantHeaders(tenantId),
      timeoutMs: INITIALIZE_TIMEOUT_MS,
      retryNonIdempotent: true,
    });
    return { response, alreadyExists: false };
  } catch (err) {
    if (isIntegrationError(err) && err.upstreamStatus === 409) {
      return { response: null, alreadyExists: true };
    }
    throw err;
  }
}

/**
 * Deep file-scan that populates coding.nodes/edges for the container. The body
 * is forwarded verbatim (the caller supplies `analysis_type`, e.g. `'deep'`).
 * Not retried at the BFF.
 */
export function analyzeCodebase(
  body: AnalysisRequest,
  tenantId: string,
): Promise<ApiAnalysisResponse> {
  return http().json<ApiAnalysisResponse>('/api/analysis/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
    timeoutMs: ANALYZE_TIMEOUT_MS,
  });
}

/** Trigger a dependency/quality scan of the container via coding-testing. */
export function triggerQualityScan(
  container: string,
  tenantId: string,
): Promise<QualityResultOutput> {
  return http().json<QualityResultOutput>('/api/tests/quality-scan', {
    method: 'POST',
    body: JSON.stringify({ container_name: container }),
    headers: tenantHeaders(tenantId),
    timeoutMs: SCAN_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------
// Stored quality results (coding-analysis #106 / PR #107) + CI for a commit
// (coding-github list-workflow-runs). Backs the project Quality tab
// (services/project-quality.ts).
//
// ⚠️ HAND-TYPED, NOT GENERATED. The committed gateway snapshot
// (tooling/openapi/specs/coding.json) predates both upstreams: `/history` and
// `/api/repositories/list-workflow-runs` are absent from it, and `/latest` is
// typed there as `{ [key: string]: unknown }`. Regenerating from the committed
// snapshot therefore cannot produce these shapes; a live re-sync (`openapi:sync`)
// can, once coding-analysis #107 is deployed. Until then the interfaces below
// mirror the upstream Python source verbatim — replace them with the generated
// types at that re-sync.
// ---------------------------------------------------------------------------

/** Stored-run status. `not_analyzed` = nothing stored; it carries NO score. */
export type StoredQualityStatus =
  | 'complete'
  | 'partial'
  | 'inconclusive'
  | 'failed'
  | 'not_analyzed';

export interface StoredQualityIssue {
  tool?: string | null;
  severity?: string | null;
  message?: string | null;
  file_path?: string | null;
  line_number?: number | null;
  column_number?: number | null;
  rule_id?: string | null;
}

/** GET /api/quality/{container}/latest — coding-analysis `get_latest_quality_results`. */
export interface StoredQualityLatest {
  container_name: string;
  status: StoredQualityStatus;
  result_id: string | null;
  /** null = the analysed commit is UNKNOWN (never a branch name). */
  commit_sha: string | null;
  repo_url?: string | null;
  analyzed_at: string | null;
  /** Only for complete/partial; null otherwise. */
  overall_score: number | null;
  /** Letter only for complete; `N/A` for inconclusive; null otherwise. */
  grade: string | null;
  inconclusive: boolean;
  partial: boolean;
  tools_attempted: string[];
  tools_succeeded: string[];
  tools_failed: string[];
  issues_count: number;
  issues: StoredQualityIssue[];
  issues_total: number;
  issues_truncated: boolean;
  summary?: Record<string, unknown>;
  language?: string | null;
  execution_time?: number | null;
  error_message?: string | null;
  message?: string;
}

export interface StoredQualityHistoryRow {
  id: string;
  commit_sha: string | null;
  /** Present only once the upstream history shape carries it (it does not today). */
  repo_url?: string | null;
  status: StoredQualityStatus;
  overall_score: number | null;
  grade: string | null;
  /** COUNTS (not lists) in the history shape. */
  tools_attempted: number;
  tools_succeeded: number;
  created_at: string | null;
}

/** GET /api/quality/{container}/history — coding-analysis `get_quality_history`. */
export interface StoredQualityHistory {
  container_name: string;
  status: 'ok' | 'not_analyzed';
  count: number;
  results: StoredQualityHistoryRow[];
}

/** POST /api/quality/analyze — coding-analysis `trigger_quality_analysis`. */
export interface QualityAnalyzeAccepted {
  message?: string;
  task_id: string;
  container_name: string;
  status: string;
}

/** Latest STORED quality result for a container. Never runs the analyzer. */
export function getStoredQualityLatest(
  container: string,
  tenantId: string,
): Promise<StoredQualityLatest> {
  return http().json<StoredQualityLatest>(`/api/quality/${enc(container)}/latest`, {
    headers: tenantHeaders(tenantId),
  });
}

/** Stored runs for a container, newest first (every status). */
export function getStoredQualityHistory(
  container: string,
  tenantId: string,
  limit = 50,
): Promise<StoredQualityHistory> {
  const qs = new URLSearchParams({ limit: String(limit) }).toString();
  return http().json<StoredQualityHistory>(
    `/api/quality/${enc(container)}/history?${qs}`,
    { headers: tenantHeaders(tenantId) },
  );
}

/**
 * Queue an async quality analysis; the result is persisted upstream. Not
 * retried (a retry would queue a second run). `container_name` is a QUERY
 * param — the endpoint has no body model (same as adapter.ts's quality case).
 */
export function triggerStoredQualityAnalysis(
  container: string,
  tenantId: string,
): Promise<QualityAnalyzeAccepted> {
  const qs = new URLSearchParams({ container_name: container }).toString();
  return http().json<QualityAnalyzeAccepted>(`/api/quality/analyze?${qs}`, {
    method: 'POST',
    headers: tenantHeaders(tenantId),
    noRetry: true,
  });
}

/**
 * GET /api/containers/{name} — used only as an existence probe: an upstream
 * 404 (IntegrationError.upstreamStatus === 404) means the workspace was reaped.
 */
export function getCodingContainer(
  container: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  return http().json<Record<string, unknown>>(`/api/containers/${enc(container)}`, {
    headers: tenantHeaders(tenantId),
  });
}

export interface ListWorkflowRunsRequest {
  owner: string;
  repo: string;
  /** Hex, 7..40 chars — upstream refuses a branch name (it would read as "no runs"). */
  head_sha: string;
  per_page?: number;
}

export interface WorkflowRunState {
  id: number;
  name?: string | null;
  status?: string | null;
  /** null for every run that has not completed — never a pass, never a failure. */
  conclusion?: string | null;
  html_url?: string | null;
  head_sha: string;
  head_branch?: string | null;
  event?: string | null;
  path?: string | null;
  workflow_id?: number | null;
  run_number?: number | null;
  run_attempt?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * coding-github `ListWorkflowRunsResponse`. ⛔ `count == 0` is NOT green and
 * NOT "no CI": GitHub has created no run for this sha (yet, or retention).
 */
export interface ListWorkflowRunsResponse {
  head_sha: string;
  count: number;
  runs: WorkflowRunState[];
}

/**
 * Actions runs for one head sha (tenant-scoped via coding-github). A POST that
 * only READS, so a timeout retry is safe.
 */
export function listWorkflowRunsForSha(
  body: ListWorkflowRunsRequest,
  tenantId: string,
): Promise<ListWorkflowRunsResponse> {
  return http().json<ListWorkflowRunsResponse>('/api/repositories/list-workflow-runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
    retryNonIdempotent: true,
  });
}
