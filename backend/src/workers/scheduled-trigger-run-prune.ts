// src/workers/scheduled-trigger-run-prune.ts
//
// Retention reaper for the `scheduled_trigger_runs` audit table.
//
// WHY THIS EXISTS. The table had NO retention of any kind — verified across all
// four surfaces it could have lived on: no TTL column or partitioning in any
// migration, no prune function (the only `CREATE FUNCTION`s in migrations are
// andon/workspaces triggers), no k8s CronJob (fr ships zero CronJob manifests),
// and no admin endpoint (every non-test reference to the table is an INSERT or a
// SELECT). Measured on prod 2026-08-05: 65,822 rows, 2026-05-01 → 2026-08-02.
//
// Most of that came from ONE trigger pointed at a deleted n8n workflow, which
// re-POSTed on every cron slot and wrote ~720 rows/day forever. #752 closed the
// SOURCE (a trigger now auto-disables after 3 consecutive permanent 4xx). This
// worker bounds the TABLE, which is a genuinely separate concern: the table is
// unbounded even when every trigger is healthy — a fleet of well-behaved
// triggers writes rows just as permanently, only more slowly.
//
// Retention horizon is 90 days (George's call, 2026-08-05). That deliberately
// keeps a wide forensic window: the 2026-08-01 diagnosis of the dead trigger was
// only possible because three months of history were still there, and a 7- or
// 30-day horizon would have destroyed the evidence before anyone looked. Growth
// is currently zero (the only trigger is disabled), so the first tick prunes the
// early-May window and then the table sits bounded.
//
// Correctness note: this is garbage collection only. `scheduled_trigger_runs` is
// an append-only audit log — nothing reads a row older than the last-run summary
// on `scheduled_triggers` itself, so a missed tick costs disk, never behaviour.
//
// Concurrency: fr runs multiple replicas, so an unguarded periodic DELETE would
// be a thundering herd of writers on the same rows. Singleton-per-tick via a
// Postgres *transaction-scoped* advisory lock, exactly as workers/idempotency-
// sweep.ts and workers/analytics-rollup.ts do. Transaction-scoped and NOT
// `pg_try_advisory_lock` (session-scoped) for the reason documented at length in
// analytics-rollup: postgres.js hands a different pooled connection per
// statement, so a later `pg_advisory_unlock` lands on a different backend,
// returns false without raising, and the lock leaks forever through pgbouncer's
// transaction-mode server pool.

import { sql } from 'drizzle-orm';

import { LOCK_KEYS } from '../db/advisory-lock-keys';
import { db as defaultDb } from '../db/client';

// Advisory-lock key. Registered in src/db/advisory-lock-keys.ts — the only
// place one may be declared. Do not restate the keyspace here.
const ADVISORY_LOCK_KEY = LOCK_KEYS.scheduledTriggerRunPrune;

/** Retention horizon in days. Override: SCHEDULED_TRIGGER_RUN_RETENTION_DAYS. */
const DEFAULT_RETENTION_DAYS = 90;
/** Daily — proportionate to a 90-day horizon (idempotency-sweep is hourly for a 7-day one). */
const DEFAULT_INTERVAL_MS = 86_400_000;
/** Rows per DELETE statement. */
const BATCH_SIZE = 1000;
/**
 * Max batches per tick. Paces the backlog drain: the first tick after deploy
 * faces every row older than the horizon that has accumulated since the table
 * was created, and we would rather spread that over a few ticks than hold one
 * long write transaction.
 */
const MAX_BATCHES_PER_TICK = 10;

export type PruneOutcome = 'ok' | 'skipped' | 'failed';

export interface PruneTickResult {
  outcome: PruneOutcome;
  /** True if this replica won the advisory lock for this tick. */
  acquiredLock: boolean;
  deleted: number;
  batches: number;
  /** True when MAX_BATCHES_PER_TICK was exhausted and rows probably remain. */
  more: boolean;
  retentionDays: number;
  error?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the retention horizon. An unparseable or non-positive override is
 * REFUSED back to the default rather than honoured: a `0` or `-1` reaching the
 * interval below would delete rows newer than now() and empty the audit log,
 * which is the one outcome this worker must never produce by accident.
 */
function resolveRetentionDays(): number {
  const raw = process.env.SCHEDULED_TRIGGER_RUN_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    console.warn(
      `[scheduled-trigger-run-prune] SCHEDULED_TRIGGER_RUN_RETENTION_DAYS=${raw} is not a positive ` +
        `integer; falling back to ${DEFAULT_RETENTION_DAYS} days`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return n;
}

/**
 * Delete one batch of rows older than the horizon.
 *
 * The `ctid IN (SELECT ... LIMIT n)` shape is what makes the batch bounded —
 * a bare `DELETE ... WHERE created_at < ...` would take the whole backlog in one
 * statement and one long-held write lock. `make_interval(days => n)` is used
 * rather than string-concatenating an interval literal so the horizon can never
 * be an injection seam.
 */
async function pruneOldRunsBatch(retentionDays: number): Promise<number> {
  const rows = await defaultDb.execute<{ deleted: number }>(sql`
    WITH keep AS (
      -- NB keep this template free of backticks. A backtick here TERMINATES the
      -- tagged template, and the parse error points at the SQL text rather than at
      -- the quoting, so it reads like broken SQL. (Cost one debug cycle; the first
      -- attempt at this very warning contained backticks and re-broke the file.)
      --
      -- Each trigger's most recent 'ok' run is EXEMPT from retention, at any age.
      -- Not an optimisation, a correctness fix. workers/scheduled-trigger-health.ts
      -- derives last_ok_at = max(fired_at) filtered to status 'ok' per trigger, then
      -- last_ok_age_seconds = now() - COALESCE(last_ok_at, t.created_at), plus
      -- consecutive_failures = the non-ok runs SINCE that row. Delete the last 'ok'
      -- and two things break at once: the age silently falls back to the trigger's
      -- creation date (so "succeeded once, long ago" becomes indistinguishable from
      -- "never succeeded"), and the failure streak is recounted from -infinity and
      -- inflates. A trigger that is merely OLD would then read as broken, which is
      -- the opposite of what a retention policy is for.
      -- One row per (trigger_kind, trigger_id); ties broken by ctid so the set is
      -- deterministic even if two 'ok' rows share a fired_at.
      --
      -- The EXISTS is what stops the exemption becoming a permanent leak. There is
      -- NO foreign key from scheduled_trigger_runs.trigger_id to scheduled_triggers,
      -- so deleting a trigger orphans its runs; without this clause the orphan's
      -- newest 'ok' row is exempt FOREVER while protecting nothing, because
      -- scheduled-trigger-health.ts reads FROM scheduled_triggers and a deleted
      -- trigger contributes no row to protect. Measured on prod 2026-08-05, after
      -- the reaper's first live tick: 32 rows past the horizon, 4 exempt, and ALL 4
      -- of those orphaned — i.e. every exemption that survived was a leak, not a
      -- protected signal.
      SELECT DISTINCT ON (r.trigger_kind, r.trigger_id) r.ctid
      FROM scheduled_trigger_runs r
      WHERE r.status = 'ok'
        AND EXISTS (SELECT 1 FROM scheduled_triggers t WHERE t.id = r.trigger_id)
      ORDER BY r.trigger_kind, r.trigger_id, r.fired_at DESC, r.ctid DESC
    ),
    doomed AS (
      SELECT r.ctid
      FROM scheduled_trigger_runs r
      WHERE r.created_at < now() - make_interval(days => ${retentionDays}::int)
        AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.ctid = r.ctid)
      LIMIT ${BATCH_SIZE}
    )
    DELETE FROM scheduled_trigger_runs t
    USING doomed
    WHERE t.ctid = doomed.ctid
  `);
  // drizzle/postgres.js surfaces the affected-row count differently depending on
  // the driver handle; `count` is what postgres.js sets on a DELETE result.
  const n = (rows as unknown as { count?: number })?.count;
  return typeof n === 'number' ? n : Array.isArray(rows) ? rows.length : 0;
}

/**
 * Run one prune under the advisory lock.
 */
export async function runScheduledTriggerRunPruneTick(): Promise<PruneTickResult> {
  const db = defaultDb;
  const retentionDays = resolveRetentionDays();
  const result: PruneTickResult = {
    outcome: 'ok',
    acquiredLock: false,
    deleted: 0,
    batches: 0,
    more: false,
    retentionDays,
  };

  const drain = async (): Promise<void> => {
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const n = await pruneOldRunsBatch(retentionDays);
      result.batches++;
      result.deleted += n;
      if (n < BATCH_SIZE) return;
    }
    result.more = true;
  };

  try {
    await db.transaction(async (tx) => {
      const rows = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`,
      );
      const acquired =
        Array.isArray(rows) && rows.length > 0 ? Boolean(rows[0]!.locked) : false;
      result.acquiredLock = acquired;
      if (!acquired) {
        // Another replica owns this tick. Do nothing — it will report.
        result.outcome = 'skipped';
        return;
      }
      await drain();
    });
  } catch (err) {
    result.outcome = 'failed';
    result.error = errMessage(err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let tickInFlight = false;

/**
 * Delay before the next tick after a backlog-limited one. `more: true` means the
 * tick hit MAX_BATCHES_PER_TICK with rows still past the horizon; waiting the
 * full interval (24 h by default) then left a backlog draining one tick-cap per
 * DAY. A backlog tick re-runs after this instead.
 */
const PRUNE_BACKLOG_RETRY_MS = 5 * 60_000;

/** The delay before the next tick, given the last tick's result. */
function nextPruneDelayMs(r: Pick<PruneTickResult, 'more'> | null, intervalMs: number): number {
  return r?.more ? Math.min(PRUNE_BACKLOG_RETRY_MS, intervalMs) : intervalMs;
}

/**
 * Start the periodic prune. Idempotent — calling twice is a no-op.
 * Interval override: `SCHEDULED_TRIGGER_RUN_PRUNE_INTERVAL_MS`.
 *
 * A self-rescheduling timeout rather than a fixed setInterval, so a tick that
 * reports `more: true` brings the next one forward to PRUNE_BACKLOG_RETRY_MS.
 */
export function startScheduledTriggerRunPruneWorker(): void {
  if (started) return;
  const intervalMs = Number(
    process.env.SCHEDULED_TRIGGER_RUN_PRUNE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[scheduled-trigger-run-prune] interval invalid, refusing to start');
    return;
  }
  started = true;

  const runOnce = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = true;
    let r: PruneTickResult | null = null;
    try {
      r = await runScheduledTriggerRunPruneTick();
      if (r.outcome !== 'skipped' && (r.deleted > 0 || r.outcome === 'failed')) {
        console.log(
          `[scheduled-trigger-run-prune] outcome=${r.outcome} deleted=${r.deleted} ` +
            `batches=${r.batches} more=${r.more} retentionDays=${r.retentionDays}` +
            (r.error ? ` error=${r.error}` : ''),
        );
      }
    } catch (err) {
      console.error('[scheduled-trigger-run-prune] tick failed:', err);
    } finally {
      tickInFlight = false;
    }
    if (!started) return;
    timer = setTimeout(() => {
      void runOnce();
    }, nextPruneDelayMs(r, intervalMs));
  };

  // Kick off immediately: on a fresh deploy the backlog is the whole history.
  void runOnce();
  console.log(
    `[scheduled-trigger-run-prune] scheduler started, interval=${intervalMs}ms, ` +
      `retentionDays=${resolveRetentionDays()}`,
  );
}

export function stopScheduledTriggerRunPruneWorker(): void {
  started = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
