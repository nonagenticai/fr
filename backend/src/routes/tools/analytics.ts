/**
 * Analytics tool routes — Wave 3 slice.
 * Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §8.3.
 *
 * Three read-only endpoints — every one is also an AG-UI action so an agent
 * can answer "how did we do this week?" without switching surface (spec §7).
 *
 * - GET  /api/tools/analytics/summary    → analytics.summary
 * - GET  /api/tools/analytics/breakdown  → analytics.breakdown
 * - GET  /api/tools/analytics/export.csv → analytics.export
 *
 * Handler shape mirrors `tools/kag.ts`:
 *   1. validateAuth (401 on anonymous, project-membership check on project_id)
 *   2. zod-validate query params
 *   3. invokeAction(...) — registry wraps in emitSpan + idempotency
 *   4. Stable envelope `{ data, meta }` (or `text/csv` stream for export)
 *
 * Data source: the `analytics_rollups` table. Routes never touch Prometheus.
 */

import { z } from 'zod';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import {
  ctxTenantId,
  tryGetRequestContext,
} from '../../middleware/request-context';
import { invokeAction, registerAction } from '../../agui/registry';
import type {
  AgentCallableAction,
  ActionContext,
} from '../../agui/types';
import { db as defaultDb } from '../../db/client';
import {
  analyticsRollups,
  analyticsRollupMeta,
  approvals,
  notificationLog,
} from '../../db/schema';
import {
  IntegrationError,
} from '../../integrations/_lib/errors';
import { ForbiddenError } from '../../utils/errors';
import { withIntegrationCatch } from '../_lib';
import { parseSearchParams } from '../_lib';
import {
  breakdownInput,
  breakdownOutput,
  exportInput,
  exportOutput,
  perChannelInput,
  perChannelOutput,
  summaryInput,
  summaryOutput,
  type BreakdownInput,
  type Dimension,
  type ExportInput,
  type PerChannelInput,
  type SummaryInput,
  type Window,
} from './analytics-schemas';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const WINDOW_SECONDS: Record<Window, number> = {
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '90d': 7_776_000,
};

const SUMMARY_ROW_CAP = 200;
const BREAKDOWN_ROW_CAP = 1_000;
const EXPORT_ROW_CAP = 50_000;

interface AuthedUser {
  id: string;
  tenantId: string;
}

function buildCtx(user: AuthedUser): ActionContext {
  const rc = tryGetRequestContext();
  return {
    userId: user.id,
    projectId: null,
    correlationId: rc?.correlationId ?? crypto.randomUUID(),
    initiator: rc?.initiator ?? 'human',
    channel: rc?.channel ?? 'web',
  };
}

function windowStartTs(window: Window): Date {
  return new Date(Date.now() - WINDOW_SECONDS[window] * 1000);
}

/**
 * Spec §6.6 — page surfaces last-tick timestamp + amber 'stale' badge.
 * "Stale" = older than two tick intervals (10 min default).
 */
function isStale(lastSuccess: Date | null): boolean {
  if (!lastSuccess) return true;
  const ageMs = Date.now() - lastSuccess.getTime();
  return ageMs > 10 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Handlers — pure functions over the DB. Reused by the action handlers and
// (via invokeAction) by the HTTP routes.
// ---------------------------------------------------------------------------

interface SparkBucket {
  bucket_ts: Date;
  metric_name: string;
  value: number;
}

async function loadRollupRows(
  db: typeof defaultDb,
  user: AuthedUser,
  input: { window: Window; project_id?: string; initiator?: string; channel?: string },
  rowCap: number,
): Promise<SparkBucket[]> {
  const start = windowStartTs(input.window);
  const conditions = [
    eq(analyticsRollups.tenant_id, ctxTenantId(user.tenantId)),
    gte(analyticsRollups.bucket_ts, start),
  ];
  if (input.project_id) {
    conditions.push(eq(analyticsRollups.project_id, input.project_id));
  } else {
    // When no project is requested, surface tenant-wide rollups (project_id
    // NULL = aggregate-over-projects rows produced by the worker, plus any
    // per-project rows when present).
    conditions.push(isNull(analyticsRollups.project_id));
  }
  if (input.initiator) {
    conditions.push(eq(analyticsRollups.initiator, input.initiator));
  }
  if (input.channel) {
    conditions.push(eq(analyticsRollups.channel, input.channel));
  }
  const rows = await db
    .select({
      bucket_ts: analyticsRollups.bucket_ts,
      metric_name: analyticsRollups.metric_name,
      value: analyticsRollups.value,
    })
    .from(analyticsRollups)
    .where(and(...conditions))
    .limit(rowCap + 1);

  if (rows.length > rowCap) {
    throw new IntegrationError({
      // These four cap guards carried `upstreamStatus: 413`. It never became the
      // HTTP STATUS — `httpStatusFor` honours `upstreamStatus` only under
      // `UPSTREAM_BAD_STATUS`, so this returned a hard 502. It did still reach
      // the wire, as `upstream.status` inside the body (`errors.ts:303-306`),
      // where no consumer reads it. So: an author's intent visible in the
      // payload and contradicted by the status line. 413 was the wrong intent —
      // the RESULT SET is too large, not the request — and the message already
      // tells the caller what to change, which is what makes this a 400.
      code: 'BAD_REQUEST',
      message: `analytics result exceeded cap (${rowCap}); narrow window or filters`,
    });
  }
  return rows.map((r) => ({
    bucket_ts: r.bucket_ts as Date,
    metric_name: r.metric_name as string,
    value: Number(r.value),
  }));
}

async function loadMeta(db: typeof defaultDb): Promise<{ last_success: Date | null; outcome: string | null }> {
  // We surface the 5m tick because that's the page-facing cadence. If we add
  // hourly/daily backfill later, surface whichever is freshest.
  const rows = await db
    .select({
      last_success: analyticsRollupMeta.last_success,
      last_outcome: analyticsRollupMeta.last_outcome,
    })
    .from(analyticsRollupMeta)
    .where(eq(analyticsRollupMeta.tick_name, 'prom-5m'))
    .limit(1);
  if (rows.length === 0) return { last_success: null, outcome: null };
  const r = rows[0]!;
  return {
    last_success: (r.last_success as Date | null) ?? null,
    outcome: (r.last_outcome as string | null) ?? null,
  };
}

interface SummaryKpi {
  metric: string;
  value: number;
  sparkline: number[];
}

interface SummaryEnvelope {
  data: {
    window: Window;
    project_id: string | null;
    kpis: SummaryKpi[];
    /** Plan-4 Lane B: prior-window KPIs when `?compare=prev`. Same metric set, same sort. */
    previous?: { kpis: SummaryKpi[] } | null;
  };
  meta: { last_tick_ts: string | null; stale: boolean; last_outcome: string | null };
}

function aggregateRollupRows(rows: SparkBucket[]): SummaryKpi[] {
  const byMetric = new Map<string, { total: number; spark: { ts: number; v: number }[] }>();
  for (const r of rows) {
    let acc = byMetric.get(r.metric_name);
    if (!acc) {
      acc = { total: 0, spark: [] };
      byMetric.set(r.metric_name, acc);
    }
    acc.total += r.value;
    acc.spark.push({ ts: r.bucket_ts.getTime(), v: r.value });
  }
  return Array.from(byMetric.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([metric, { total, spark }]) => ({
      metric,
      value: total,
      sparkline: spark.sort((a, b) => a.ts - b.ts).map((p) => p.v),
    }));
}

/**
 * Plan-4 Lane B: load rollup rows from the prior window of equal length.
 * For window=7d this returns the 7 days *before* the current 7-day window.
 */
async function loadPriorRollupRows(
  db: typeof defaultDb,
  user: AuthedUser,
  input: { window: Window; project_id?: string; initiator?: string; channel?: string },
  rowCap: number,
): Promise<SparkBucket[]> {
  const now = Date.now();
  const winSec = WINDOW_SECONDS[input.window] * 1000;
  const start = new Date(now - 2 * winSec);
  const end = new Date(now - winSec);
  const conditions = [
    eq(analyticsRollups.tenant_id, ctxTenantId(user.tenantId)),
    gte(analyticsRollups.bucket_ts, start),
    lt(analyticsRollups.bucket_ts, end),
  ];
  if (input.project_id) {
    conditions.push(eq(analyticsRollups.project_id, input.project_id));
  } else {
    conditions.push(isNull(analyticsRollups.project_id));
  }
  if (input.initiator) conditions.push(eq(analyticsRollups.initiator, input.initiator));
  if (input.channel) conditions.push(eq(analyticsRollups.channel, input.channel));
  const rows = await db
    .select({
      bucket_ts: analyticsRollups.bucket_ts,
      metric_name: analyticsRollups.metric_name,
      value: analyticsRollups.value,
    })
    .from(analyticsRollups)
    .where(and(...conditions))
    .limit(rowCap + 1);
  if (rows.length > rowCap) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `analytics prior-window result exceeded cap (${rowCap})`,
    });
  }
  return rows.map((r) => ({
    bucket_ts: r.bucket_ts as Date,
    metric_name: r.metric_name as string,
    value: Number(r.value),
  }));
}

export async function summaryFromDb(
  db: typeof defaultDb,
  user: AuthedUser,
  input: SummaryInput,
): Promise<SummaryEnvelope> {
  const rows = await loadRollupRows(db, user, input, SUMMARY_ROW_CAP);
  const kpis = aggregateRollupRows(rows);
  const meta = await loadMeta(db);

  let previous: { kpis: SummaryKpi[] } | null = null;
  if (input.compare === 'prev') {
    const priorRows = await loadPriorRollupRows(db, user, input, SUMMARY_ROW_CAP);
    previous = { kpis: aggregateRollupRows(priorRows) };
  }

  return {
    data: {
      window: input.window,
      project_id: input.project_id ?? null,
      kpis,
      previous,
    },
    meta: {
      last_tick_ts: meta.last_success?.toISOString() ?? null,
      stale: isStale(meta.last_success),
      last_outcome: meta.outcome,
    },
  };
}

interface BreakdownBucket {
  key: string;
  value: number;
  /** Total LLM tokens (input + output) attributed to this bucket. Null when
   * no `metric_name='tokens'` rollup rows exist for the dimension cell. */
  tokens: number | null;
  /** USD cost attributed to this bucket. Null when no `metric_name='cost_usd'`
   * rollup rows exist. */
  cost_usd: number | null;
}

interface BreakdownEnvelope {
  data: {
    dimension: Dimension;
    metric: string;
    buckets: BreakdownBucket[];
    previous?: { buckets: BreakdownBucket[] } | null;
  };
  meta: { row_count: number };
}

const DIMENSION_COLUMN: Record<Dimension, keyof typeof analyticsRollups> = {
  tool: 'metric_name',
  outcome: 'metric_name', // outcome encoded into the metric for v1 — full split lands when producer slices emit `outcome` as a Prom label
  project: 'project_id',
  initiator: 'initiator',
  channel: 'channel',
};

async function breakdownBuckets(
  db: typeof defaultDb,
  user: AuthedUser,
  input: BreakdownInput,
  range: { start: Date; end?: Date },
): Promise<BreakdownBucket[]> {
  const dimCol = DIMENSION_COLUMN[input.dimension];

  // Pivoted query — fetch the requested metric AND the cross-cutting
  // tokens / cost_usd metrics in one trip so each dimension key carries its
  // (requests, tokens, cost_usd) triple. Polymorphic schema (one row per
  // metric_name) means no schema change; we just include all three names in
  // the WHERE filter and pivot client-side.
  //
  // For dimensions OTHER than 'tool', tokens + cost_usd group by the same
  // dimension column, so each row's tokens/cost reflect that dimension cell.
  // For dimension='tool', tokens + cost_usd are tenant-wide (they are not
  // tagged by producer-service Prom counter), so the pivot at this layer
  // returns rows only for keys present in the requested metric — tokens and
  // cost_usd are treated as parallel rollups joined on the same cell.
  const targetMetrics = [input.metric, 'tokens', 'cost_usd'];
  const conds = [
    eq(analyticsRollups.tenant_id, ctxTenantId(user.tenantId)),
    gte(analyticsRollups.bucket_ts, range.start),
    sql`${analyticsRollups.metric_name} IN (${sql.join(
      targetMetrics.map((m) => sql`${m}`),
      sql`, `,
    )})`,
  ];
  if (range.end) conds.push(lt(analyticsRollups.bucket_ts, range.end));
  if (input.project_id) conds.push(eq(analyticsRollups.project_id, input.project_id));

  // Group by (dimension key, metric_name); pivot in JS afterwards. We cap
  // by BREAKDOWN_ROW_CAP * targetMetrics.length to retain the same per-
  // dimension-cell row budget.
  const rawRows = await db
    .select({
      key: sql<string>`COALESCE(${sql.identifier(dimCol)}::text, 'unknown')`,
      metric_name: analyticsRollups.metric_name,
      value: sql<string>`SUM(${analyticsRollups.value})::text`,
    })
    .from(analyticsRollups)
    .where(and(...conds))
    .groupBy(sql`1`, analyticsRollups.metric_name)
    .limit(BREAKDOWN_ROW_CAP * targetMetrics.length + 1);

  return pivotBreakdownRows(
    rawRows.map((r) => ({
      key: r.key as string,
      metric_name: r.metric_name as string,
      value: Number(r.value),
    })),
    input.metric,
    input.dimension,
  );
}

/**
 * Pure pivot — exported for unit tests. Takes the (key, metric_name, value)
 * triplets returned by the grouped-by-2 query and folds them into one
 * (key, value=requests, tokens, cost_usd) row per dimension key.
 *
 * Sorted by `value` descending so the highest-volume key is first (matches
 * the legacy single-metric ordering the FE expects).
 */
export function pivotBreakdownRows(
  rows: { key: string; metric_name: string; value: number }[],
  requestedMetric: string,
  dimension: Dimension,
): BreakdownBucket[] {
  const byKey = new Map<
    string,
    { value: number; tokens: number | null; cost_usd: number | null }
  >();
  for (const r of rows) {
    let cell = byKey.get(r.key);
    if (!cell) {
      cell = { value: 0, tokens: null, cost_usd: null };
      byKey.set(r.key, cell);
    }
    if (r.metric_name === requestedMetric) {
      cell.value = r.value;
    } else if (r.metric_name === 'tokens') {
      cell.tokens = r.value;
    } else if (r.metric_name === 'cost_usd') {
      cell.cost_usd = r.value;
    }
  }

  // For dimension='tool' the requested metric IS itself a tool name, so
  // 'tokens' / 'cost_usd' rows surface as their OWN tool keys. We strip
  // them from the result (the FE doesn't render meta-tools as drill-down
  // rows) and instead fold their totals onto every other key as the
  // cross-cutting tenant total. This matches the spec's drill-down columns
  // where each (date, service) row carries the period's tokens/cost.
  if (dimension === 'tool') {
    const tokensRow = byKey.get('tokens');
    const costRow = byKey.get('cost_usd');
    byKey.delete('tokens');
    byKey.delete('cost_usd');
    // For dimension=tool the meta-row's `tokens`/`cost_usd` ended up in its
    // OWN field (not `value`) because pivot keyed off metric_name.
    const tokensTotal = tokensRow?.tokens ?? null;
    const costTotal = costRow?.cost_usd ?? null;
    for (const cell of byKey.values()) {
      cell.tokens = tokensTotal;
      cell.cost_usd = costTotal;
    }
  }

  if (byKey.size > BREAKDOWN_ROW_CAP) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `breakdown exceeded cap (${BREAKDOWN_ROW_CAP})`,
    });
  }

  return Array.from(byKey.entries())
    .map(([key, cell]) => ({
      key,
      value: cell.value,
      tokens: cell.tokens,
      cost_usd: cell.cost_usd,
    }))
    .sort((a, b) => b.value - a.value);
}

export async function breakdownFromDb(
  db: typeof defaultDb,
  user: AuthedUser,
  input: BreakdownInput,
): Promise<BreakdownEnvelope> {
  const buckets = await breakdownBuckets(db, user, input, { start: windowStartTs(input.window) });

  let previous: { buckets: BreakdownBucket[] } | null = null;
  if (input.compare === 'prev') {
    const now = Date.now();
    const winSec = WINDOW_SECONDS[input.window] * 1000;
    const priorBuckets = await breakdownBuckets(db, user, input, {
      start: new Date(now - 2 * winSec),
      end: new Date(now - winSec),
    });
    previous = { buckets: priorBuckets };
  }

  return {
    data: { dimension: input.dimension, metric: input.metric, buckets, previous },
    meta: { row_count: buckets.length },
  };
}

// ---------------------------------------------------------------------------
// Plan-4 Lane B — per-channel notification send volumes
// ---------------------------------------------------------------------------

interface PerChannelEnvelope {
  data: { channels: { kind: string; sends: number }[] };
  meta: { window: Window; row_count: number };
}

export async function perChannelFromDb(
  db: typeof defaultDb,
  user: AuthedUser,
  input: PerChannelInput,
): Promise<PerChannelEnvelope> {
  const start = windowStartTs(input.window);
  // Sends = rows whose status reached 'sent' or 'delivered' within window.
  //
  // ⛔ TENANT-SCOPED through the approval. `notification_log` has no tenant
  // column; every row hangs off `approval_id` (NOT NULL FK), and the approval
  // carries the tenant. This query used to have NO tenant predicate at all, so
  // every workspace's "per-channel sends" chart counted every OTHER workspace's
  // notifications too.
  const rows = await db
    .select({
      kind: notificationLog.channel,
      sends: sql<string>`COUNT(*)::text`,
    })
    .from(notificationLog)
    .innerJoin(approvals, eq(approvals.id, notificationLog.approval_id))
    .where(
      and(
        eq(approvals.tenant_id, ctxTenantId(user.tenantId)),
        gte(notificationLog.created_at, start),
        sql`${notificationLog.status} IN ('sent', 'delivered')`,
      ),
    )
    .groupBy(notificationLog.channel)
    .orderBy(sql`2 DESC`);

  const channels = rows.map((r) => ({
    kind: r.kind as string,
    sends: Number(r.sends),
  }));
  return {
    data: { channels },
    meta: { window: input.window, row_count: channels.length },
  };
}

interface ExportEnvelope {
  data: {
    rows: {
      bucket_ts: string;
      metric_name: string;
      initiator: string;
      channel: string;
      project_id: string | null;
      value: number;
    }[];
  };
  meta: { row_count: number };
}

export async function exportFromDb(
  db: typeof defaultDb,
  user: AuthedUser,
  input: ExportInput,
): Promise<ExportEnvelope> {
  const start = windowStartTs(input.window);
  const conds = [
    eq(analyticsRollups.tenant_id, ctxTenantId(user.tenantId)),
    gte(analyticsRollups.bucket_ts, start),
  ];
  if (input.project_id) {
    conds.push(eq(analyticsRollups.project_id, input.project_id));
  }
  const rawRows = await db
    .select({
      bucket_ts: analyticsRollups.bucket_ts,
      metric_name: analyticsRollups.metric_name,
      initiator: analyticsRollups.initiator,
      channel: analyticsRollups.channel,
      project_id: analyticsRollups.project_id,
      value: analyticsRollups.value,
    })
    .from(analyticsRollups)
    .where(and(...conds))
    .orderBy(analyticsRollups.bucket_ts)
    .limit(EXPORT_ROW_CAP + 1);

  if (rawRows.length > EXPORT_ROW_CAP) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `export exceeded cap (${EXPORT_ROW_CAP})`,
    });
  }
  return {
    data: {
      rows: rawRows.map((r) => ({
        bucket_ts: (r.bucket_ts as Date).toISOString(),
        metric_name: r.metric_name as string,
        initiator: r.initiator as string,
        channel: r.channel as string,
        project_id: (r.project_id as string | null) ?? null,
        value: Number(r.value),
      })),
    },
    meta: { row_count: rawRows.length },
  };
}

function rowsToCsv(env: ExportEnvelope): string {
  const header = ['bucket_ts', 'metric_name', 'initiator', 'channel', 'project_id', 'value'];
  const lines = [header.join(',')];
  for (const r of env.data.rows) {
    lines.push(
      [
        r.bucket_ts,
        csvEscape(r.metric_name),
        csvEscape(r.initiator),
        csvEscape(r.channel),
        r.project_id ?? '',
        String(r.value),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// ---------------------------------------------------------------------------
// AG-UI action definitions
// ---------------------------------------------------------------------------

const PUBLIC_RBAC = { type: 'public' as const };

// ---------------------------------------------------------------------------
// Incurred cost is super-admin only.
//
// The `cost_usd` metric is written by workers/analytics-rollup.ts from
// metering's `metering_cost_event_cost_usd_total` — INCURRED provider cost,
// pre-markup. These views are operations analytics, not a bill (the tenant's
// billed figures live on /settings/usage), so the figure is withheld from every
// caller whose VERIFIED identity is not a super-admin rather than re-derived as
// a billed number per bucket. Decided from the request frame's
// `callerIsSuperAdmin` (set from verified claims) so the same rule covers the
// HTTP routes, AG-UI agent tokens and cron — and it fails CLOSED: no frame, or a
// frame that never set the flag, sees no cost.
// ---------------------------------------------------------------------------
const INCURRED_COST_METRIC = 'cost_usd';

function callerSeesIncurredCost(): boolean {
  return tryGetRequestContext()?.callerIsSuperAdmin === true;
}

function withoutCostKpis(env: SummaryEnvelope): SummaryEnvelope {
  const keep = (kpis: SummaryKpi[]) => kpis.filter((k) => k.metric !== INCURRED_COST_METRIC);
  return {
    ...env,
    data: {
      ...env.data,
      kpis: keep(env.data.kpis),
      previous: env.data.previous ? { kpis: keep(env.data.previous.kpis) } : env.data.previous,
    },
  };
}

function withoutCostColumn(env: BreakdownEnvelope): BreakdownEnvelope {
  const strip = (buckets: BreakdownBucket[]) => buckets.map((b) => ({ ...b, cost_usd: null }));
  return {
    ...env,
    data: {
      ...env.data,
      buckets: strip(env.data.buckets),
      previous: env.data.previous ? { buckets: strip(env.data.previous.buckets) } : env.data.previous,
    },
  };
}

function withoutCostRows(env: ExportEnvelope): ExportEnvelope {
  const rows = env.data.rows.filter((r) => r.metric_name !== INCURRED_COST_METRIC);
  return { data: { rows }, meta: { ...env.meta, row_count: rows.length } };
}

export function actionUserFromCtx(ctx: ActionContext): AuthedUser {
  // `tenantId` used to be `ctx.userId` — a USER uuid in a TENANT field, left as
  // a placeholder "until E-13 propagates tenant". E-13 landed: `ctx.tenantId` is
  // populated from the agent token's `tenant_id` claim (migration 097, see
  // routes/agui.ts), and on the channel path from `getUserTenant`.
  //
  // The placeholder was not merely imprecise, it was load-bearing:
  // `summaryFromDb` and `exportFromDb` filter
  // `eq(analyticsRollups.tenant_id, ctxTenantId(user.tenantId))`, and no
  // rollup row's tenant_id can ever equal a user uuid. Every call returned
  // zero rows — a silent empty, indistinguishable from "no data yet".
  // Measured live 2026-08-27: `analytics.summary` -> `{kpis: []}`,
  // `analytics.export` -> `{rows: [], row_count: 0}`.
  //
  // Empty string when the context carries no tenant is deliberate: it makes
  // `ctxTenantId` throw "tenantId not resolvable" instead of accepting a
  // fallback. An unaffiliated caller is refused rather than silently
  // mis-scoped — the same posture routes/tools/kag.ts buildCtx already takes.
  return {
    id: ctx.userId,
    tenantId: process.env.AUTH_BYPASS === 'true'
      ? '00000000-0000-0000-0000-000000000000'
      : (ctx.tenantId ?? ''),
  };
}

const summaryAction: AgentCallableAction<SummaryInput, unknown> = {
  name: 'analytics.summary',
  kind: 'read',
  description:
    'Return KPI rollups + sparklines for the current user (or a project if scoped) over a time window. Read-only, auto-approved.',
  input: summaryInput,
  output: summaryOutput,
  approval: { type: 'auto' },
  cronSafe: true,
  // 60-second bucket so polling clients dedupe; window changes split the key.
  idempotencyKey: (input) =>
    `analytics.summary:${input.project_id ?? ''}:${input.window}:${input.initiator ?? ''}:${input.channel ?? ''}:${Math.floor(Date.now() / 60_000)}`,
  handler: async (input, ctx) => {
    const user = actionUserFromCtx(ctx);
    const env = await summaryFromDb(defaultDb, user, input);
    return callerSeesIncurredCost() ? env : withoutCostKpis(env);
  },
};

const breakdownAction: AgentCallableAction<BreakdownInput, unknown> = {
  name: 'analytics.breakdown',
  kind: 'read',
  description:
    'Return value-by-dimension buckets for one metric over a window (e.g. "cards committed by initiator").',
  input: breakdownInput,
  output: breakdownOutput,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `analytics.breakdown:${input.project_id ?? ''}:${input.window}:${input.dimension}:${input.metric}:${Math.floor(Date.now() / 60_000)}`,
  handler: async (input, ctx) => {
    const user = actionUserFromCtx(ctx);
    const seesCost = callerSeesIncurredCost();
    if (!seesCost && input.metric === INCURRED_COST_METRIC) {
      throw new ForbiddenError('the cost_usd metric is restricted to platform operators');
    }
    const env = await breakdownFromDb(defaultDb, user, input);
    return seesCost ? env : withoutCostColumn(env);
  },
};

const perChannelAction: AgentCallableAction<PerChannelInput, unknown> = {
  name: 'analytics.per_channel',
  kind: 'read',
  description:
    'Return per-channel notification send counts (teams/email/web/inapp/voice) for a window. Read-only, auto-approved.',
  input: perChannelInput,
  output: perChannelOutput,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `analytics.per_channel:${input.project_id ?? ''}:${input.window}:${Math.floor(Date.now() / 60_000)}`,
  handler: async (input, ctx) => {
    const user = actionUserFromCtx(ctx);
    return await perChannelFromDb(defaultDb, user, input);
  },
};

const exportAction: AgentCallableAction<ExportInput, unknown> = {
  name: 'analytics.export',
  kind: 'read',
  description:
    'Return raw rollup rows for the current view. The HTTP route streams CSV; AG-UI returns the same rows as JSON for narration.',
  input: exportInput,
  output: exportOutput,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `analytics.export:${input.project_id ?? ''}:${input.window}:${(input.dimensions ?? []).join('+')}:${Math.floor(Date.now() / 60_000)}`,
  handler: async (input, ctx) => {
    const user = actionUserFromCtx(ctx);
    const env = await exportFromDb(defaultDb, user, input);
    return callerSeesIncurredCost() ? env : withoutCostRows(env);
  },
};

const ALL_ACTIONS: AgentCallableAction<unknown, unknown>[] = [
  summaryAction as AgentCallableAction<unknown, unknown>,
  breakdownAction as AgentCallableAction<unknown, unknown>,
  exportAction as AgentCallableAction<unknown, unknown>,
  perChannelAction as AgentCallableAction<unknown, unknown>,
];

for (const a of ALL_ACTIONS) {
  (a as { rbac?: typeof PUBLIC_RBAC }).rbac = PUBLIC_RBAC;
}

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

for (const a of ALL_ACTIONS) safeRegister(a);

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------


/**
 * Local adapter over the shared core: `dimensions` arrives comma-separated on
 * the wire and the schemas here expect an array. Naming it at the one call
 * boundary keeps the shared helper free of this file's vocabulary.
 */
function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  return parseSearchParams(schema, req, { listParams: ['dimensions'] });
}

export async function handleSummary(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const input = parseQuery(summaryInput, req);
    const ctx = buildCtx(user);
    const result = await invokeAction('analytics.summary', input, ctx);
    return jsonResponse(result);
  });
}

export async function handleBreakdown(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const input = parseQuery(breakdownInput, req);
    const ctx = buildCtx(user);
    const result = await invokeAction('analytics.breakdown', input, ctx);
    return jsonResponse(result);
  });
}

export async function handlePerChannel(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const input = parseQuery(perChannelInput, req);
    const ctx = buildCtx(user);
    const result = await invokeAction('analytics.per_channel', input, ctx);
    return jsonResponse(result);
  });
}

export async function handleExportCsv(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const input = parseQuery(exportInput, req);
    const ctx = buildCtx(user);
    const env = (await invokeAction('analytics.export', input, ctx)) as ExportEnvelope;
    const csv = rowsToCsv(env);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="analytics-${input.window}.csv"`,
      },
    });
  });
}
