/**
 * Shared types for the coding-gateway adapter.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md
 *   §"Normalized envelopes"
 */

export const ANALYSIS_TYPES = [
  'security',
  'bug_hunt',
  'quality',
  'dependencies',
  'tests',
] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
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
  error?: { code: string; message: string; upstream?: unknown };
  options_echo: Record<string, unknown>;
  idempotency_key: string;
  /**
   * Security-scan honesty bit: true when the upstream scanner reported the run
   * as partial/degraded (per-file timeout, cap-hit) so the finding set is
   * incomplete. Optional — only security jobs that polled a completed scan
   * carry it; other types + pre-091 rows leave it undefined.
   */
  degraded?: boolean;
  /** Security scan headline metrics (grade + counts) when known. */
  scan_summary?: {
    grade?: string;
    total_vulnerabilities?: number;
    total_files_scanned?: number;
  };
}

export interface Finding {
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

// ---------------------------------------------------------------------------
// Severity normalization — shared across all per-type normalizers.
// ---------------------------------------------------------------------------

export function normalizeSeverity(v: unknown): Severity {
  if (typeof v !== 'string') return 'info';
  const s = v.toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high' || s === 'error') return 'high';
  if (s === 'medium' || s === 'warning' || s === 'warn' || s === 'moderate') return 'medium';
  if (s === 'low') return 'low';
  return 'info';
}

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

// ---------------------------------------------------------------------------
// Tiny helpers used by every normalizer.
// ---------------------------------------------------------------------------

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function findingId(parts: (string | number | null | undefined)[]): string {
  // Deterministic concatenation; collisions inside one job_id are fine —
  // same finding repeated is the same finding.
  return parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|');
}

export function locFrom(
  file?: string,
  line?: number,
  symbol?: string,
): Finding['location'] {
  if (!file) return undefined;
  const out: { file: string; line?: number; symbol?: string } = { file };
  if (line !== undefined) out.line = line;
  if (symbol !== undefined) out.symbol = symbol;
  return out;
}
