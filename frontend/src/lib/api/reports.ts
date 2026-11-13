// src/lib/api/reports.ts
//
// Client for the read-only reporting surface (backend Phase 6).
//
// This module only READS the six report endpoints
// registered in backend/src/server.ts:2076-2083.
//
// The backend is NOT envelope-consistent across these six routes, and this
// module is the single place that fact is absorbed. Verified shapes:
//
//   GET /api/reports                            -> { items, total }   (bare)
//     backend/src/routes/reports.ts:193
//   GET /api/reports/:reportId                  -> ProjectReport      (bare row)
//     backend/src/routes/reports.ts:216
//   GET /api/reports/approval-backlog           -> { data: ... }
//     backend/src/routes/reports/index.ts:34
//   GET /api/reports/project-status/:projectId  -> { data: ... }
//     backend/src/routes/reports/index.ts:47
//   GET /api/reports/worker-activity/:workerId  -> { data: ... }
//     backend/src/routes/reports/index.ts:64
//   GET /api/reports/asset-changes/:assetType   -> { data: ... }
//     backend/src/routes/reports/index.ts:86
//
// `jsonResponse` (backend/src/utils/response.ts:2) adds NO outer wrapper, so
// what the handler passes is exactly what lands on the wire.
//
// AUTH: every one of the six calls `validateAuth(req)` and nothing more — no
// super-admin gate, no role gate. Tenant scoping is applied server-side inside
// the query (migration 080) or upstream in the integration client. That is why
// the nav entry for this surface is UNGATED; see navConfig.ts.
import { authFetch } from './auth-fetch';

interface DataEnvelope<T> {
  data: T;
}

// --- Stored n8n-generated reports (project_reports table) -----------------
// Column set mirrors backend/src/db/schema.ts:594-616. `Date` columns arrive
// as ISO strings once JSON.stringify has run over them.

export interface ProjectReport {
  id: string;
  tenant_id: string | null;
  project_id: string | null;
  card_id: string | null;
  report_type: string;
  title: string;
  summary: string;
  details: unknown;
  board_id: string | null;
  generated_by: string | null;
  /** Migration 147 (U2): H_r for a `bug_report`; null for every other type. */
  content_hash?: string | null;
  /** Migration 149: AA-TRACE join key (UUIDv7) of the writing run; null = orphan. */
  trace_id?: string | null;
  created_at: string;
}

// --- Composed reporting domain shapes ------------------------------------
// backend/src/domain/reporting/index.ts

/** backend/src/domain/reporting/index.ts:18 */
export interface ApprovalSummary {
  id: string;
  project_id: string | null;
  description: string;
  status: string;
  created_at: string;
  expires_at: string;
  role: string | null;
}

/** backend/src/domain/reporting/index.ts:28 */
export interface ApprovalBacklog {
  pending: ApprovalSummary[];
  count: number;
}

/** backend/src/domain/reporting/index.ts:71 */
export interface ProjectStatus {
  // `project` is typed `unknown` in the domain — it is the raw `projects` row.
  // We narrow only the fields we render and tolerate their absence.
  project: Record<string, unknown> | null;
  openApprovals: ApprovalSummary[];
  recentDecisions: Array<{
    approval_id: string;
    approver_id: string;
    /** Resolved display name (FR-9); null/absent when unresolved. */
    approver_name?: string | null;
    decision: string;
    decided_at: string;
    comment: string | null;
  }>;
  boardProgress: {
    lists: Array<{
      id: string;
      name: string;
      /**
       * ⛔ THREE STATES — see `backend/src/domain/reporting/index.ts`.
       *   N  + `cardCountComplete: true`  — exact.
       *   N  + `cardCountComplete: false` — AT LEAST N (Planka pages at 50).
       *   null                            — the list could not be read at all.
       *
       * Nullable and optional because an older backend sends neither field; an
       * explicit null check and `=== false` are the only tests, so an absent
       * field is never read as a claim in either direction.
       */
      cardCount: number | null;
      cardCountComplete?: boolean;
    }>;
  } | null;
}

/** backend/src/integrations/workers.ts:134 */
export interface WorkerActivityEvent {
  at: string;
  status: string;
  detail?: string | null;
}

/** backend/src/domain/reporting/index.ts:188 */
export interface WorkerActivity {
  worker: Record<string, unknown> | null;
  since?: string;
  events: WorkerActivityEvent[];
}

/** backend/src/domain/reporting/index.ts:210 */
export const ASSET_TYPES = ['requirements', 'decisions', 'principles'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** backend/src/domain/reporting/index.ts:212 */
export interface AssetChange {
  id?: string;
  version?: number | string;
  updated_at?: string;
  raw: unknown;
}

/** backend/src/domain/reporting/index.ts:219 */
export interface AssetChangeHistory {
  changes: AssetChange[];
  assetType: AssetType;
  since?: string;
  /**
   * The domain sets this when an upstream has no versions endpoint (today:
   * `requirements`). It is an explicit capability gap, NOT an empty result —
   * the UI must render it as such rather than showing "no changes".
   */
  note?: string;
}

// --- Error handling ------------------------------------------------------
// Local `ensureOk` mirrors src/lib/api/notifications.ts:69 so a failed report
// call surfaces the status AND the body, never a blank page.

async function ensureOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      /* body already consumed or not readable — the status still names it */
    }
    throw new Error(
      `${label} failed: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

// --- Calls ---------------------------------------------------------------

export interface ListReportsOptions {
  type?: string;
  projectId?: string;
  /** `card_id` filter (U2: the card view lists that card's reports). */
  cardId?: string;
  /** Backend clamps to 200 (MAX_REPORTS_LIMIT, reports.ts:160). */
  limit?: number;
}

/** GET /api/reports — bare `{ items, total }`, NOT a data envelope. */
export async function listReports(opts: ListReportsOptions = {}): Promise<ProjectReport[]> {
  const sp = new URLSearchParams();
  if (opts.type) sp.set('type', opts.type);
  if (opts.projectId) sp.set('project_id', opts.projectId);
  if (opts.cardId) sp.set('card_id', opts.cardId);
  if (opts.limit) sp.set('limit', String(opts.limit));
  const qs = sp.toString();
  const resp = await authFetch(`/api/reports${qs ? `?${qs}` : ''}`);
  await ensureOk(resp, 'reports.list');
  const json = (await resp.json()) as { items?: ProjectReport[] };
  return Array.isArray(json?.items) ? json.items : [];
}

/** GET /api/reports/:reportId — the row itself, with NO wrapper. */
export async function getReport(reportId: string): Promise<ProjectReport> {
  const resp = await authFetch(`/api/reports/${encodeURIComponent(reportId)}`);
  await ensureOk(resp, 'reports.get');
  return (await resp.json()) as ProjectReport;
}

/** GET /api/reports/approval-backlog */
export async function getApprovalBacklog(): Promise<ApprovalBacklog> {
  const resp = await authFetch('/api/reports/approval-backlog');
  await ensureOk(resp, 'reports.approval-backlog');
  const json = (await resp.json()) as DataEnvelope<ApprovalBacklog>;
  return {
    pending: Array.isArray(json?.data?.pending) ? json.data.pending : [],
    count: typeof json?.data?.count === 'number' ? json.data.count : 0,
  };
}

/** GET /api/reports/project-status/:projectId */
export async function getProjectStatus(projectId: string): Promise<ProjectStatus> {
  const resp = await authFetch(
    `/api/reports/project-status/${encodeURIComponent(projectId)}`,
  );
  await ensureOk(resp, 'reports.project-status');
  const json = (await resp.json()) as DataEnvelope<ProjectStatus>;
  const d = json?.data;
  return {
    project: (d?.project as Record<string, unknown> | null) ?? null,
    openApprovals: Array.isArray(d?.openApprovals) ? d.openApprovals : [],
    recentDecisions: Array.isArray(d?.recentDecisions) ? d.recentDecisions : [],
    // `null` is meaningful: the project has no planka_board_id, so the kanban
    // half was skipped. That is different from "a board with zero lists".
    boardProgress: d?.boardProgress ?? null,
  };
}

/** GET /api/reports/worker-activity/:workerId?since=ISO8601 */
export async function getWorkerActivity(
  workerId: string,
  since?: string,
): Promise<WorkerActivity> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const resp = await authFetch(
    `/api/reports/worker-activity/${encodeURIComponent(workerId)}${qs}`,
  );
  await ensureOk(resp, 'reports.worker-activity');
  const json = (await resp.json()) as DataEnvelope<WorkerActivity>;
  const d = json?.data;
  return {
    worker: (d?.worker as Record<string, unknown> | null) ?? null,
    since: d?.since,
    events: Array.isArray(d?.events) ? d.events : [],
  };
}

/** GET /api/reports/asset-changes/:assetType?since=ISO8601&assetId=... */
export async function getAssetChanges(
  assetType: AssetType,
  opts: { since?: string; assetId?: string } = {},
): Promise<AssetChangeHistory> {
  const sp = new URLSearchParams();
  if (opts.since) sp.set('since', opts.since);
  if (opts.assetId) sp.set('assetId', opts.assetId);
  const qs = sp.toString();
  const resp = await authFetch(
    `/api/reports/asset-changes/${encodeURIComponent(assetType)}${qs ? `?${qs}` : ''}`,
  );
  await ensureOk(resp, 'reports.asset-changes');
  const json = (await resp.json()) as DataEnvelope<AssetChangeHistory>;
  const d = json?.data;
  return {
    changes: Array.isArray(d?.changes) ? d.changes : [],
    assetType: d?.assetType ?? assetType,
    since: d?.since,
    note: d?.note,
  };
}
