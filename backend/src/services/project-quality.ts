// src/services/project-quality.ts
//
// The project Quality tab (fr#1305): the STORED quality result for each of a
// project's repositories, at a known commit, with CI for that SAME commit, and
// an explicit Analyze that ensures a workspace exists first.
//
// ⛔ THREE THINGS THIS MODULE NEVER DOES
//   1. Re-lint on read. `readProjectQuality` only calls coding-analysis
//      `/latest` + `/history` (stored rows) — never `/gate`, which may analyze
//      on a miss, and never `/analyze`.
//   2. Fabricate a score. `not_analyzed` carries no score/grade; an upstream
//      read failure is `latest: null` + `latest_error`, NOT `not_analyzed`
//      (an outage is not "never analysed").
//   3. Call CI green without evidence. A null commit sha is `unknown`; a
//      `count == 0` from list-workflow-runs is `none` ("no run created"),
//      never `success`; a run with no conclusion yet is `pending`.
//
// Analyze is in-process + fire-and-forget: POST returns 202 and a background
// task, keyed by project id, (a) ensures a live workspace per repo (primary
// first, cap 5) by provisioning when the stamped container is missing/reaped,
// (b) queues coding-analysis `POST /api/quality/analyze`, (c) waits for a NEW
// stored row. Losing the in-flight state on restart is acceptable — the
// result itself persists upstream.

import { createHash } from 'node:crypto';

import { and, count, eq, inArray, notInArray } from 'drizzle-orm';

import { db, projects, repositories } from '../db/client';
import {
  getCodingContainer,
  getStoredQualityHistory,
  getStoredQualityLatest,
  listWorkflowRunsForSha,
  provisionRepository,
  triggerStoredQualityAnalysis,
  type StoredQualityHistory,
  type StoredQualityLatest,
  type WorkflowRunState,
} from '../integrations/coding';
import { isIntegrationError, reportSwallowedFailure } from '../integrations/_lib/errors';
import { normalizeSeverity, type Severity } from '../integrations/coding/types';
import { slugContainerName } from '../lib/container-name';
import { loadProjectForRead, loadTenantScopedProject } from '../lib/project-access';
import type { GithubGitHubRepoRequest } from '@fr/service-client-coding';
import { parseGithubRepo } from './repo-access';
import { loadProjectRepositories, type ProjectRepositoryRow } from './project-repositories';
import type { User } from '../types/api';
import { NotFoundError } from '../utils/errors';

/** Upper bound on repos one Analyze touches (each may provision a workspace). */
const MAX_ANALYZE_REPOS = 5;
/** How long the background task waits for a NEW stored row per repo. */
const ANALYZE_RESULT_WAIT_MS = 10 * 60 * 1000;
const ANALYZE_POLL_INTERVAL_MS = 10_000;
/** Issues echoed per repo on the GET (the stored list is capped upstream too). */
const MAX_ISSUES_ECHOED = 25;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

type ProjectRow = Awaited<ReturnType<typeof loadTenantScopedProject>>;

type CiState = 'success' | 'failure' | 'pending' | 'none' | 'unknown';

interface CiRunView {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string | null;
  run_attempt: number | null;
  created_at: string | null;
}

export interface CiView {
  state: CiState;
  /** The sha CI was asked about — always the stored result's commit_sha. */
  commit_sha: string | null;
  runs: CiRunView[];
  /** Why the state is `unknown`/`none`, in plain words. */
  reason?: string;
}

interface QualityIssueView {
  tool: string | null;
  severity: Severity;
  severity_raw: string | null;
  message: string | null;
  file_path: string | null;
  line_number: number | null;
  rule_id: string | null;
}

type LatestView = Omit<StoredQualityLatest, 'issues'> & {
  issues: QualityIssueView[];
  severity_counts: Record<Severity, number>;
};

/**
 * Why a stored result was NOT attributed to this repo (it renders not_analyzed):
 *   - result_belongs_to_another_repo: the stored row's repo_url is a different repo.
 *   - repo_unverified: the stored row carries no repo_url and this repo is not
 *     the sole, primary holder of the container name.
 *   - shared_container: another repo of this project owns the (shared) name.
 */
type QualityMismatch = 'result_belongs_to_another_repo' | 'repo_unverified' | 'shared_container';

interface RepoQualityView {
  repo_id: string;
  name: string;
  url: string;
  is_primary: boolean;
  container_name: string | null;
  /** null ONLY when the stored-result read itself failed (see latest_error). */
  latest: LatestView | null;
  latest_error?: string;
  mismatch?: QualityMismatch;
  ci: CiView;
}

type AnalysisPhase = 'provisioning' | 'analyzing' | 'done' | 'error';

interface RepoAnalysisProgress {
  repo_id: string;
  name: string;
  container_name: string | null;
  state: 'pending' | 'provisioning' | 'analyzing' | 'done' | 'error';
  provisioned?: boolean;
  task_id?: string;
  result_id?: string | null;
  error?: string;
}

interface AnalysisState {
  state: AnalysisPhase;
  started_at: string;
  finished_at?: string;
  error?: string;
  repos: RepoAnalysisProgress[];
}

interface ProjectQualityView {
  project_id: string;
  repositories: RepoQualityView[];
  /** Repos beyond MAX_ANALYZE_REPOS are listed but never analysed from here. */
  analyze_repo_cap: number;
  analysis: AnalysisState | null;
  /**
   * A super-admin read of ANOTHER tenant's project. No upstream is queried
   * (nothing in this codebase forwards the project's tenant upstream on a
   * read), so every repo is not_analyzed rather than read under the wrong tenant.
   */
  cross_tenant?: boolean;
}

// ---------------------------------------------------------------------------
// repositories / projects writes and reads
// ---------------------------------------------------------------------------

/** `repositories.container_name` for the given ids (not on ProjectRepositoryRow). */
async function loadContainerNames(repoIds: string[]): Promise<Map<string, string | null>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db
    .select({ id: repositories.id, container_name: repositories.container_name })
    .from(repositories)
    .where(inArray(repositories.id, repoIds));
  return new Map(rows.map((r) => [r.id, r.container_name]));
}

async function stampContainerName(repoId: string, containerName: string): Promise<void> {
  await db
    .update(repositories)
    .set({ container_name: containerName, updated_at: new Date() })
    .where(eq(repositories.id, repoId));
}

/**
 * The PRIMARY repo was provisioned: stamp the repo row AND the project's
 * denormalised cache (`projects.container_name`, `repository_provisioned`)
 * in one tx, as the Provision button does (routes/projects.ts), so the
 * Architecture tab reads the live workspace.
 */
async function stampPrimaryProvisioned(
  projectId: string,
  repoId: string,
  containerName: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({ container_name: containerName, repository_provisioned: true, updated_at: new Date() })
      .where(eq(projects.id, projectId));
    await tx
      .update(repositories)
      .set({ container_name: containerName, updated_at: new Date() })
      .where(eq(repositories.id, repoId));
  });
}

/**
 * How many repositories rows OUTSIDE `excludeRepoIds` carry each name — any
 * project, any tenant. Returns counts only, never another tenant's rows.
 */
async function countContainerNameUsage(
  names: string[],
  excludeRepoIds: string[],
): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();
  const where =
    excludeRepoIds.length > 0
      ? and(inArray(repositories.container_name, names), notInArray(repositories.id, excludeRepoIds))
      : inArray(repositories.container_name, names);
  const rows = await db
    .select({ name: repositories.container_name, n: count() })
    .from(repositories)
    .where(where)
    .groupBy(repositories.container_name);
  return new Map(rows.filter((r) => r.name !== null).map((r) => [r.name as string, Number(r.n)]));
}

// ---------------------------------------------------------------------------
// In-flight analysis state (process-local, keyed by project id)
// ---------------------------------------------------------------------------

const analyses = new Map<string, AnalysisState>();

function isInFlight(s: AnalysisState | undefined): boolean {
  return s?.state === 'provisioning' || s?.state === 'analyzing';
}

function getAnalysisState(projectId: string): AnalysisState | null {
  const s = analyses.get(projectId);
  return s ? structuredClone(s) : null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * Collapse Actions runs for ONE sha into a state. Precedence: any failure →
 * failure; else any run without a conclusion → pending; else every run passing
 * (and at least one real success) → success; anything else (cancelled,
 * action_required, stale, all-skipped) → unknown. Zero runs → none.
 */
function deriveCiState(runs: WorkflowRunState[], count: number): CiState {
  if (count === 0 || runs.length === 0) return 'none';
  const conclusions = runs.map((r) => (r.status === 'completed' ? r.conclusion ?? null : null));
  if (conclusions.some((c) => c !== null && FAILURE_CONCLUSIONS.has(c))) return 'failure';
  if (conclusions.some((c) => c === null)) return 'pending';
  if (conclusions.every((c) => PASSING_CONCLUSIONS.has(c as string)) && conclusions.includes('success')) {
    return 'success';
  }
  return 'unknown';
}

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

function toRunView(r: WorkflowRunState): CiRunView {
  return {
    id: r.id,
    name: r.name ?? null,
    status: r.status ?? null,
    conclusion: r.conclusion ?? null,
    html_url: r.html_url ?? null,
    run_attempt: r.run_attempt ?? null,
    created_at: r.created_at ?? null,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptySeverityCounts(): Record<Severity, number> {
  return { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
}

/** Shape a stored `/latest` payload: normalise severities, cap the echoed list. */
function shapeLatest(raw: StoredQualityLatest): LatestView {
  const counts = emptySeverityCounts();
  const rawIssues = Array.isArray(raw.issues) ? raw.issues : [];
  const issues: QualityIssueView[] = rawIssues.map((i) => {
    const severity = normalizeSeverity(i?.severity);
    counts[severity] += 1;
    return {
      tool: i?.tool ?? null,
      severity,
      severity_raw: typeof i?.severity === 'string' ? i.severity : null,
      message: i?.message ?? null,
      file_path: i?.file_path ?? null,
      line_number: i?.line_number ?? null,
      rule_id: i?.rule_id ?? null,
    };
  });
  const status = raw.status;
  // Belt over the upstream contract: a score is only meaningful for runs that
  // measured something, and a letter only for complete ones.
  const overall_score =
    (status === 'complete' || status === 'partial') && typeof raw.overall_score === 'number'
      ? raw.overall_score
      : null;
  const grade = status === 'complete' ? raw.grade ?? null : status === 'inconclusive' ? 'N/A' : null;
  return {
    ...raw,
    overall_score,
    grade,
    commit_sha: raw.commit_sha ?? null,
    tools_attempted: Array.isArray(raw.tools_attempted) ? raw.tools_attempted : [],
    tools_succeeded: Array.isArray(raw.tools_succeeded) ? raw.tools_succeeded : [],
    tools_failed: Array.isArray(raw.tools_failed) ? raw.tools_failed : [],
    issues: issues.slice(0, MAX_ISSUES_ECHOED),
    severity_counts: counts,
  };
}

/** The not-analysed view for a repo that has no workspace name at all. */
function notAnalyzedLatest(container: string | null, message?: string): LatestView {
  return {
    container_name: container ?? '',
    status: 'not_analyzed',
    result_id: null,
    commit_sha: null,
    analyzed_at: null,
    overall_score: null,
    grade: null,
    inconclusive: true,
    partial: false,
    tools_attempted: [],
    tools_succeeded: [],
    tools_failed: [],
    issues_count: 0,
    issues: [],
    issues_total: 0,
    issues_truncated: false,
    severity_counts: emptySeverityCounts(),
    message: message ?? 'No quality analysis has been stored for this repository yet.',
  };
}

const MISMATCH_MESSAGE: Record<QualityMismatch, string> = {
  result_belongs_to_another_repo:
    'The stored result for this workspace was analysed from a different repository; run Analyze to create one for this repository.',
  repo_unverified:
    'The stored result for this workspace does not record which repository it analysed, so it is not attributed to this one; run Analyze.',
  shared_container:
    "This repository shares its workspace name with the project's primary repository; run Analyze to give it its own.",
};

/**
 * Canonical identity of a git remote for EQUALITY only: host + path,
 * lowercased, with credentials, port, trailing `/` and `.git` dropped.
 * `git@github.com:o/r`, `ssh://git@github.com/o/r.git` and
 * `https://user:tok@GitHub.com/O/R/` all normalise to `github.com/o/r`.
 * Returns null for an empty / unparseable value (which then matches nothing).
 */
function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  let host: string;
  let path: string;
  // scp-like: [user@]host:path (no scheme).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }
  host = host.toLowerCase().replace(/^www\./, '');
  path = path
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!host || !path) return null;
  return `${host}/${path}`;
}

function sameRepoUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeRepoUrl(a);
  return na !== null && na === normalizeRepoUrl(b);
}

/** Tenant tag of a project row (project_data.keycloak_tenant_id), if any. */
function projectTenantOf(project: { project_data?: unknown }): string | null {
  const pd = project.project_data;
  if (pd && typeof pd === 'object') {
    const t = (pd as Record<string, unknown>).keycloak_tenant_id;
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return null;
}

/**
 * Who may be attributed a container's stored results. The legacy coordinated
 * Provision stamped the primary's name on EVERY attached repo, but that
 * container only cloned the primary — so a name shared inside the project
 * belongs to its first holder in primary-first order (the same rule
 * planContainerNames applies), and nobody else.
 */
function containerOwners(
  repos: ProjectRepositoryRow[],
  names: Map<string, string | null>,
): { owner: Map<string, string>; holders: Map<string, number> } {
  const owner = new Map<string, string>();
  const holders = new Map<string, number>();
  const ordered = [...repos].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  for (const r of ordered) {
    const n = names.get(r.repo_id) ?? null;
    if (!n) continue;
    holders.set(n, (holders.get(n) ?? 0) + 1);
    if (!owner.has(n)) owner.set(n, r.repo_id);
  }
  return { owner, holders };
}

interface AttributionCtx {
  repos: ProjectRepositoryRow[];
  holders: Map<string, number>;
  /** Lazily counts repositories rows OUTSIDE this project carrying the name. */
  usedElsewhere: (name: string) => Promise<number>;
}

/**
 * Does a stored result whose row says `storedRepoUrl` apply to `repo`?
 * null = yes. A recorded url must MATCH. An unrecorded one is accepted only
 * for the primary repo that is the SOLE holder of the name (in this project
 * and in the whole table) — the one case where the container can only have
 * cloned it.
 */
async function attribution(
  repo: ProjectRepositoryRow,
  container: string,
  storedRepoUrl: string | null | undefined,
  ctx: AttributionCtx,
): Promise<QualityMismatch | null> {
  if (typeof storedRepoUrl === 'string' && storedRepoUrl.trim()) {
    return sameRepoUrl(storedRepoUrl, repo.url) ? null : 'result_belongs_to_another_repo';
  }
  if (!repo.is_primary || (ctx.holders.get(container) ?? 0) !== 1) return 'repo_unverified';
  return (await ctx.usedElsewhere(container)) === 0 ? null : 'repo_unverified';
}

function makeAttributionCtx(
  repos: ProjectRepositoryRow[],
  holders: Map<string, number>,
): AttributionCtx {
  const cache = new Map<string, Promise<number>>();
  const ids = repos.map((r) => r.repo_id);
  return {
    repos,
    holders,
    usedElsewhere: (name) => {
      let p = cache.get(name);
      if (!p) {
        p = countContainerNameUsage([name], ids).then((m) => m.get(name) ?? 0);
        cache.set(name, p);
      }
      return p;
    },
  };
}

async function readCi(url: string, sha: string | null, tenantId: string): Promise<CiView> {
  if (!sha) {
    return { state: 'unknown', commit_sha: null, runs: [], reason: 'commit unknown' };
  }
  if (!SHA_RE.test(sha)) {
    return { state: 'unknown', commit_sha: sha, runs: [], reason: 'commit sha is not hex' };
  }
  const gh = parseGithubRepo(url);
  if (!gh) {
    return { state: 'unknown', commit_sha: sha, runs: [], reason: 'not a GitHub repository' };
  }
  try {
    const res = await listWorkflowRunsForSha(
      { owner: gh.owner, repo: gh.repo, head_sha: sha, per_page: 50 },
      tenantId,
    );
    const runs = Array.isArray(res.runs) ? res.runs : [];
    const state = deriveCiState(runs, typeof res.count === 'number' ? res.count : runs.length);
    return {
      state,
      commit_sha: sha,
      runs: runs.map(toRunView),
      ...(state === 'none' ? { reason: 'no CI run for this commit' } : {}),
    };
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'coding-gateway',
      method: 'POST',
      path: '/api/repositories/list-workflow-runs',
      degradedTo: 'ci.state unknown (never success)',
    });
    return { state: 'unknown', commit_sha: sha, runs: [], reason: `CI lookup failed: ${errMessage(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** GET /api/projects/:id/quality. Read lane (loadProjectForRead). */
export async function readProjectQuality(
  user: User,
  projectId: string,
  tenantId: string,
): Promise<ProjectQualityView> {
  const project = await loadProjectForRead(db, user, projectId);
  const set = await loadProjectRepositories(project.id);
  const names = await loadContainerNames(set.repositories.map((r) => r.repo_id));

  const projectTenant = projectTenantOf(project);
  if (projectTenant && projectTenant !== tenantId) {
    // Super-admin cross-tenant read: never query upstream under the caller's
    // tenant for another tenant's project.
    return {
      project_id: project.id,
      cross_tenant: true,
      repositories: set.repositories.map((repo) => ({
        repo_id: repo.repo_id,
        name: repo.name,
        url: repo.url,
        is_primary: repo.is_primary,
        container_name: names.get(repo.repo_id) ?? null,
        latest: notAnalyzedLatest(
          names.get(repo.repo_id) ?? null,
          "This project belongs to another tenant; its stored quality results are not read from here.",
        ),
        ci: { state: 'unknown', commit_sha: null, runs: [], reason: 'cross-tenant read' },
      })),
      analyze_repo_cap: MAX_ANALYZE_REPOS,
      analysis: null,
    };
  }

  const { owner, holders } = containerOwners(set.repositories, names);
  const ctx = makeAttributionCtx(set.repositories, holders);

  const views = await Promise.all(
    set.repositories.map(async (repo): Promise<RepoQualityView> => {
      const container = names.get(repo.repo_id) ?? null;
      const base = {
        repo_id: repo.repo_id,
        name: repo.name,
        url: repo.url,
        is_primary: repo.is_primary,
        container_name: container,
      };
      const unattributed = (mismatch: QualityMismatch): RepoQualityView => ({
        ...base,
        latest: notAnalyzedLatest(container, MISMATCH_MESSAGE[mismatch]),
        mismatch,
        ci: { state: 'unknown', commit_sha: null, runs: [], reason: 'no result for this repository' },
      });
      if (!container) {
        return {
          ...base,
          latest: notAnalyzedLatest(null),
          ci: { state: 'unknown', commit_sha: null, runs: [], reason: 'commit unknown' },
        };
      }
      if (owner.get(container) !== repo.repo_id) return unattributed('shared_container');
      let raw: StoredQualityLatest;
      try {
        raw = await getStoredQualityLatest(container, tenantId);
      } catch (err) {
        // An outage is NOT "not analysed" — say the read failed.
        reportSwallowedFailure(err, {
          service: 'coding-gateway',
          method: 'GET',
          path: '/api/quality/{container}/latest',
          degradedTo: 'latest null + latest_error (not not_analyzed)',
        });
        return {
          ...base,
          latest: null,
          latest_error: errMessage(err),
          ci: { state: 'unknown', commit_sha: null, runs: [], reason: 'quality result unavailable' },
        };
      }
      if (raw.status !== 'not_analyzed') {
        const mismatch = await attribution(repo, container, raw.repo_url, ctx);
        if (mismatch) return unattributed(mismatch);
      }
      const latest = shapeLatest(raw);
      const ci = await readCi(repo.url, latest.commit_sha, tenantId);
      return { ...base, latest, ci };
    }),
  );

  return {
    project_id: project.id,
    repositories: views,
    analyze_repo_cap: MAX_ANALYZE_REPOS,
    analysis: getAnalysisState(project.id),
  };
}

/**
 * GET /api/projects/:id/quality/history?repo_id=. Stored rows only, filtered
 * to rows that belong to THIS repo: a row's own `repo_url` (coding-analysis
 * #108) must match it; a row without one passes only the sole-primary rule.
 * Rows never inherit the container's current /latest verdict.
 */
export async function readProjectQualityHistory(
  user: User,
  projectId: string,
  repoId: string,
  tenantId: string,
): Promise<{
  repo_id: string;
  container_name: string | null;
  status: 'ok' | 'not_analyzed';
  results: StoredQualityHistory['results'];
  mismatch?: QualityMismatch;
  cross_tenant?: boolean;
}> {
  const project = await loadProjectForRead(db, user, projectId);
  const set = await loadProjectRepositories(project.id);
  const repo = set.repositories.find((r) => r.repo_id === repoId);
  if (!repo) {
    throw new NotFoundError('Repository not found on this project');
  }
  const names = await loadContainerNames(set.repositories.map((r) => r.repo_id));
  const container = names.get(repo.repo_id) ?? null;
  const projectTenant = projectTenantOf(project);
  if (projectTenant && projectTenant !== tenantId) {
    return { repo_id: repo.repo_id, container_name: container, status: 'not_analyzed', results: [], cross_tenant: true };
  }
  if (!container) {
    return { repo_id: repo.repo_id, container_name: null, status: 'not_analyzed', results: [] };
  }
  const { owner, holders } = containerOwners(set.repositories, names);
  if (owner.get(container) !== repo.repo_id) {
    return {
      repo_id: repo.repo_id,
      container_name: container,
      status: 'not_analyzed',
      results: [],
      mismatch: 'shared_container',
    };
  }
  const ctx = makeAttributionCtx(set.repositories, holders);
  const h = await getStoredQualityHistory(container, tenantId);
  const rows = Array.isArray(h.results) ? h.results : [];

  const results: StoredQualityHistory['results'] = [];
  let firstMismatch: QualityMismatch | undefined;
  for (const row of rows) {
    const rowUrl = row.repo_url;
    // Each row is judged by the repo IT graded. A container can be
    // re-provisioned from a different repo while older rows stay stored, so a
    // row never inherits the current /latest verdict; an unrecorded repo_url
    // gets only the sole-primary rule.
    const m = await attribution(
      repo,
      container,
      typeof rowUrl === 'string' && rowUrl.trim() ? rowUrl : null,
      ctx,
    );
    if (m) {
      firstMismatch ??= m;
      continue;
    }
    results.push(row);
  }
  return {
    repo_id: repo.repo_id,
    container_name: container,
    status: results.length > 0 ? 'ok' : 'not_analyzed',
    results,
    ...(results.length === 0 && firstMismatch ? { mismatch: firstMismatch } : {}),
  };
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

type StartAnalysisResult =
  | { started: true; state: AnalysisState }
  | { started: false; state: AnalysisState };

const MAX_NAME_ATTEMPTS = 20;

/** Short, stable per-repo discriminator for a colliding name. */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 6);
}

function withSuffix(base: string, suffix: string): string {
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/**
 * Pick the container name for each repo. A stamped name is REUSED (it keeps
 * the upstream history, which is keyed by container name) unless
 *   - another repo of this project already took it (the legacy coordinated
 *     provision stamped ONE name on every repo — primary-first order keeps it), or
 *   - ANY repositories row outside this project carries it (`usedElsewhere` > 0):
 *     provisioning/analysing under it would write into someone else's workspace.
 * A shared stamped name derives `<project-slug>-<repo-slug>`; a missing one
 * derives the project slug (primary — the Provision button's name) or
 * project + repo slug (others). A derived name that is taken here or used
 * elsewhere gets a short hash of the repo id, then a counter.
 */
async function planContainerNames(
  projectName: string,
  repos: ProjectRepositoryRow[],
  stamped: Map<string, string | null>,
  usedElsewhere: (name: string) => Promise<number> = async () => 0,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const free = async (n: string) => !taken.has(n) && (await usedElsewhere(n)) === 0;
  for (const repo of repos) {
    const current = stamped.get(repo.repo_id) ?? null;
    let name: string;
    if (current && (await free(current))) {
      name = current;
    } else {
      const base =
        current || !repo.is_primary
          ? slugContainerName(`${projectName}-${repo.name}`)
          : slugContainerName(projectName);
      name = base;
      if (!(await free(name))) name = withSuffix(base, `-${shortHash(repo.repo_id)}`);
      let n = 2;
      while (!(await free(name))) {
        if (n > MAX_NAME_ATTEMPTS) {
          throw new Error(`no free workspace name for ${repo.name} after ${MAX_NAME_ATTEMPTS} attempts`);
        }
        name = withSuffix(base, `-${shortHash(repo.repo_id)}-${n++}`);
      }
    }
    taken.add(name);
    out.set(repo.repo_id, name);
  }
  return out;
}

async function containerExists(name: string, tenantId: string): Promise<boolean> {
  try {
    await getCodingContainer(name, tenantId);
    return true;
  } catch (err) {
    if (isIntegrationError(err) && err.upstreamStatus === 404) return false;
    throw err;
  }
}

async function waitForNewResult(
  container: string,
  tenantId: string,
  previousResultId: string | null,
): Promise<string | null> {
  const deadline = Date.now() + ANALYZE_RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ANALYZE_POLL_INTERVAL_MS));
    try {
      const latest = await getStoredQualityLatest(container, tenantId);
      if (latest.result_id && latest.result_id !== previousResultId) return latest.result_id;
    } catch (err) {
      // Transient read failure: keep waiting until the deadline.
      reportSwallowedFailure(err, {
        service: 'coding-gateway',
        method: 'GET',
        path: '/api/quality/{container}/latest',
        degradedTo: 'keep polling for the new stored result',
      });
    }
  }
  return null;
}

async function analyzeOneRepo(
  state: AnalysisState,
  progress: RepoAnalysisProgress,
  repo: ProjectRepositoryRow,
  project: ProjectRow,
  containerName: string,
  stampedName: string | null,
  tenantId: string,
): Promise<void> {
  let name = containerName;
  const needsProvision = !stampedName || stampedName !== name || !(await containerExists(name, tenantId));
  if (needsProvision) {
    progress.state = 'provisioning';
    state.state = 'provisioning';
    const body: GithubGitHubRepoRequest = {
      repo_url: repo.url,
      branch: repo.branch ?? 'main',
      container_name: name,
      description: project.description ?? undefined,
    };
    const provisioned = await provisionRepository(body, tenantId);
    name = provisioned.container?.container_name ?? name;
    if (repo.is_primary) {
      await stampPrimaryProvisioned(project.id, repo.repo_id, name);
    } else {
      await stampContainerName(repo.repo_id, name);
    }
    progress.provisioned = true;
  }
  progress.container_name = name;

  let previous: string | null = null;
  try {
    previous = (await getStoredQualityLatest(name, tenantId)).result_id ?? null;
  } catch (err) {
    // Unknown previous id: any stored id then counts as "new" — at worst the
    // wait ends on an older row, never on a fabricated one.
    reportSwallowedFailure(err, {
      service: 'coding-gateway',
      method: 'GET',
      path: '/api/quality/{container}/latest',
      degradedTo: 'previous result id unknown',
    });
    previous = null;
  }

  progress.state = 'analyzing';
  state.state = 'analyzing';
  const accepted = await triggerStoredQualityAnalysis(name, tenantId);
  progress.task_id = accepted.task_id;

  const resultId = await waitForNewResult(name, tenantId, previous);
  if (!resultId) {
    throw new Error(
      `no new stored result within ${Math.round(ANALYZE_RESULT_WAIT_MS / 60000)} min — the analysis may still be running upstream`,
    );
  }
  progress.result_id = resultId;
  progress.state = 'done';
}

async function runAnalysis(
  state: AnalysisState,
  project: ProjectRow,
  repos: ProjectRepositoryRow[],
  stamped: Map<string, string | null>,
  projectRepoIds: string[],
  tenantId: string,
): Promise<void> {
  const usage = new Map<string, Promise<number>>();
  const usedElsewhere = (name: string): Promise<number> => {
    let p = usage.get(name);
    if (!p) {
      p = countContainerNameUsage([name], projectRepoIds).then((m) => m.get(name) ?? 0);
      usage.set(name, p);
    }
    return p;
  };
  const plan = await planContainerNames(project.name, repos, stamped, usedElsewhere);
  for (const repo of repos) {
    const progress = state.repos.find((p) => p.repo_id === repo.repo_id)!;
    try {
      await analyzeOneRepo(
        state,
        progress,
        repo,
        project,
        plan.get(repo.repo_id)!,
        stamped.get(repo.repo_id) ?? null,
        tenantId,
      );
    } catch (err) {
      progress.state = 'error';
      progress.error = errMessage(err);
    }
  }
  const failed = state.repos.filter((p) => p.state === 'error');
  state.finished_at = new Date(Date.now()).toISOString();
  if (failed.length > 0) {
    state.state = 'error';
    state.error = failed.map((p) => `${p.name}: ${p.error}`).join('; ');
  } else {
    state.state = 'done';
  }
}

/**
 * POST /api/projects/:id/quality/analyze. Write lane (loadTenantScopedProject —
 * the same gate as Provision). Returns immediately; the work runs in the
 * background. A second call while one is in flight is refused with the
 * current state (the route maps it to 409).
 */
export async function startProjectQualityAnalysis(
  user: User,
  projectId: string,
  tenantId: string,
): Promise<StartAnalysisResult> {
  const project = await loadTenantScopedProject(db, user, projectId);
  const existing = analyses.get(project.id);
  if (isInFlight(existing)) return { started: false, state: structuredClone(existing!) };

  // Claim the slot in the SAME synchronous block as the check above — before
  // any further await — so a concurrent POST sees it and is refused.
  const state: AnalysisState = {
    state: 'provisioning',
    started_at: new Date(Date.now()).toISOString(),
    repos: [],
  };
  analyses.set(project.id, state);

  let repos: ProjectRepositoryRow[];
  let projectRepoIds: string[];
  try {
    const set = await loadProjectRepositories(project.id);
    repos = set.repositories.slice(0, MAX_ANALYZE_REPOS);
    projectRepoIds = set.repositories.map((r) => r.repo_id);
  } catch (err) {
    analyses.delete(project.id);
    throw err;
  }
  state.repos = repos.map((r) => ({
    repo_id: r.repo_id,
    name: r.name,
    container_name: null,
    state: 'pending',
  }));
  if (repos.length === 0) {
    state.state = 'error';
    state.error = 'This project has no repositories to analyse.';
    state.finished_at = state.started_at;
    return { started: true, state: structuredClone(state) };
  }

  void (async () => {
    try {
      const stamped = await loadContainerNames(repos.map((r) => r.repo_id));
      await runAnalysis(state, project, repos, stamped, projectRepoIds, tenantId);
    } catch (err) {
      state.state = 'error';
      state.error = errMessage(err);
      state.finished_at = new Date(Date.now()).toISOString();
    }
  })();

  return { started: true, state: structuredClone(state) };
}
