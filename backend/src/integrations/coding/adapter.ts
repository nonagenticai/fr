/**
 * coding-gateway adapter — public API surface.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md
 *   §"Architecture / Fan-out map"     — five FR types → upstream triples
 *   §"Normalized envelopes"           — Job + Finding contracts
 *   §"Error mapping"                  — IntegrationError code map
 *
 * The DB row in `coding_analysis_runs` is the FR-side source of truth. The
 * adapter writes it on trigger and updates it on poll. Findings live in
 * `findings_json` normalized to the FR `Finding` envelope; the original
 * upstream payload is preserved byte-for-byte in `raw_json` for forward
 * compat.
 */

import { and, eq, desc, gt, inArray, sql } from 'drizzle-orm';

import { IntegrationError } from '../_lib/errors';
import { getCorrelationId } from '../_lib/context';
import {
  db as defaultDb,
  codingAnalysisRuns,
  projectRepositories,
  repositories,
} from '../../db/client';

import { DEDUP_WINDOW_MINUTES, MAX_RUNNING_AGE_MS, TRIGGER_TIMEOUT_MS, http } from './client';
import { resolveRepoHeadSha } from './head-sha';
import { normalizeSecurityFindings, readSecurityScanMeta } from './normalizers/security';
import { normalizeBugHuntFindings } from './normalizers/bug_hunt';
import { normalizeQualityFindings } from './normalizers/quality';
import { normalizeDependencyFindings, readDependencyScanMeta } from './normalizers/dependencies';
import { normalizeTestsFindings } from './normalizers/tests';
import {
  ANALYSIS_TYPES,
  SEVERITY_RANK,
  type AnalysisType,
  type Finding,
  type Job,
  type JobStatus,
  type Severity,
} from './types';

// ---------------------------------------------------------------------------
// DB row → Job mapper
// ---------------------------------------------------------------------------

type Row = typeof codingAnalysisRuns.$inferSelect;

function rowToJob(row: Row): Job {
  const startedAt = row.started_at?.toISOString() ?? null;
  const finishedAt = row.finished_at?.toISOString() ?? null;
  let durationMs: number | null = null;
  if (row.started_at && row.finished_at) {
    durationMs = row.finished_at.getTime() - row.started_at.getTime();
    if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = null;
  }
  const job: Job = {
    id: row.id,
    upstream_id: row.upstream_id,
    correlation_id: row.correlation_id,
    repo_id: row.repo_id,
    type: row.type as AnalysisType,
    status: row.status as JobStatus,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    findings_count: row.findings_count,
    options_echo: row.options_json ?? {},
    idempotency_key: row.client_idempotency_key,
  };
  if (row.error_code || row.error_message) {
    job.error = {
      code: row.error_code ?? 'UNKNOWN',
      message: row.error_message ?? '',
    };
  }
  // Security-scan honesty: surface the persisted degraded bit + headline metrics
  // so the UI can warn on a partial/truncated scan instead of showing a clean pass.
  if (row.scan_degraded != null) job.degraded = row.scan_degraded;
  if (row.type === 'security' && row.raw_json && typeof row.raw_json === 'object') {
    const meta = readSecurityScanMeta(row.raw_json);
    job.scan_summary = {
      grade: meta.grade,
      total_vulnerabilities: meta.total_vulnerabilities,
      total_files_scanned: meta.total_files_scanned,
    };
  }
  return job;
}

// ---------------------------------------------------------------------------
// Stale-running backstop — a job stuck in queued/running past MAX_RUNNING_AGE_MS
// (dead upstream scan worker) is declared a terminal SCAN_STALE failure so the
// FR row + the frontend 3s poller stop spinning forever.
// ---------------------------------------------------------------------------

function runningAgeMs(row: Row): number | null {
  if (!row.started_at) return null;
  const age = Date.now() - row.started_at.getTime();
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function isStaleRunning(row: Row): boolean {
  const age = runningAgeMs(row);
  return age !== null && age > MAX_RUNNING_AGE_MS;
}

function staleFailure(minutes: number): PollResult {
  return {
    status: 'failed',
    finishedAt: new Date(),
    error: {
      code: 'SCAN_STALE',
      message: `Scan stalled — no result after ${minutes} minutes; the scan worker likely died. Re-run.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-flight: resolve repo_id → container_name (+ url for HEAD-sha fallback)
// ---------------------------------------------------------------------------

interface ResolvedRepo {
  repo_id: string;
  container_name: string;
  url: string;
}

/**
 * fr-agui SPEC §13 P2 (the P1-TEAM-a audit's coding finding): who may analyse
 * which repository.
 *
 *   * NO project (the REST tools routes, the tenant UI): the caller's OWN
 *     repository only (`repositories.user_id`), unchanged.
 *   * IN A PROJECT (`projectId`: the project agent's bound project, whose
 *     membership the action's `project-member` rule has already proven): a
 *     repository ATTACHED TO THAT PROJECT (`project_repositories`), whoever
 *     registered it — every member of the tenant acts on every project
 *     (George 2026-10-15) — and NO other repository, so a job stamped with the
 *     project is always a job on one of the project's repositories.
 * Anything else is the same not-found (existence is never leaked).
 */
export async function resolveRepo(
  repoId: string,
  userId: string,
  db: typeof defaultDb,
  projectId: string | null = null,
): Promise<ResolvedRepo> {
  const [row] = projectId
    ? await db
        .select({
          id: repositories.id,
          container_name: repositories.container_name,
          user_id: repositories.user_id,
          url: repositories.url,
        })
        .from(projectRepositories)
        .innerJoin(repositories, eq(projectRepositories.repo_id, repositories.id))
        .where(and(eq(projectRepositories.project_id, projectId), eq(projectRepositories.repo_id, repoId)))
    : await db
        .select({
          id: repositories.id,
          container_name: repositories.container_name,
          user_id: repositories.user_id,
          url: repositories.url,
        })
        .from(repositories)
        .where(eq(repositories.id, repoId));
  if (!row) {
    throw new IntegrationError({
      code: 'UPSTREAM_NOT_FOUND',
      message: `Repository ${repoId} not found`,
      service: 'coding-gateway',
    });
  }
  if (!projectId && row.user_id !== userId) {
    // Hide existence from cross-tenant probes — same shape as not-found.
    throw new IntegrationError({
      code: 'UPSTREAM_NOT_FOUND',
      message: `Repository ${repoId} not found`,
      service: 'coding-gateway',
    });
  }
  if (!row.container_name) {
    throw new IntegrationError({
      code: 'UPSTREAM_NOT_FOUND',
      message: `Repository ${repoId} not onboarded to coding service (container_name is null). Provision it via /api/repositories/provision before triggering analyses.`,
      service: 'coding-gateway',
      upstreamBody: { reason: 'REPO_NOT_ONBOARDED' },
    });
  }
  return { repo_id: row.id, container_name: row.container_name, url: row.url };
}

// ---------------------------------------------------------------------------
// Per-type fan-out: trigger + (poll → findings)
// ---------------------------------------------------------------------------

interface TriggerResult {
  upstreamId: string | null;
  /** When the upstream is synchronous (tests), the terminal job + findings. */
  synchronous?: {
    findings: Finding[];
    raw: unknown;
  };
}

async function triggerUpstream(
  type: AnalysisType,
  containerName: string,
  options: Record<string, unknown>,
  jobId: string,
): Promise<TriggerResult> {
  const c = http();
  // Trigger endpoints override retries to 0 to prevent duplicate runs (spec
  // §"Error mapping").
  const noRetry = { noRetry: true, timeoutMs: TRIGGER_TIMEOUT_MS };
  switch (type) {
    case 'security': {
      // Async submit: returns { task_id, status:'queued', container_name }. The
      // poll then status-gates on GET /api/security/scan/results/{task_id}
      // instead of re-running the sync scan on every getJob().
      const body = await c.json<{ task_id?: string }>(
        `/api/security/scan/${encodeURIComponent(containerName)}/async`,
        { method: 'POST', body: JSON.stringify(options ?? {}), ...noRetry },
      );
      return { upstreamId: body.task_id ?? extractScalarId(body) };
    }
    case 'bug_hunt': {
      try {
        const body = await c.json<unknown>(
          `/api/bug-hunter/${encodeURIComponent(containerName)}/start-hunt`,
          { method: 'POST', body: JSON.stringify(options ?? {}), ...noRetry },
        );
        return { upstreamId: extractScalarId(body) };
      } catch (err) {
        // Per spec note: fall back to the synchronous /hunt sibling only on a
        // 404 from /start-hunt.
        if (err instanceof IntegrationError && err.code === 'UPSTREAM_NOT_FOUND') {
          const body = await c.json<unknown>(
            `/api/bug-hunter/${encodeURIComponent(containerName)}/hunt`,
            { method: 'POST', body: JSON.stringify(options ?? {}), ...noRetry },
          );
          return {
            upstreamId: extractScalarId(body),
            synchronous: {
              findings: normalizeBugHuntFindings(body, jobId),
              raw: body,
            },
          };
        }
        throw err;
      }
    }
    case 'quality': {
      // container_name is a REQUIRED query param on POST /api/quality/analyze
      // (bare scalar ⇒ FastAPI binds from query; the endpoint has no body model).
      const qs = new URLSearchParams({ container_name: containerName }).toString();
      const body = await c.json<{ task_id?: string }>(
        `/api/quality/analyze?${qs}`,
        { method: 'POST', ...noRetry },
      );
      const taskId = body.task_id ?? extractScalarId(body);
      return { upstreamId: taskId };
    }
    case 'dependencies': {
      // Async submit: returns { task_id, status:'queued', container_name }. The
      // poll then status-gates on GET /api/dependencies/scan/results/{task_id}
      // instead of re-running the sync report scan on every getJob().
      const body = await c.json<{ task_id?: string }>(
        `/api/dependencies/${encodeURIComponent(containerName)}/scan/async`,
        { method: 'POST', body: JSON.stringify(options ?? {}), ...noRetry },
      );
      return { upstreamId: body.task_id ?? extractScalarId(body) };
    }
    case 'tests': {
      // Synchronous upstream — response IS the result.
      // POST /api/tests/execute body is TestExecutionRequest with REQUIRED enum
      // fields `language` and `test_type`. There is no repo-language column, so
      // read them from options, defaulting to python/unit.
      // NOTE: the upstream model ALSO requires `source_code`; that is fixed on
      // the coding-testing side separately (so tests may still fail downstream
      // until that lands) — but fr's request SHAPE is now correct.
      const language =
        typeof options.language === 'string' && options.language ? options.language : 'python';
      const testType =
        typeof options.test_type === 'string' && options.test_type ? options.test_type : 'unit';
      const body = await c.json<unknown>('/api/tests/execute', {
        method: 'POST',
        body: JSON.stringify({ container_name: containerName, language, test_type: testType, ...options }),
        ...noRetry,
      });
      return {
        upstreamId: extractScalarId(body),
        synchronous: {
          findings: normalizeTestsFindings(body, jobId),
          raw: body,
        },
      };
    }
  }
}

function extractScalarId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  for (const key of ['task_id', 'job_id', 'id', 'scan_id', 'execution_id', 'test_id']) {
    const v = r[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

interface PollResult {
  status: JobStatus;
  findings?: Finding[];
  raw?: unknown;
  startedAt?: Date;
  finishedAt?: Date;
  /** Security-scan honesty bit — true when the completed scan was partial. */
  degraded?: boolean;
  /** Security-scan headline metrics (grade + counts). */
  scanSummary?: Job['scan_summary'];
  /** Terminal error to persist (e.g. SCAN_STALE backstop). */
  error?: { code: string; message: string };
}

async function pollUpstream(row: Row): Promise<PollResult> {
  const c = http();
  const container = encodeURIComponent(row.container_name);
  switch (row.type as AnalysisType) {
    case 'security': {
      // Legacy fallback: rows created before the async submit landed have no
      // upstream task_id — poll the synchronous report endpoint once.
      if (!row.upstream_id) {
        const body = await c.json<unknown>(`/api/security/report/${container}`);
        return securityResultToPollResult(body, row.id);
      }
      // Async status-gated poll — do NOT re-run the scan on every getJob().
      const record = await c.json<{ status?: string; result?: unknown }>(
        `/api/security/scan/results/${encodeURIComponent(row.upstream_id)}`,
      );
      const upstreamStatus = String(record?.status ?? '').toLowerCase();
      if (
        upstreamStatus === 'pending' ||
        upstreamStatus === 'running' ||
        upstreamStatus === 'queued'
      ) {
        if (isStaleRunning(row)) return staleFailure(Math.round(MAX_RUNNING_AGE_MS / 60000));
        return { status: 'running', raw: record };
      }
      if (upstreamStatus === 'failed' || upstreamStatus === 'error') {
        return { status: 'failed', raw: record, finishedAt: new Date() };
      }
      // completed (or any other terminal state) → normalize the bare result.
      return securityResultToPollResult(record.result ?? record, row.id);
    }
    case 'bug_hunt': {
      const status = await c.json<{ status?: string }>(
        `/api/bug-hunter/${container}/status`,
      );
      const upstreamStatus = String(status?.status ?? '').toLowerCase();
      if (upstreamStatus !== 'completed' && upstreamStatus !== 'failed') {
        if (isStaleRunning(row)) return staleFailure(Math.round(MAX_RUNNING_AGE_MS / 60000));
        return { status: upstreamStatus === 'running' ? 'running' : 'queued', raw: status };
      }
      // Pull the report list once it's done.
      // TODO(coding-adapter-drift): GET /api/bug-hunter/{container} does NOT
      // exist upstream (the bug-hunter router only exposes /status, /start-hunt,
      // and /hunt) → this returns 404, so async bug findings are never surfaced.
      // Fixing it needs a coding-analysis owner decision: either add a
      // GET /api/bug-hunter/{container}/findings endpoint, or make fr prefer the
      // synchronous /hunt path (which already returns findings inline). Not
      // changed here — flag only.
      const report = await c.json<unknown>(`/api/bug-hunter/${container}`);
      return {
        status: upstreamStatus === 'failed' ? 'failed' : 'succeeded',
        findings: normalizeBugHuntFindings(report, row.id),
        raw: report,
        finishedAt: new Date(),
      };
    }
    case 'quality': {
      if (!row.upstream_id) {
        return { status: 'failed', raw: { error: 'no upstream task_id' } };
      }
      const body = await c.json<{ status?: string; issues?: unknown[] }>(
        `/api/quality/results/${encodeURIComponent(row.upstream_id)}`,
      );
      const upstreamStatus = String(body?.status ?? '').toLowerCase();
      if (upstreamStatus === 'pending' || upstreamStatus === 'running' || upstreamStatus === 'queued') {
        if (isStaleRunning(row)) return staleFailure(Math.round(MAX_RUNNING_AGE_MS / 60000));
        return { status: 'running', raw: body };
      }
      return {
        status: upstreamStatus === 'failed' || upstreamStatus === 'error' ? 'failed' : 'succeeded',
        findings: normalizeQualityFindings(body, row.id),
        raw: body,
        finishedAt: new Date(),
      };
    }
    case 'dependencies': {
      // Legacy fallback: rows created before the async submit landed have no
      // upstream task_id — poll the synchronous report endpoint once.
      if (!row.upstream_id) {
        const body = await c.json<unknown>(`/api/dependencies/${container}/report`);
        return dependencyResultToPollResult(body, row.id);
      }
      // Async status-gated poll — do NOT re-run the scan on every getJob().
      const record = await c.json<{ status?: string; result?: unknown }>(
        `/api/dependencies/scan/results/${encodeURIComponent(row.upstream_id)}`,
      );
      const upstreamStatus = String(record?.status ?? '').toLowerCase();
      if (
        upstreamStatus === 'pending' ||
        upstreamStatus === 'running' ||
        upstreamStatus === 'queued'
      ) {
        if (isStaleRunning(row)) return staleFailure(Math.round(MAX_RUNNING_AGE_MS / 60000));
        return { status: 'running', raw: record };
      }
      if (upstreamStatus === 'failed' || upstreamStatus === 'error') {
        return { status: 'failed', raw: record, finishedAt: new Date() };
      }
      // completed (or any other terminal state) → normalize the WHOLE record.
      // NB: pass the full record (NOT record.result). Unlike SecurityScanResult,
      // the DependencyRiskReport carries no `scan_degraded` field — it lives ONLY
      // on the outer poll envelope, so peeling to `.result` here would silently
      // drop the honesty bit. The normalizer/meta helpers unwrap `{ result }`
      // themselves for findings + summary while still seeing the outer degraded.
      return dependencyResultToPollResult(record, row.id);
    }
    case 'tests': {
      // Synchronous — there is no poll. Treat the stored row as terminal.
      return {
        status: row.status as JobStatus,
      };
    }
  }
}

/**
 * Map a completed upstream SecurityScanResult (bare or wrapped) into a terminal
 * PollResult — carrying the `degraded` honesty bit + headline scan metrics so a
 * partial/truncated scan is NOT reported as a clean success.
 */
function securityResultToPollResult(result: unknown, jobId: string): PollResult {
  const meta = readSecurityScanMeta(result);
  return {
    status: 'succeeded',
    degraded: meta.degraded,
    scanSummary: {
      grade: meta.grade,
      total_vulnerabilities: meta.total_vulnerabilities,
      total_files_scanned: meta.total_files_scanned,
    },
    findings: normalizeSecurityFindings(result, jobId),
    raw: result,
    finishedAt: new Date(),
  };
}

/**
 * Map a completed upstream DependencyRiskReport (bare or wrapped in a poll
 * record) into a terminal PollResult — carrying the `degraded` honesty bit so a
 * partial/degraded dependency scan is NOT reported as a clean success. The
 * DependencyRiskReport has no security-style grade/files_scanned, so no
 * `scanSummary` is surfaced (the generic `degraded` banner is the signal); see
 * `readDependencyScanMeta` for the risk_score/package counts if ever needed.
 */
function dependencyResultToPollResult(result: unknown, jobId: string): PollResult {
  const meta = readDependencyScanMeta(result);
  return {
    status: 'succeeded',
    degraded: meta.degraded,
    findings: normalizeDependencyFindings(result, jobId),
    raw: result,
    finishedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Public adapter surface
// ---------------------------------------------------------------------------

export interface TriggerInput {
  repoId: string;
  type: AnalysisType;
  options?: Record<string, unknown>;
  clientIdempotencyKey: string;
  userId: string;
  projectId: string | null;
}

export interface TriggerResultEnvelope {
  job: Job;
  /** True when the spec's 10-min dedup window returned an existing job. */
  deduped: boolean;
}

export async function triggerAnalysis(
  input: TriggerInput,
  db = defaultDb,
): Promise<TriggerResultEnvelope> {
  if (!ANALYSIS_TYPES.includes(input.type)) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `Invalid analysis type: ${input.type}`,
      service: 'coding-gateway',
    });
  }

  const repo = await resolveRepo(input.repoId, input.userId, db, input.projectId);

  // T6 — fold the repo HEAD sha into the dedup key so a re-trigger after a
  // new commit produces a fresh job (different effective_idempotency_key)
  // instead of being deduped to the prior run within the 10-min window.
  // Falls back to the bare client key when HEAD lookup is unavailable.
  const headSha = await resolveRepoHeadSha(repo.container_name, repo.url);
  const effectiveKey = headSha
    ? `${input.clientIdempotencyKey}:${headSha}`
    : input.clientIdempotencyKey;

  // Dedup window check — spec §"Error mapping" 409 rule.
  const cutoff = sql`now() - interval '${sql.raw(String(DEDUP_WINDOW_MINUTES))} minutes'`;
  const existingConditions = [
    eq(codingAnalysisRuns.repo_id, repo.repo_id),
    eq(codingAnalysisRuns.type, input.type),
    eq(codingAnalysisRuns.client_idempotency_key, effectiveKey),
    gt(codingAnalysisRuns.created_at, cutoff as unknown as Date),
  ];
  if (input.projectId) {
    existingConditions.push(eq(codingAnalysisRuns.project_id, input.projectId));
  }
  const [existing] = await db
    .select()
    .from(codingAnalysisRuns)
    .where(and(...existingConditions))
    .orderBy(desc(codingAnalysisRuns.created_at))
    .limit(1);
  if (existing) {
    return { job: rowToJob(existing), deduped: true };
  }

  const correlationId = getCorrelationId() ?? 'no-correlation-id';
  const optionsEcho = input.options ?? {};
  const startedAt = new Date();

  // Insert the row in 'queued' state first so partial failures still leave a
  // visible job record.
  const [inserted] = await db
    .insert(codingAnalysisRuns)
    .values({
      user_id: input.userId,
      project_id: input.projectId,
      repo_id: repo.repo_id,
      container_name: repo.container_name,
      type: input.type,
      status: 'queued',
      correlation_id: correlationId,
      client_idempotency_key: effectiveKey,
      options_json: optionsEcho,
      started_at: startedAt,
    })
    .returning();
  if (!inserted) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: 'failed to insert coding_analysis_runs row',
      service: 'coding-gateway',
    });
  }
  const jobId = inserted.id;

  let triggerOut: TriggerResult;
  try {
    triggerOut = await triggerUpstream(
      input.type,
      repo.container_name,
      optionsEcho,
      jobId,
    );
  } catch (err) {
    // Persist the failure on the row, then re-throw — the route handler will
    // map the IntegrationError to an HTTP response.
    const errorCode = err instanceof IntegrationError ? err.code : 'UPSTREAM_UNREACHABLE';
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db
      .update(codingAnalysisRuns)
      .set({
        status: 'failed',
        error_code: errorCode,
        error_message: errorMessage,
        finished_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(codingAnalysisRuns.id, jobId));
    throw err;
  }

  // Synchronous result (tests, fallback /hunt) — terminal in one call.
  if (triggerOut.synchronous) {
    const findings = triggerOut.synchronous.findings;
    const [updated] = await db
      .update(codingAnalysisRuns)
      .set({
        status: 'succeeded',
        upstream_id: triggerOut.upstreamId,
        findings_json: findings,
        findings_count: findings.length,
        raw_json: triggerOut.synchronous.raw as Record<string, unknown>,
        finished_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(codingAnalysisRuns.id, jobId))
      .returning();
    return { job: rowToJob(updated ?? inserted), deduped: false };
  }

  // Async — flip to 'running' and record the upstream id.
  const [updated] = await db
    .update(codingAnalysisRuns)
    .set({
      status: 'running',
      upstream_id: triggerOut.upstreamId,
      updated_at: new Date(),
    })
    .where(eq(codingAnalysisRuns.id, jobId))
    .returning();
  return { job: rowToJob(updated ?? inserted), deduped: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListJobsInput {
  userId: string;
  /**
   * fr-agui SPEC §13 P1c: in a project-bound agent thread only the bound
   * project's runs (`coding_analysis_runs.project_id`, stamped by
   * triggerAnalysis from the caller's project). Absent ⇒ every run of the user.
   */
  projectId?: string;
  repoId?: string;
  type?: AnalysisType;
  status?: JobStatus;
  limit?: number;
  cursor?: string;
}

export interface ListJobsResult {
  jobs: Job[];
  next_cursor: string | null;
}

export async function listJobs(
  input: ListJobsInput,
  db = defaultDb,
): Promise<ListJobsResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 250);
  // fr-agui P2: in a project, every member sees the PROJECT's runs (P1-TEAM);
  // with no project, the caller's own runs (unchanged).
  const conds = input.projectId
    ? [eq(codingAnalysisRuns.project_id, input.projectId)]
    : [eq(codingAnalysisRuns.user_id, input.userId)];
  if (input.repoId) conds.push(eq(codingAnalysisRuns.repo_id, input.repoId));
  if (input.type) conds.push(eq(codingAnalysisRuns.type, input.type));
  if (input.status) conds.push(eq(codingAnalysisRuns.status, input.status));

  // Cursor is the ISO timestamp + id of the last seen row, base64-encoded.
  if (input.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(input.cursor, 'base64url').toString('utf8'),
      ) as { ts?: string; id?: string };
      if (decoded.ts) {
        // `decoded.ts` is attacker-controlled (the cursor is a client-supplied
        // base64url string). Validate it as a timestamp and BIND it — drizzle
        // parameterizes `${...}`; `::timestamptz` is the only literal SQL. Never
        // `sql.raw` user input. An unparseable ts falls through to the first
        // page, matching the "bad cursor — ignore" intent below.
        const cursorTs = new Date(decoded.ts);
        if (!Number.isNaN(cursorTs.getTime())) {
          conds.push(
            gt(sql`${cursorTs.toISOString()}::timestamptz`, codingAnalysisRuns.created_at),
          );
        }
      }
    } catch {
      // Bad cursor — ignore, fall through to first page.
    }
  }

  const rows = await db
    .select()
    .from(codingAnalysisRuns)
    .where(and(...conds))
    .orderBy(desc(codingAnalysisRuns.created_at))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    nextCursor = Buffer.from(
      JSON.stringify({ ts: last.created_at.toISOString(), id: last.id }),
    ).toString('base64url');
    rows.length = limit;
  }
  return { jobs: rows.map(rowToJob), next_cursor: nextCursor };
}

/**
 * Who reads a job (fr-agui P2): with no project, its owner (unchanged); in a
 * project (the project agent's bound project, membership already proven), any
 * job OF THAT PROJECT, whoever triggered it — and no other job, so a job id of
 * another project is the same not-found.
 */
function jobScope(jobId: string, userId: string, projectId?: string | null) {
  return and(
    eq(codingAnalysisRuns.id, jobId),
    projectId ? eq(codingAnalysisRuns.project_id, projectId) : eq(codingAnalysisRuns.user_id, userId),
  );
}

export async function getJob(
  jobId: string,
  userId: string,
  db = defaultDb,
  projectId: string | null = null,
): Promise<Job | null> {
  const [row] = await db
    .select()
    .from(codingAnalysisRuns)
    .where(jobScope(jobId, userId, projectId));
  if (!row) return null;
  // Async statuses get a refresh from upstream before returning.
  if (row.status === 'queued' || row.status === 'running') {
    try {
      const poll = await pollUpstream(row);
      if (poll.status !== row.status || poll.findings || poll.degraded !== undefined) {
        const updates: Partial<Row> = {
          status: poll.status,
          updated_at: new Date(),
        };
        if (poll.findings) {
          updates.findings_json = poll.findings;
          updates.findings_count = poll.findings.length;
        }
        if (poll.raw !== undefined) {
          updates.raw_json = poll.raw as Record<string, unknown>;
        }
        if (poll.degraded !== undefined) updates.scan_degraded = poll.degraded;
        if (poll.finishedAt) updates.finished_at = poll.finishedAt;
        if (poll.error) {
          updates.error_code = poll.error.code;
          updates.error_message = poll.error.message;
        }
        const [updated] = await db
          .update(codingAnalysisRuns)
          .set(updates)
          .where(eq(codingAnalysisRuns.id, jobId))
          .returning();
        return rowToJob(updated ?? row);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Stale backstop: if the job has been running past the max age AND the
      // gateway keeps erroring, stop spinning — write a TERMINAL SCAN_STALE
      // failure so the row + the frontend poller give up instead of re-polling
      // forever.
      if (isStaleRunning(row)) {
        const minutes = Math.round(MAX_RUNNING_AGE_MS / 60000);
        try {
          const [updated] = await db
            .update(codingAnalysisRuns)
            .set({
              status: 'failed',
              error_code: 'SCAN_STALE',
              error_message: `Scan stalled — no result after ${minutes} minutes; the scan worker likely died. Re-run. (last error: ${message})`,
              finished_at: new Date(),
              updated_at: new Date(),
            })
            // Guard against a concurrent poll that already flipped this row to a
            // terminal status between our read and this write — never clobber a
            // genuinely-completed run with SCAN_STALE. A 0-row match falls
            // through to returning the row we already have.
            .where(
              and(
                eq(codingAnalysisRuns.id, jobId),
                inArray(codingAnalysisRuns.status, ['queued', 'running']),
              ),
            )
            .returning();
          return rowToJob(updated ?? row);
        } catch {
          // Fall through to the breadcrumb path if the terminal write fails.
        }
      }
      // Best-effort: keep the stored row visible even if the gateway is down,
      // but leave a breadcrumb so a transient poll failure is not invisible.
      // Do NOT flip status — the row stays queued/running and re-polls next read.
      try {
        await db
          .update(codingAnalysisRuns)
          .set({ error_message: `poll transient: ${message}`, updated_at: new Date() })
          .where(eq(codingAnalysisRuns.id, jobId));
      } catch {
        // ignore — breadcrumb write is best-effort too.
      }
      return rowToJob(row);
    }
  }
  return rowToJob(row);
}

export interface GetFindingsInput {
  userId: string;
  /** fr-agui P2: in a project, read the project's job (see `getJob`). */
  projectId?: string | null;
  jobId: string;
  severityFloor?: Severity;
  cursor?: string;
  limit?: number;
}

export interface GetFindingsResult {
  findings: Finding[];
  next_cursor: string | null;
}

export async function getFindings(
  input: GetFindingsInput,
  db = defaultDb,
): Promise<GetFindingsResult> {
  const [row] = await db
    .select()
    .from(codingAnalysisRuns)
    .where(jobScope(input.jobId, input.userId, input.projectId));
  if (!row) {
    throw new IntegrationError({
      code: 'UPSTREAM_NOT_FOUND',
      message: `Job ${input.jobId} not found`,
      service: 'coding-gateway',
    });
  }
  const all = (row.findings_json as Finding[] | null) ?? [];
  const floor = input.severityFloor ? SEVERITY_RANK[input.severityFloor] : 0;
  const filtered = all.filter((f) => SEVERITY_RANK[f.severity] >= floor);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const slice = filtered.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < filtered.length ? String(offset + limit) : null;
  return { findings: slice, next_cursor: nextCursor };
}

// NOTE: `NOT_SUPPORTED_CANCEL` was removed alongside dropping the
// `coding.cancel_job` action registration. The HTTP route now returns a
// direct 501 NOT_SUPPORTED envelope.

export function listAnalysisTypes(): { types: readonly AnalysisType[] } {
  return { types: ANALYSIS_TYPES };
}
