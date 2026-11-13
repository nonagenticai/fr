/**
 * Analytics rollup worker — Wave 3 slice §8.2.
 *
 * Periodic worker that queries Prometheus for the metrics enumerated in spec
 * §10 and upserts (tenant, project, user, bucket, metric, initiator, channel)
 * rows into `analytics_rollups`. Routes under `/api/tools/analytics/*` read
 * from this table only; they never touch Prometheus directly.
 *
 * Cadence: every `ANALYTICS_ROLLUP_INTERVAL_MS` (default 300_000ms = 5 min)
 * per spec §6.6. Bucket size for the in-cluster path is `5m`.
 *
 * Concurrency:
 *   - Multi-replica safety via a Postgres *transaction-scoped* advisory lock
 *     (`pg_try_advisory_xact_lock(ADVISORY_LOCK_KEY)`). Only one replica's
 *     tick writes; the rest no-op the slot (outcome=`skipped`). The lock is
 *     taken and released within a single transaction, so it can never ride
 *     back into the pgbouncer (transaction-mode) server pool as a leaked
 *     session lock — the failure mode that previously poisoned both fr and
 *     kag_frontend backends. Do NOT switch this to `pg_try_advisory_lock`
 *     (session-scoped): postgres.js hands a different pooled connection per
 *     statement, so a later `pg_advisory_unlock` lands on a different backend,
 *     returns false without raising, and the lock leaks forever.
 *   - In-process re-entrancy guard (`tickInFlight`) so a slow tick does not
 *     stack up if the timer fires again.
 *
 * Error policy:
 *   - Per-metric isolation: a single failing PromQL query is logged + counted
 *     as `prom_queries` but does not abort the whole tick; the meta row is
 *     written with outcome=`partial`. Per-upsert isolation is preserved via a
 *     SAVEPOINT around each row so one bad row cannot abort the whole write
 *     transaction. A contended tick (lock held by another writer) is
 *     outcome=`skipped` and writes NO meta row (the holder records it). A full
 *     failure (DB unreachable) → outcome=`failed`.
 *   - Spec §11 telemetry: emits a `fr.analytics.rollup.tick` span. ⚠️ That span
 *     carries ONLY `bucket_ts`, `bucket_size` and `outcome` — `emitSpan` takes
 *     its attributes up front and snapshots them before the body runs, so the
 *     per-tick COUNTS cannot ride on it. (This comment used to claim the span
 *     carried metrics_written + prom_queries + unknown_initiator_rows; it never
 *     has. Verified against the emitted log line.) The counts go to the
 *     `analytics_rollup_meta` row and the stdout summary line instead.
 *
 * Spec §6.5 — when a metric series lacks initiator/channel labels we record
 * the row with `initiator='unknown'` / `channel='unknown'` and increment the
 * unknown-initiator counter so the drift is visible.
 *
 * Zero-write accounting (issue #1027 — migration 115):
 *   `metrics_written = 0` on its own is ambiguous, and that ambiguity is why a
 *   worker that had NEVER written a row read `ok` for its entire life. Four
 *   counters split it, all persisted to `analytics_rollup_meta`:
 *
 *     prom_series             series Prometheus actually returned
 *     rows_dropped_no_tenant  samples refused for a missing tenant_id  (DROP)
 *     rows_dropped_bad_value  samples refused for a non-finite value   (DROP)
 *     unknown_initiator_rows  rows WRITTEN with initiator='unknown'    (not a drop)
 *
 *   `prom_series === 0` is the benign, documented case: the upstream slice has
 *   not landed, there is nothing to write, and `ok` is the honest outcome (see
 *   the DEFAULT_METRIC_MAP note below). `prom_series > 0` with
 *   `metricsWritten === 0` is the opposite reading — data arrived and this
 *   worker discarded every sample — and the two drop counters name which path
 *   discarded it.
 */

import { eq, sql, type SQL } from 'drizzle-orm';

import { LOCK_KEYS } from '../db/advisory-lock-keys';
import { db as defaultDb } from '../db/client';
import { analyticsRollupMeta } from '../db/schema';
import { emitSpan } from '../telemetry/spans';
import { getPrometheusClient, type PromInstantValue } from '../services/prometheus-client';

// Advisory-lock key. Registered in src/db/advisory-lock-keys.ts — the only
// place one may be declared. Do not restate the keyspace here.
const ADVISORY_LOCK_KEY = LOCK_KEYS.analyticsRollup;
const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_BUCKET_SIZE = '5m';

export type RolloupTickOutcome = 'ok' | 'partial' | 'failed' | 'skipped';

export interface AnalyticsMetricMap {
  /** Public metric name persisted into `analytics_rollups.metric_name`. */
  metric: string;
  /**
   * PromQL expression. Convention from spec §8.2:
   *   sum by (tenant_id, project_id, user_id, initiator, channel) (
   *     rate({span}_total[5m])
   *   ) * 300
   */
  promql: (bucketSeconds: number) => string;
}

/**
 * Spec §10 — KPI map. Every entry corresponds to a Wave-1/2 producer span
 * that emits `_total` Prom counters tagged with the canonical attribute set.
 * The PromQL pattern multiplies a `rate()` by the bucket width to recover an
 * absolute count for the bucket — idempotent under a re-tick because the
 * upsert key includes (bucket_ts, metric_name, …).
 *
 * NOTE: a producing slice that is not yet emitting `_total` counters will
 * simply yield zero rows here and the dependent KPI card will degrade to
 * "—" in the UI per spec §9.5 ("Zero-data in window"). That degradation is
 * the intended signal that the upstream slice has not landed.
 */
export const DEFAULT_METRIC_MAP: AnalyticsMetricMap[] = [
  // KAG ingests
  {
    metric: 'kag.ingests.upload',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(kag_ingest_upload_total[5m])) * ${sec}`,
  },
  {
    metric: 'kag.ingests.scrape_url',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(kag_ingest_scrape_url_total[5m])) * ${sec}`,
  },
  {
    metric: 'kag.ingests.scrape_sitemap',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(kag_ingest_scrape_sitemap_total[5m])) * ${sec}`,
  },
  // Coding analyses
  {
    metric: 'coding.analyses.triggered',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(fr_tool_coding_trigger_total[5m])) * ${sec}`,
  },
  {
    metric: 'coding.analyses.completed',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(fr_tool_coding_complete_total[5m])) * ${sec}`,
  },
  // Bridge — cards committed from findings
  {
    metric: 'bridge.cards.committed',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(fr_bridge_card_committed_total[5m])) * ${sec}`,
  },
  // Artifacts
  {
    metric: 'artifacts.downloads.resolved',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) (rate(artifacts_download_resolve_total[5m])) * ${sec}`,
  },
  // -----------------------------------------------------------------------
  // Tokens + cost (Foundation Plan 4 Lane B follow-up).
  //
  // Source: metering-service exports per-cost-event Prom counters tagged
  // with the canonical attribute set (tenant_id / project_id / user_id /
  // initiator / channel). When metering-service has not landed those
  // counters yet, the per-metric isolation in `runRollupTick` makes these
  // queries a no-op (zero rows, no errors), and the drill-down columns
  // gracefully degrade to "—" in the UI.
  //
  // Cross-repo dependency: the upstream counter names below MUST match
  // what `nonagenticai/metering-service` exports. If the upstream chooses
  // different names, override via env or the metric-map override path.
  // The tokens metric sums input + output so the column reads "tokens
  // through the LLM" rather than splitting at the rollup tier — this
  // matches the (date, service, requests, tokens, cost) drill-down shape.
  {
    metric: 'tokens',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) ` +
      `(rate(metering_cost_event_input_tokens_total[5m]) + ` +
      `rate(metering_cost_event_output_tokens_total[5m])) * ${sec}`,
  },
  {
    metric: 'cost_usd',
    promql: (sec) =>
      `sum by (tenant_id, project_id, user_id, initiator, channel) ` +
      `(rate(metering_cost_event_cost_usd_total[5m])) * ${sec}`,
  },
];

export interface RollupTickOptions {
  /**
   * Bucket start (unix seconds). Default = the most recent CLOSED bucket,
   * `bucketStart(now) - bucketSeconds` (see {@link closedBucketTs}). The bucket
   * is evaluated at its END, `bucketTs + bucketSeconds`.
   */
  bucketTs?: number;
}

export interface RollupTickResult {
  outcome: RolloupTickOutcome;
  metricsWritten: number;
  /** PromQL queries ISSUED — not series returned. See `promSeries`. */
  promQueries: number;
  /**
   * Series Prometheus actually RETURNED, summed over the queries that
   * succeeded. This is the number that splits a zero-write tick in two:
   * `promSeries === 0` is the documented "upstream slice has not landed"
   * signal (see the DEFAULT_METRIC_MAP note above); `promSeries > 0` with
   * `metricsWritten === 0` means data arrived and this worker discarded all of
   * it, which is a defect. Before migration 115 the persisted meta row could
   * not tell those apart (issue #1027).
   */
  promSeries: number;
  /** Samples refused for a missing `tenant_id` (spec §6.2). DROPPED. */
  droppedNoTenant: number;
  /** Samples refused for a non-finite `value`. DROPPED. */
  droppedBadValue: number;
  /**
   * Rows WRITTEN carrying `initiator='unknown'` (the series had no initiator
   * label). A degradation counter over written rows — these are already
   * counted in `metricsWritten`, so this is NOT a drop counter and must never
   * be summed with the two above.
   *
   * Until #1027 the missing-`tenant_id` DROP also incremented this field, so a
   * single number meant both "we wrote a row with a poor label" and "we
   * refused to write a row at all" — the same conflation, one level down from
   * the meta table.
   */
  unknownInitiatorRows: number;
  acquiredLock: boolean;
  errors: string[];
  bucketTs: number;
}

const BUCKET_SIZE_SECONDS: Record<string, number> = {
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
};

function bucketStart(nowMs: number, bucketSeconds: number): number {
  return Math.floor(nowMs / 1000 / bucketSeconds) * bucketSeconds;
}

/**
 * The most recent CLOSED bucket's start: `bucketStart(now) - bucketSeconds`.
 *
 * ⛔ Not `bucketStart(now)`. `rate(x[5m])` evaluated at instant T covers
 * (T-5m, T] — the bucket that ENDS at T. Labelling that value with the bucket
 * that STARTS at T (the old behaviour) shifted every row one bucket late, and
 * the current bucket is still open anyway.
 */
export function closedBucketTs(nowMs: number, bucketSeconds: number): number {
  return bucketStart(nowMs, bucketSeconds) - bucketSeconds;
}

/** The instant a bucket is evaluated at: its END (see {@link closedBucketTs}). */
export function bucketEvalTs(bucketTs: number, bucketSeconds: number): number {
  return bucketTs + bucketSeconds;
}

/** Most missed buckets one cycle will back-fill (12 × 5m = the last hour). */
export const MAX_CATCH_UP_BUCKETS = 12;

/**
 * The buckets one scheduler cycle rolls up, oldest first: every closed bucket
 * after the one the last successful tick covered, ending with the current
 * closed bucket — bounded to the newest `maxBuckets`.
 *
 * `lastSuccessMs` is the wall-clock time of the last successful tick
 * (`analytics_rollup_meta.last_success`); that tick covered
 * `closedBucketTs(lastSuccessMs)`. null (never succeeded) ⇒ just the current
 * closed bucket. Re-rolling a bucket is harmless (the write is an upsert).
 */
export function bucketsToRoll(
  nowMs: number,
  bucketSeconds: number,
  lastSuccessMs: number | null,
  maxBuckets: number = MAX_CATCH_UP_BUCKETS,
): number[] {
  const target = closedBucketTs(nowMs, bucketSeconds);
  if (lastSuccessMs === null || !Number.isFinite(lastSuccessMs)) return [target];
  const firstMissed = closedBucketTs(lastSuccessMs, bucketSeconds) + bucketSeconds;
  const from = Math.max(firstMissed, target - (Math.max(1, maxBuckets) - 1) * bucketSeconds);
  if (from > target) return [target];
  const out: number[] = [];
  for (let ts = from; ts <= target; ts += bucketSeconds) out.push(ts);
  return out;
}

function safeLabel(metric: Record<string, string>, key: string): string {
  const v = metric[key];
  if (v === undefined || v === null || v === '') return 'unknown';
  return v;
}

/**
 * Drive one rollup tick. Idempotent on re-run for the same `bucketTs` thanks
 * to the upsert (UNIQUE INDEX on the 9-tuple). Safe to call from outside the
 * scheduler (CronJob, manual-trigger script).
 */
export async function runRollupTick(
  opts: RollupTickOptions = {},
): Promise<RollupTickResult> {
  const metrics = DEFAULT_METRIC_MAP;
  const bucketSize = DEFAULT_BUCKET_SIZE;
  const bucketSeconds = BUCKET_SIZE_SECONDS[bucketSize];
  if (!bucketSeconds) {
    throw new Error(`unknown bucketSize: ${bucketSize}`);
  }
  const bucketTs = opts.bucketTs ?? closedBucketTs(Date.now(), bucketSeconds);
  const prom = getPrometheusClient();
  const db = defaultDb;

  const result: RollupTickResult = {
    outcome: 'ok',
    metricsWritten: 0,
    promQueries: 0,
    promSeries: 0,
    droppedNoTenant: 0,
    droppedBadValue: 0,
    unknownInitiatorRows: 0,
    acquiredLock: false,
    errors: [],
    bucketTs,
  };

  return await emitSpan('fr.analytics.rollup.tick', { bucket_ts: bucketTs, bucket_size: bucketSize }, async () => {
    // 1. Fetch every metric series FIRST — outside any transaction. Prometheus
    //    HTTP must never run while the write transaction (and its advisory
    //    lock) is open. One PromQL failure marks the tick `partial` but does
    //    not abort sibling metrics.
    const fetched: { metric: string; series: PromInstantValue[] }[] = [];
    for (const m of metrics) {
      result.promQueries += 1;
      try {
        const series = await prom.instantQuery(
          m.promql(bucketSeconds),
          bucketEvalTs(bucketTs, bucketSeconds),
        );
        // Counted HERE, at fetch time, not in the write loop: what Prometheus
        // returned is a fact about the upstream and must survive a write
        // transaction that later fails. A query that THREW contributes nothing
        // — it is already represented by `errors` + outcome='partial'.
        result.promSeries += series.length;
        fetched.push({ metric: m.metric, series });
      } catch (err) {
        result.outcome = 'partial';
        result.errors.push(`${m.metric}: ${errMessage(err)}`);
      }
    }

    // 2. Write rows under a TRANSACTION-scoped advisory lock. Taken and
    //    released within one transaction so it cannot leak into the pgbouncer
    //    server pool (see the header note). Per-row isolation via SAVEPOINT.
    try {
      await db.transaction(async (tx) => {
        const rows = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`,
        );
        const acquired =
          Array.isArray(rows) && rows.length > 0
            ? Boolean((rows[0] as { locked: boolean }).locked)
            : false;
        result.acquiredLock = acquired;
        if (!acquired) {
          // Another writer owns this bucket. Do NOT write and do NOT touch
          // the meta row — the holder records the tick truthfully.
          result.outcome = 'skipped';
          return;
        }
        // Each upsert runs in its own SAVEPOINT so a single failing row rolls
        // back only itself, keeping the outer transaction (and the xact lock)
        // alive for the remaining rows.
        await writeRollupRows(
          (stmt) => tx.transaction(async (sp) => { await sp.execute(stmt); }),
          fetched,
          bucketTs,
          bucketSize,
          result,
        );
      });
    } catch (err) {
      result.outcome = 'failed';
      result.errors.push(`write_txn: ${errMessage(err)}`);
    }

    // 3. Meta bookkeeping (autocommit, no lock). Skipped on a contended tick so
    //    we never clobber the winning writer's meta row with a false success.
    if (result.outcome !== 'skipped') {
      try {
        await writeRollupMeta(db, bucketSize, result);
      } catch (err) {
        // Meta write failure is logged but does not change outcome — the
        // rollup rows are already in.
        console.error('[analytics-rollup] meta upsert failed:', err);
      }
    }

    return result;
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one upsert statement. The caller supplies the execution context: on the
 * locked path it wraps the statement in a SAVEPOINT (so one failing row rolls
 * back only itself and the outer transaction — hence the xact lock — survives);
 * on the test/skip path it runs the statement directly (autocommit).
 */
type UpsertRunner = (stmt: SQL) => Promise<unknown>;

/** Upsert one bucket's worth of rows through the caller-supplied runner. */
async function writeRollupRows(
  runUpsert: UpsertRunner,
  fetched: { metric: string; series: PromInstantValue[] }[],
  bucketTs: number,
  bucketSize: string,
  result: RollupTickResult,
): Promise<void> {
  const bucketDate = new Date(bucketTs * 1000);
  for (const { metric, series } of fetched) {
    for (const sample of series) {
      const tenantId = sample.metric['tenant_id'];
      if (!tenantId) {
        // Spec §6.2 — refuse to insert metrics missing tenant_id. This is a
        // DROP: no row reaches `analytics_rollups`. It used to increment
        // `unknownInitiatorRows`, which conflated it with the very different
        // "row written, but with a degraded initiator label" case below.
        result.droppedNoTenant += 1;
        continue;
      }
      const projectIdStr = sample.metric['project_id'];
      const userIdStr = sample.metric['user_id'];
      const initiator = safeLabel(sample.metric, 'initiator');
      const channel = safeLabel(sample.metric, 'channel');
      if (initiator === 'unknown') {
        result.unknownInitiatorRows += 1;
      }

      const value = Number(sample.value[1]);
      if (!Number.isFinite(value)) {
        // Also a DROP — and until #1027 it was counted NOWHERE, in memory or
        // on disk. A tick that fetched 40 series and wrote none, all because
        // Prometheus returned `NaN`, was byte-identical in the meta table to a
        // tick that fetched nothing at all.
        result.droppedBadValue += 1;
        continue;
      }

      // Drizzle's onConflictDoUpdate target requires PgColumn refs; our unique
      // index uses COALESCE(...) on nullable columns, so we drop to raw SQL
      // with an inline ON CONFLICT (...) target.
      const stmt = sql`
        INSERT INTO analytics_rollups
          (tenant_id, project_id, user_id, bucket_ts, bucket_size,
           metric_name, initiator, channel, value, dimensions)
        VALUES
          (${tenantId},
           ${projectIdStr ?? null}::uuid,
           ${userIdStr ?? null}::uuid,
           ${bucketDate.toISOString()}::timestamptz,
           ${bucketSize},
           ${metric},
           ${initiator},
           ${channel},
           ${String(value)}::numeric,
           '{}'::jsonb)
        ON CONFLICT (
          tenant_id,
          COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(user_id,    '00000000-0000-0000-0000-000000000000'::uuid),
          bucket_ts, bucket_size, metric_name, initiator, channel, dimensions
        ) DO UPDATE SET value = EXCLUDED.value
      `;

      try {
        await runUpsert(stmt);
        result.metricsWritten += 1;
      } catch (err) {
        result.outcome = 'partial';
        result.errors.push(`${metric} upsert: ${errMessage(err)}`);
      }
    }
  }
}

/**
 * Migration-115 drop-accounting columns, written identically on INSERT and on
 * the conflict UPDATE. Factored out so the two branches cannot drift: an
 * ON CONFLICT set that omits a column leaves the PREVIOUS tick's value in
 * place, which reads as a fresh measurement and is worse than the NULL it
 * replaced.
 *
 * Every field is always a concrete integer — the columns are nullable only so
 * that ticks predating this instrumentation stay honestly NULL (see migration
 * 115). The worker itself never writes NULL.
 */
function metaCounters(result: RollupTickResult): {
  prom_series: number;
  rows_dropped_no_tenant: number;
  rows_dropped_bad_value: number;
  unknown_initiator_rows: number;
} {
  return {
    prom_series: result.promSeries,
    rows_dropped_no_tenant: result.droppedNoTenant,
    rows_dropped_bad_value: result.droppedBadValue,
    unknown_initiator_rows: result.unknownInitiatorRows,
  };
}

/** Write the one-row-per-tick bookkeeping row (autocommit, no advisory lock). */
async function writeRollupMeta(
  db: typeof defaultDb,
  bucketSize: string,
  result: RollupTickResult,
): Promise<void> {
  const tickName = `prom-${bucketSize}`;
  const succeeded = result.outcome !== 'failed';
  const lastError =
    result.errors.length > 0 ? result.errors.slice(0, 5).join(' | ') : null;
  await db
    .insert(analyticsRollupMeta)
    .values({
      tick_name: tickName,
      last_success: succeeded ? new Date() : null,
      last_outcome: result.outcome,
      last_error: lastError,
      metrics_written: result.metricsWritten,
      prom_queries: result.promQueries,
      ...metaCounters(result),
    })
    .onConflictDoUpdate({
      target: analyticsRollupMeta.tick_name,
      set: {
        last_success: succeeded
          ? new Date()
          : sql`${analyticsRollupMeta.last_success}`,
        last_outcome: result.outcome,
        last_error: lastError,
        metrics_written: result.metricsWritten,
        prom_queries: result.promQueries,
        ...metaCounters(result),
        updated_at: new Date(),
      },
    });
}

/**
 * One scheduler cycle: roll up every bucket `bucketsToRoll` names (the missed
 * ones since the last success, bounded, then the current closed bucket),
 * oldest first. Stops at the first tick that is not ok/partial — a `skipped`
 * tick means another replica holds the lock and is doing this work; a
 * `failed` one would fail the rest the same way.
 */
export async function runRollupCycle(): Promise<RollupTickResult[]> {
  const bucketSize = DEFAULT_BUCKET_SIZE;
  const bucketSeconds = BUCKET_SIZE_SECONDS[bucketSize];
  if (!bucketSeconds) throw new Error(`unknown bucketSize: ${bucketSize}`);
  const db = defaultDb;
  let lastSuccessMs: number | null = null;
  try {
    const [row] = await db
      .select({ last_success: analyticsRollupMeta.last_success })
      .from(analyticsRollupMeta)
      .where(eq(analyticsRollupMeta.tick_name, `prom-${bucketSize}`))
      .limit(1);
    lastSuccessMs = row?.last_success ? new Date(row.last_success).getTime() : null;
  } catch (err) {
    // Meta unreadable ⇒ no catch-up; the current bucket still rolls.
    console.warn('[analytics-rollup] meta read failed; skipping catch-up:', errMessage(err));
  }
  const results: RollupTickResult[] = [];
  for (const bucketTs of bucketsToRoll(Date.now(), bucketSeconds, lastSuccessMs)) {
    const r = await runRollupTick({ bucketTs });
    results.push(r);
    if (r.outcome !== 'ok' && r.outcome !== 'partial') break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Start the periodic rollup loop. Idempotent — calling twice is a no-op.
 * The scheduler is best-effort: a tick failure is logged and the next one
 * still runs. A tick that overruns the interval is skipped (no stacking).
 */
export function startAnalyticsRollupWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(process.env.ANALYTICS_ROLLUP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[analytics-rollup] interval invalid, refusing to start');
    return;
  }

  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      for (const r of await runRollupCycle()) {
        console.log(
          `[analytics-rollup] bucket_ts=${r.bucketTs} outcome=${r.outcome} written=${r.metricsWritten} ` +
            `prom_queries=${r.promQueries} prom_series=${r.promSeries} ` +
            `dropped_no_tenant=${r.droppedNoTenant} dropped_bad_value=${r.droppedBadValue} ` +
            `unknown_initiator=${r.unknownInitiatorRows} ` +
            `lock=${r.acquiredLock}`,
        );
      }
    } catch (err) {
      console.error('[analytics-rollup] tick failed:', err);
    } finally {
      tickInFlight = false;
    }
  };

  // Kick off immediately so a freshly-deployed pod doesn't sit empty for the
  // full interval, then settle into the cadence.
  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  console.log(`[analytics-rollup] scheduler started, interval=${intervalMs}ms`);
}

export function stopAnalyticsRollupWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
