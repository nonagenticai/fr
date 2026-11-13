// src/routes/metrics.ts
//
// Operator-facing project-metrics surface (cycle/lead time, throughput).
// Product-facing analytics (KPI rollups, agent-vs-human breakdowns, CSV
// export) live in `routes/tools/analytics.ts` and are documented in
// `docs/superpowers/specs/completed/2026-04-24-analytics-page.md`. Do NOT bolt new
// user-facing reports onto this file — keep the audience separation explicit.
//
// This file ALSO hosts the Prometheus text-exposition exporter served at
// GET /api/metrics/prom — see §"Open follow-ups" of
// docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md.
// The exporter is unauthenticated and intentionally minimal: a single
// kanban-liveness gauge + a status-keyed n8n executions counter.
import { db, projectMetrics, projects, departments } from '../db/client';
import { eq, and, gte, lte, desc, type SQL } from 'drizzle-orm';
import { projectIsNotPreApproval } from '../lib/project-live-status';
import {
  loadProjectForRead,
  tenantScopedProjectFilter,
  licenceProjectScope,
} from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { validateAuth } from '../middleware/auth';
import { BadRequestError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { wsManager } from '../domain/engagement/adapters/websocket';
import { getKanbanLivenessSnapshot } from './kanbanWebSocket';
import { renderDeblockActionMetrics } from '../lib/deblock-action-metrics';
import { renderConveyorRefusalMetrics } from '../lib/conveyor-refusal-metrics';
import { renderAndonGateMetrics } from '../lib/andon-gate-metrics';
import { renderAndonHaltMetrics, renderAndonProbeMetrics } from '../lib/andon-halt-metrics';
import { renderCardPhaseLeaseEmitMetrics } from '../lib/card-phase-lease-emit-metrics';
import { renderPriorityCompensationMetrics } from '../lib/priority-compensation-metrics';
import { renderKeycloakLookupMetrics } from '../lib/keycloak-lookup-metrics';
import { renderRosterDischargeMetrics } from '../lib/roster-discharge-metrics';
import { renderBoardTenantGateRefusalMetrics } from '../lib/board-tenant-gate-metrics';
import { renderKanbanWsRefusalMetrics } from '../lib/kanban-ws-refusal-metrics';
import { renderApprovalsWsRefusalMetrics } from '../lib/approvals-ws-refusal-metrics';
import { renderProposalScoreMetrics } from '../lib/proposal-score-metrics';
import { renderAnswerabilityMetrics } from '../lib/approval-answerability-metrics';
import { renderAcCoverageStuckMetrics } from '../lib/ac-coverage-stuck-metrics';
import { renderActiveTenantHeaderMetrics } from '../lib/active-tenant-header-metrics';
import { renderSuperAdminSwitchMetrics } from '../lib/super-admin-tenant-audit';
import { renderAssetAuthoringCardOwnerMetrics } from '../lib/asset-authoring-card-owner';
import { renderSaTenantFromSubMetrics } from '../lib/sa-tenant-from-sub';
import { renderCardApprovalTenantCheckMetrics } from '../lib/card-approval-tenant-check';
import { renderWsPublishDroppedMetrics } from '../lib/ws-tenant-publish-metrics';
import { renderMeteringSpanMetrics } from '../lib/metering-span-metrics';
import { renderProjectIdEmitMetrics } from '../lib/project-id-emit-metrics';

/* ────────────────────────────────────────────────────────────────────────── */
/*  ?start_date= / ?end_date= — one parse, shared by both metrics handlers    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The parsed `?start_date=` / `?end_date=` window.
 *
 * TWO PAIRS, deliberately. `startFilter`/`endFilter` are the bounds that go
 * into the SQL and are `null` when the caller did not supply that param;
 * `startDate`/`endDate` are the display window echoed back in `time_period`
 * and keep the pre-existing defaults (now−30d / now). They are NOT the same
 * thing and collapsing them is exactly the defect below.
 */
interface MetricsDateWindow {
  /** Lower bound to filter on, or null when `start_date` was not supplied. */
  startFilter: Date | null;
  /** Upper bound to filter on, or null when `end_date` was not supplied. */
  endFilter: Date | null;
  /** `time_period.start` — the default display window, unchanged. */
  startDate: Date;
  /** `time_period.end` — the default display window, unchanged. */
  endDate: Date;
}

/**
 * Parse one date query param, or refuse.
 *
 * ⚠️ MEASURED on the real handlers 2026-09-08, driving them against a migrated
 * postgres:18: `GET /api/projects/<id>/metrics?start_date=yesterday` answered
 * **500 `{"error":"Internal server error"}`**, and so did
 * `GET /api/metrics/aggregate?end_date=not-a-date`. An `Invalid Date` reaches
 * drizzle's `timestamp(mode:'date')` mapper, which throws a `RangeError` while
 * building the statement — before a single row is read — and that escapes to
 * `handleError`'s catch-all.
 *
 * A typo'd date can NEVER succeed, so answering 5xx is not merely untidy: it is
 * the third recorded instance in this repo of a permanent caller error being
 * dressed as a transient server error. `routes/agui.ts classifyError` advertises
 * `retriable: true` for 5xx and ~20 n8n node modules retry on
 * `statusCode >= 500`, so the caller retries a request that cannot ever work
 * until it exhausts its budget. `utils/errors.ts pgErrorCode` records the same
 * shape for SQLSTATE 22P02.
 *
 * IDIOM MATCHED: `routes/webhooks/budget-threshold.ts` (~:83) — `new Date(x)` +
 * `Number.isNaN(d.getTime())` → `BadRequestError` whose message names the param
 * AND its value. Same class of caller (a machine that retries non-2xx forever),
 * same refusal. Deliberately NOT the zod `z.string().datetime()` idiom: that
 * idiom is used in this repo for JSON BODIES (`routes/kanban/cards.ts`,
 * `types/intake-envelope.ts`, `services/improvement-cards/request-schema.ts`),
 * it maps to **422**, and it demands strict RFC-3339 — which would newly reject
 * the plain `?end_date=2026-02-01` this endpoint accepts today and has always
 * accepted. Narrowing a live success path is not this change's business.
 * `BadRequestError` is also what `routes/approvals.ts` (~:587) settled on for
 * exactly this question, with the measurement written down: `ValidationError`
 * in `utils/errors.ts` carries 422, and a malformed query param is a MALFORMED
 * request (400), not a well-formed one that cannot be processed (422).
 *
 * An EMPTY value (`?start_date=`) is treated as ABSENT, not as an error — that
 * is what a form control submits for "no filter", it is byte-identical to the
 * pre-change behaviour (`'' ` is falsy, so both the old ternary and the old
 * `if (startDateStr || endDateStr)` already read it as absent), and
 * `parseApprovalStatusFilter` makes the same call for the same reason.
 * Whitespace-only is folded into that too; it used to be a 500.
 */
function parseDateParam(name: string, raw: string | null): Date | null {
  if (raw === null || raw.trim() === '') return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`Unparseable ${name}: ${raw}`);
  }
  return parsed;
}

/**
 * Parse `?start_date=`/`?end_date=` into the bounds to filter on plus the
 * display window. Throws `BadRequestError` (400) for an unparseable value or
 * an inverted range.
 *
 * ⚠️ THE INVERTED-RANGE REFUSAL IS THE POINT OF THE SPLIT. This used to push
 * BOTH bounds whenever EITHER param was present:
 *
 *     if (startDateStr || endDateStr) {
 *       conditions.push(gte(projectMetrics.date, startDate));   // default now−30d
 *       conditions.push(lte(projectMetrics.date, endDate));
 *     }
 *
 * so `?end_date=2026-02-01` alone emitted `date >= <now−30d> AND date <=
 * 2026-02-01` — a provably empty interval. MEASURED on the real handler with a
 * seeded row at 2026-01-15: `data_points: 0`, a fully zeroed metrics card, HTTP
 * **200**. Supplying both bounds over the same window returned that row
 * (`data_points: 1`), so the row was there and the filter was the liar. A user
 * narrowing to a historical window was shown "no data" for a question that had
 * an answer — the failure mode nothing downstream can detect, because 200 with
 * zeros is indistinguishable from a genuinely empty period.
 *
 * Each bound is now pushed ONLY when its own param was supplied. An absent
 * `start_date` therefore means "no lower bound", which is the same thing the
 * no-params path has always meant (it pushes no bounds at all and returns every
 * row) — so this makes the one-param case consistent with the zero-param case
 * rather than inventing a third behaviour.
 *
 * `start_date > end_date` with BOTH supplied is a **400**, not a silent empty
 * result. It is the one inverted range a caller can still ask for after the
 * split, it can never match a row, and returning 200-with-zeros for it is the
 * same lie this function exists to remove. Equal bounds are allowed: a
 * single-instant window is a legitimate (if narrow) question.
 *
 * `time_period` in the response is UNCHANGED — it still echoes the now−30d/now
 * defaults for an absent param. It has never been the filter (the no-params
 * path already returns rows outside it), and changing it would move a live
 * success-path value.
 */
function parseMetricsDateWindow(url: URL): MetricsDateWindow {
  const startFilter = parseDateParam('start_date', url.searchParams.get('start_date'));
  const endFilter = parseDateParam('end_date', url.searchParams.get('end_date'));

  if (startFilter && endFilter && startFilter.getTime() > endFilter.getTime()) {
    throw new BadRequestError(
      `start_date (${url.searchParams.get('start_date')}) is after end_date ` +
        `(${url.searchParams.get('end_date')}): the range is empty`,
    );
  }

  return {
    startFilter,
    endFilter,
    startDate: startFilter ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    endDate: endFilter ?? new Date(),
  };
}

/**
 * The date conditions for one metrics query — one bound per supplied param.
 *
 * Exported so a hermetic test can render the ACTUAL predicates through
 * drizzle's own `PgDialect` and assert which bounds reach Postgres. That is the
 * property the defect was about (which predicates get emitted), and rendering
 * needs no database, so the test can never be skipped for lack of one.
 */
function dateConditions(window: MetricsDateWindow): SQL[] {
  const out: SQL[] = [];
  if (window.startFilter) out.push(gte(projectMetrics.date, window.startFilter));
  if (window.endFilter) out.push(lte(projectMetrics.date, window.endFilter));
  return out;
}

/**
 * GET /api/projects/:projectId/metrics
 * Get project metrics for a date range
 */
export async function handleGetProjectMetrics(
  req: Request,
  projectId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Query params are validated BEFORE the project lookup on purpose: a
  // malformed date is a caller error whatever project it names, the refusal is
  // identical for a reachable and an unreachable project (so it leaks no
  // existence — the reason `loadProjectForRead` answers 404 rather than
  // 400 for a malformed id), and refusing here costs no DB round-trip. The only
  // behaviour this moves is a request that is BOTH malformed and unreachable:
  // 404 → 400. Everything else keeps its status.
  const window = parseMetricsDateWindow(new URL(req.url));
  const { startDate, endDate } = window;

  // Verify the project exists and is reachable in the requester's active
  // tenant (owner-AND-tenant gate, same as routes/projects.ts get/delete).
  await loadProjectForRead(db, user, projectId);

  // Get metrics for the period
  const conditions: SQL[] = [
    eq(projectMetrics.project_id, projectId),
    ...dateConditions(window),
  ];

  const metrics = await db.select()
    .from(projectMetrics)
    .where(and(...conditions))
    .orderBy(desc(projectMetrics.date));

  // Calculate averages
  const avgMetrics = metrics.reduce(
    (acc, m) => {
      acc.cycle_time_days += m.cycle_time_days || 0;
      acc.lead_time_days += m.lead_time_days || 0;
      acc.throughput += m.throughput || 0;
      acc.success_rate += m.success_rate || 0;
      acc.error_rate += m.error_rate || 0;
      acc.quality_score += m.quality_score || 0;
      acc.completed_tasks += m.completed_tasks || 0;
      acc.failed_tasks += m.failed_tasks || 0;
      acc.count++;
      return acc;
    },
    {
      cycle_time_days: 0,
      lead_time_days: 0,
      throughput: 0,
      success_rate: 0,
      error_rate: 0,
      quality_score: 0,
      completed_tasks: 0,
      failed_tasks: 0,
      count: 0,
    }
  );

  const count = avgMetrics.count || 1;

  return jsonResponse({
    project_id: projectId,
    time_period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    metrics: {
      cycle_time_days: avgMetrics.cycle_time_days / count,
      lead_time_days: avgMetrics.lead_time_days / count,
      throughput: avgMetrics.throughput,
      success_rate: avgMetrics.success_rate / count,
      error_rate: avgMetrics.error_rate / count,
      quality_score: avgMetrics.quality_score / count,
      total_tasks: avgMetrics.completed_tasks + avgMetrics.failed_tasks,
      completed_tasks: avgMetrics.completed_tasks,
      failed_tasks: avgMetrics.failed_tasks,
    },
    data_points: metrics.length,
  });
}

/**
 * GET /api/metrics/aggregate
 * Get aggregated metrics across all user's projects
 */
export async function handleGetAggregateMetrics(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  // Validated up front, before the projects scan — same rationale as
  // handleGetProjectMetrics, plus one extra: this handler short-circuits to a
  // 200 when the caller owns no projects, so a malformed date used to be
  // answered 200-and-empty for those users and 500 for everyone else. One
  // refusal for both.
  const window = parseMetricsDateWindow(new URL(req.url));
  const { startDate, endDate } = window;

  // Get the user's projects scoped to the active tenant (same projection as
  // handleListProjects, so the aggregate respects the super-admin tenant
  // switch instead of spanning every tenant the user owns a project in).
  const activeTenantId = ctxTenantId(user.tenantId);
  const userProjectRows = await db.select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    // A project request's pre-approval row (pending / cancelled) is not a
    // project; archived stays counted exactly as before (lib/project-live-status.ts).
    .where(
      and(
        tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, licenceProjectScope(user)),
        projectIsNotPreApproval(),
      ),
    );
  const userProjects = userProjectRows.map((r) => r.project);

  if (userProjects.length === 0) {
    return jsonResponse({
      projects_count: 0,
      aggregate_metrics: {},
      by_project: [],
    });
  }

  // Get metrics for all projects
  const projectIds = userProjects.map(p => p.id);
  const allMetrics: any[] = [];

  for (const projectId of projectIds) {
    const conditions: SQL[] = [
      eq(projectMetrics.project_id, projectId),
      ...dateConditions(window),
    ];

    const metrics = await db.select()
      .from(projectMetrics)
      .where(and(...conditions));
    allMetrics.push(...metrics);
  }

  // Calculate aggregates
  const totals = allMetrics.reduce(
    (acc, m) => {
      acc.cycle_time_days += m.cycle_time_days || 0;
      acc.lead_time_days += m.lead_time_days || 0;
      acc.throughput += m.throughput || 0;
      acc.success_rate += m.success_rate || 0;
      acc.error_rate += m.error_rate || 0;
      acc.quality_score += m.quality_score || 0;
      acc.completed_tasks += m.completed_tasks || 0;
      acc.failed_tasks += m.failed_tasks || 0;
      acc.count++;
      return acc;
    },
    {
      cycle_time_days: 0,
      lead_time_days: 0,
      throughput: 0,
      success_rate: 0,
      error_rate: 0,
      quality_score: 0,
      completed_tasks: 0,
      failed_tasks: 0,
      count: 0,
    }
  );

  const count = totals.count || 1;

  return jsonResponse({
    time_period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    projects_count: userProjects.length,
    aggregate_metrics: {
      average_cycle_time_days: totals.cycle_time_days / count,
      average_lead_time_days: totals.lead_time_days / count,
      total_throughput: totals.throughput,
      overall_success_rate: totals.success_rate / count,
      overall_error_rate: totals.error_rate / count,
      overall_quality_score: totals.quality_score / count,
      total_tasks: totals.completed_tasks + totals.failed_tasks,
      completed_tasks: totals.completed_tasks,
      failed_tasks: totals.failed_tasks,
    },
    by_project: userProjects.map(p => ({
      project_id: p.id,
      project_name: p.name,
      data_points: allMetrics.filter(m => m.project_id === p.id).length,
    })),
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Prometheus text-exposition exporter — GET /api/metrics/prom               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Status labels we always emit for `fr_n8n_executions_total`. Keeping all
 * four present (even at 0) lets Prometheus alerts use `rate(... status="error")`
 * without worrying about cold-start absence.
 */
const N8N_EXECUTION_STATUSES = ['success', 'error', 'running', 'waiting'] as const;

const n8nExecutionsTotal = new Map<string, number>(
  N8N_EXECUTION_STATUSES.map((s) => [s, 0]),
);

/**
 * Increment the `fr_n8n_executions_total{status=...}` counter. Unknown
 * statuses are recorded as well (Prom permits arbitrary label values), so
 * upstream additions don't get silently dropped.
 *
 * Wired from the n8n integration adapter — see `routes/tools/n8n.ts` where
 * terminal executions are deduped via the `counted_terminal` flag on the
 * mapping row before being counted here.
 */
/**
 * ⛔ SANITISE AND BOUND AT THE RECORDER, because the exporter's escaping is not a
 * sufficient fence and this value is UPSTREAM-CONTROLLED (n8n decides the string).
 *
 * Two faults were latent here for as long as this counter has existed, and both were
 * harmless only because NOTHING SCRAPED fr. Making fr scrapable ACTIVATES them, so
 * they are fixed in the same change:
 *
 *   1. A CARRIAGE RETURN ENDS THE WHOLE EXPOSITION. The exporter escaped `\`, `"`
 *      and `\n` but not `\r`. One `\r` in one status makes the payload unparseable,
 *      so Prometheus drops the ENTIRE fr scrape to up=0 — every counter, not just
 *      this one — and nothing records why. `ScrapeTargetDownSustained` would then
 *      page an hour later naming the target and not the cause.
 *   2. UNBOUNDED LABEL CARDINALITY. `set()` on an unbounded key grew this map without
 *      limit; a status carrying an id or a timestamp is a cardinality bomb in the
 *      TSDB, and the pod holds the map for its whole life.
 *
 * So: strip C0/C1 control characters, collapse whitespace, cap the length, and bucket
 * everything beyond a generous distinct-value ceiling into `other` rather than
 * refusing it — losing the exact name of an unexpected status is recoverable, losing
 * every fr metric is not.
 */
const N8N_STATUS_MAX_LEN = 64;
const N8N_STATUS_MAX_DISTINCT = 64;
const N8N_STATUS_OVERFLOW = 'other';

function normaliseN8nStatus(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned.length > N8N_STATUS_MAX_LEN ? cleaned.slice(0, N8N_STATUS_MAX_LEN) : cleaned;
}

export function recordN8nExecutionStatus(status: string): void {
  if (!status) return;
  const key = normaliseN8nStatus(status);
  if (!key) return;
  const canonical = (N8N_EXECUTION_STATUSES as readonly string[]).includes(key);
  if (!canonical && !n8nExecutionsTotal.has(key)) {
    const distinct = n8nExecutionsTotal.size;
    if (distinct >= N8N_STATUS_MAX_DISTINCT) {
      n8nExecutionsTotal.set(
        N8N_STATUS_OVERFLOW,
        (n8nExecutionsTotal.get(N8N_STATUS_OVERFLOW) ?? 0) + 1,
      );
      return;
    }
  }
  n8nExecutionsTotal.set(key, (n8nExecutionsTotal.get(key) ?? 0) + 1);
}

/**
 * Resolve the oldest kanban subscription lag in seconds.
 *
 * Prefers `wsManager.getLivenessSnapshot().oldestLagMs` if a parallel
 * heartbeat-loop branch has landed it; otherwise falls back to the existing
 * `getKanbanLivenessSnapshot().maxLagSeconds` from `routes/kanbanWebSocket`.
 * Returns `null` when neither source can answer.
 *
 * ⚠️ It used to return 0, with the rationale "the gauge is always emitted so
 * Grafana panels never see 'no data'". That is backwards, and it disarmed the
 * alert: 0 means "zero lag", i.e. perfect health, so an outage of the
 * liveness-tracking subsystem ITSELF rendered as the healthiest possible value
 * and `fr_kanban_liveness_lag_seconds > threshold` could never fire. "No data"
 * is the honest signal a monitoring system is built to act on; a fabricated
 * zero is the one thing it cannot see through.
 */
function readKanbanLivenessLagSecondsReal(): number | null {
  const candidate = wsManager as unknown as {
    getLivenessSnapshot?: () => { oldestLagMs?: number };
  };
  if (typeof candidate.getLivenessSnapshot === 'function') {
    try {
      const snap = candidate.getLivenessSnapshot();
      const oldestMs = snap?.oldestLagMs;
      if (typeof oldestMs === 'number' && Number.isFinite(oldestMs) && oldestMs >= 0) {
        return oldestMs / 1000;
      }
    } catch {
      // Fall through to the legacy snapshot helper.
    }
  }
  try {
    const snap = getKanbanLivenessSnapshot();
    const lag = snap.maxLagSeconds;
    if (typeof lag === 'number' && Number.isFinite(lag) && lag >= 0) {
      return lag;
    }
  } catch {
    // Helpful in tests where the kanban WS module hasn't been initialised.
  }
  return null;
}

/**
 * Render the Prom text-exposition body. Format: 0.0.4 (the only one
 * Prometheus' `expfmt` parser accepts as `text/plain; version=0.0.4`).
 */
export function renderPromExporter(): string {
  const lines: string[] = [];

  // The sample is OMITTED when the lag is unknown, so `absent()` fires and the
  // threshold alert cannot be satisfied by a fabricated zero. The companion
  // gauge is always emitted, giving alerting a positive signal to key on
  // (`fr_kanban_liveness_lag_available == 0`) rather than only an absence.
  const lagSeconds = readKanbanLivenessLagSecondsReal();
  lines.push('# HELP fr_kanban_liveness_lag_seconds Oldest kanban subscription lag in seconds.');
  lines.push('# TYPE fr_kanban_liveness_lag_seconds gauge');
  if (lagSeconds !== null) {
    lines.push(`fr_kanban_liveness_lag_seconds ${lagSeconds}`);
  }
  lines.push(
    '# HELP fr_kanban_liveness_lag_available 1 when the kanban liveness lag could be read, 0 when it could not.',
  );
  lines.push('# TYPE fr_kanban_liveness_lag_available gauge');
  lines.push(`fr_kanban_liveness_lag_available ${lagSeconds === null ? 0 : 1}`);

  lines.push('# HELP fr_n8n_executions_total Total n8n executions observed by status.');
  lines.push('# TYPE fr_n8n_executions_total counter');
  for (const status of N8N_EXECUTION_STATUSES) {
    lines.push(`fr_n8n_executions_total{status="${status}"} ${n8nExecutionsTotal.get(status) ?? 0}`);
  }
  // Emit any non-canonical statuses that have been recorded so callers don't
  // lose visibility into upstream additions.
  for (const [status, n] of n8nExecutionsTotal.entries()) {
    if ((N8N_EXECUTION_STATUSES as readonly string[]).includes(status)) continue;
    // \r IS NOT OPTIONAL: a bare CR ends the exposition line and invalidates the whole
    // payload, taking every fr metric to up=0. The recorder already strips control
    // characters; this stays as defence in depth for any other writer of this map.
    const escaped = status
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
    lines.push(`fr_n8n_executions_total{status="${escaped}"} ${n}`);
  }

  // Metering-span attribution — the counter that makes an un-attributed
  // billing event a number instead of an invisible write to the nil tenant.
  // Owned by lib/metering-span-metrics.ts (see the header there for the why).
  lines.push(...renderMeteringSpanMetrics());

  // BLOCKED-exit actions — the counter that turns "the human approved it and the card
  // did not move" into a number. Owned by lib/deblock-action-metrics.ts.
  lines.push(...renderDeblockActionMetrics());

  // Keycloak reverse identity lookups — the counter that turns "getUserById
  // returned null and said nothing" into a rate, split by outcome AND by the
  // realm queried. Owned by lib/keycloak-lookup-metrics.ts (issue #1031).
  lines.push(...renderKeycloakLookupMetrics());

  // Card-phase-lease `lease.released` emits that failed (fire-and-forget, so a
  // lost notification is otherwise invisible). Owned by
  // lib/card-phase-lease-emit-metrics.ts.
  lines.push(...renderCardPhaseLeaseEmitMetrics());

  // Card-priority writes whose restore-after-failure itself failed (Planka may
  // hold an unaudited change). Expected zero. Owned by
  // lib/priority-compensation-metrics.ts.
  lines.push(...renderPriorityCompensationMetrics());

  // Approval roster discharge — the counter that turns "a role match discharged an
  // obligation named for somebody else" into a rate WITH its correct-case
  // denominator. Owned by lib/roster-discharge-metrics.ts (issue #1059). It
  // changes no authorization outcome; it makes an existing one visible.
  lines.push(...renderRosterDischargeMetrics());

  // Inbound conveyor refusals — the counter that makes a dropped n8n/agent
  // writeback a number instead of a line in a pod log that dies with the pod.
  // Owned by lib/conveyor-refusal-metrics.ts. It changes no refusal outcome; it
  // makes the existing ones visible, correct ones included.
  lines.push(...renderConveyorRefusalMetrics());

  // Global andon interlock answers — how often the cord consult said "stop",
  // and WHY. `reason="unreadable"` is work refused because the switch itself
  // could not be read (absent singleton, or a read that threw) rather than
  // because an operator pulled it; `reason="released"` is the denominator that
  // tells a quiet system apart from a dead exporter. Owned by
  // lib/andon-gate-metrics.ts. It changes no gate outcome; it makes the
  // existing ones visible.
  lines.push(...renderAndonGateMetrics());

  // Global andon BRAKE decisions — how much WORK the cord stopped, which the
  // gate-answer counter above cannot say (it counts consults of the switch, not
  // dispatches refused). One call per Planka card move, so a halt here is a card
  // that did not move; `outcome="proceeded"` is the denominator. Owned by
  // lib/andon-halt-metrics.ts. ⚠️ This one DOES change an outcome — the brake is
  // fail-closed, so an fr blip halts dispatch fleet-wide — which is exactly why
  // the series exists and why it must be alerted on.
  lines.push(...renderAndonHaltMetrics());

  // fr#1195 — the CHOKEPOINT BRAKE's own health, and the only andon series whose
  // events fr cannot observe for itself. The brake lives in n8n, consults
  // `GET /api/internal/andon` and fails CLOSED after a grace window, so a cord it
  // cannot READ halts the fleet with nobody having chosen that. A read that never
  // arrived leaves no trace in any series above — those all count answers fr GAVE
  // — so the caller REPORTS it (`POST /api/internal/andon/read-failure`) and these
  // three series are what an alert can be written against.
  //
  // ⛔ ADDITIVE ONLY. None of these is `fr_andon_engaged`, which keeps meaning
  // exactly "is the cord pulled" (0 or 1, no third value, no new label) because
  // two live Prometheus rules consume it and one GATES another alert on `== 1`.
  // See the section header in lib/andon-halt-metrics.ts.
  lines.push(...renderAndonProbeMetrics());

  // Board/card tenant-gate refusals — the counter that makes #1136's narrowed
  // write boundary observable. Every refusal there exits as a bare 404 with no
  // log line, so a human whose legitimate workflow the narrowing broke is
  // otherwise a non-event. `reason="internal_board_write"` is the population
  // the PR NEWLY refuses; the other reasons refused identically before it.
  // Owned by lib/board-tenant-gate-metrics.ts. It changes no refusal outcome;
  // it makes the existing ones visible.
  lines.push(...renderBoardTenantGateRefusalMetrics());

  // Kanban WebSocket refusals (fr row 14d-0b) — upgrades with no resolvable
  // tenant and kanban subscribes from non-platform sessions. Owned by
  // lib/kanban-ws-refusal-metrics.ts.
  lines.push(...renderKanbanWsRefusalMetrics());
  // Approvals WebSocket refusals (fr row 14d-0b) — owned by
  // lib/approvals-ws-refusal-metrics.ts.
  lines.push(...renderApprovalsWsRefusalMetrics());
  // Proposal scoring — whether a conveyor's proposed answer was judged actionable
  // before a person saw it, and how often the judge could not answer at all (a
  // silent laya outage must not look like a run of passes). Owned by
  // lib/proposal-score-metrics.ts.
  lines.push(...renderProposalScoreMetrics());

  // Approval answerability — whether the row fr was about to mint could ever
  // have been discharged by a human. ⭐ Unlike its three siblings above, this
  // one counts a gate that is NOT yet changing any outcome: it ships in observe
  // mode (`FR_APPROVAL_ANSWERABILITY_MODE`, default `observe`) and refuses
  // nothing until the flag flips. Until then this counter IS the deliverable —
  // it is the only thing that can say whether `enforce` can be turned on
  // without stopping the conveyor. `outcome="clean"` is the denominator,
  // `outcome="resolved"` is the gate deriving a value fr already held rather
  // than refusing, and `outcome="observed"` is the live defect rate.
  // Owned by lib/approval-answerability-metrics.ts.
  lines.push(...renderAnswerabilityMetrics());

  // U3 R5 — decided coverage sign-offs whose ac_coverage rows never reached the sink
  // (> 6 h after the decision), by reason. Sampled by workers/ac-coverage-redelivery.ts;
  // owned by lib/ac-coverage-stuck-metrics.ts. Any value > 0 is a missing coverage record.
  lines.push(...renderAcCoverageStuckMetrics());

  // Project-ownership emit outcomes — how many outbound billing-relevant
  // calls carried a validated project id, and why the rest didn't. Owned by
  // lib/project-owner-guard.ts + lib/project-id-emit-metrics.ts.
  lines.push(...renderProjectIdEmitMetrics());

  // X-Active-Tenant header decisions (fr 14d-0) — how often each caller class
  // sends the workspace-switch header and what buildRequestContext decided.
  // Owned by lib/active-tenant-header-metrics.ts. It changes no resolved
  // tenant; it makes the silent fall-back to the home tenant visible.
  lines.push(...renderActiveTenantHeaderMetrics());
  // George 2026-10-27: every super_admin switched request, by surface and read/write
  // (the log line dedupes reads). Owned by lib/super-admin-tenant-audit.ts.
  lines.push(...renderSuperAdminSwitchMetrics());
  // fr#1437 (5): who owns the card an asset-authoring publish acts for, by
  // caller kind. Owned by lib/asset-authoring-card-owner.ts.
  lines.push(...renderAssetAuthoringCardOwnerMetrics());
  // fr#1448: a non-human platform identity whose tenant came from its own sub
  // (observe only). Owned by lib/sa-tenant-from-sub.ts.
  lines.push(...renderSaTenantFromSubMetrics());
  lines.push(...renderCardApprovalTenantCheckMetrics());
  lines.push(...renderWsPublishDroppedMetrics());

  return lines.join('\n') + '\n';
}

/**
 * GET /api/metrics/prom — unauthenticated Prom text-exposition endpoint.
 * Mounted directly from server.ts to avoid the auth-router pipeline; this
 * handler is exported for unit tests.
 */
export function handlePromMetrics(): Response {
  return new Response(renderPromExporter(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; version=0.0.4',
    },
  });
}
