// Frontend client for `/api/tools/coding/*`.
//
// Slice: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md
// All calls flow through `assetFetch` which unwraps `{ data, meta? }` and
// throws `AssetError` with the upstream message on non-2xx.

import { assetFetch } from './assets';

export type AnalysisType =
  | 'security'
  | 'bug_hunt'
  | 'quality'
  | 'dependencies'
  | 'tests';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface CodingJob {
  id: string;
  upstream_id: string | null;
  correlation_id: string;
  repo_id: string;
  type: AnalysisType;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  findings_count: number | null;
  error?: { code: string; message: string };
  options_echo: Record<string, unknown>;
  idempotency_key: string;
  /** True when a security scan completed partial/degraded (results incomplete). */
  degraded?: boolean;
  /** Security scan headline metrics, when known. */
  scan_summary?: {
    grade?: string;
    total_vulnerabilities?: number;
    total_files_scanned?: number;
  };
}

export interface CodingFinding {
  id: string;
  job_id: string;
  type: AnalysisType;
  severity: Severity;
  rule_id: string | null;
  title: string;
  message: string;
  location?: { file: string; line?: number; symbol?: string };
  remediation?: string;
  refs?: string[];
  raw: unknown;
}

export interface TriggerInput {
  repo_id: string;
  type: AnalysisType;
  options?: Record<string, unknown>;
  client_idempotency_key: string;
}

export const ANALYSIS_TYPE_LABELS: Record<AnalysisType, string> = {
  security: 'Security',
  bug_hunt: 'Bug Hunt',
  quality: 'Quality',
  dependencies: 'Dependencies',
  tests: 'Tests',
};

export async function listAnalysisTypes(): Promise<{ types: AnalysisType[] }> {
  return await assetFetch<{ types: AnalysisType[] }>(
    '/api/tools/coding/analysis-types',
  );
}

export async function triggerAnalysis(
  input: TriggerInput,
): Promise<{ job: CodingJob; deduped: boolean }> {
  return await assetFetch('/api/tools/coding/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface ListJobsParams {
  repo_id?: string;
  type?: AnalysisType;
  status?: JobStatus;
  limit?: number;
  cursor?: string;
}

export async function listJobs(params: ListJobsParams = {}): Promise<CodingJob[]> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const q = sp.toString();
  return await assetFetch<CodingJob[]>(
    `/api/tools/coding/jobs${q ? `?${q}` : ''}`,
  );
}

export async function getJob(jobId: string): Promise<CodingJob> {
  return await assetFetch<CodingJob>(
    `/api/tools/coding/jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function getFindings(
  jobId: string,
  opts: { severity_floor?: Severity; cursor?: string; limit?: number } = {},
): Promise<CodingFinding[]> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const q = sp.toString();
  return await assetFetch<CodingFinding[]>(
    `/api/tools/coding/jobs/${encodeURIComponent(jobId)}/findings${q ? `?${q}` : ''}`,
  );
}

/**
 * Generate a client-side idempotency key for a (repo, type, window) triple.
 *
 * @param repoId           - the repository UUID
 * @param type             - the analysis type
 * @param idempotencyWindow - opaque dedup discriminator (currently a 5-minute
 *                            time bucket; will be `repoHeadSha` when wired up)
 */
export function buildIdempotencyKey(
  repoId: string,
  type: AnalysisType,
  idempotencyWindow: string,
): string {
  return `${repoId}:${type}:${idempotencyWindow}`;
}
