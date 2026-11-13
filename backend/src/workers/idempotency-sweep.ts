// src/workers/idempotency-sweep.ts
//
// Reaper for the `action_idempotency` TTL store.
//
// `sweepExpiredIdempotency()` shipped 2026-04-24 alongside migration 010 (which
// even created `idx_action_idempotency_expires_at` "for the sweep job that
// deletes expired rows") — and then had ZERO callers for three months. Prod
// (worker4, db `fr`) held 6209 rows, none unexpired, oldest 2026-04-27.
//
// Correctness note: this worker is NOT what makes the TTL real. The claim path
// (domain/engagement/dedup-claim.ts) atomically takes over an expired row via
// `ON CONFLICT ... DO UPDATE ... WHERE expires_at <= NOW()`, so an unreaped
// expired row never blocks anything. This worker exists purely to bound table
// growth. Deleting it would waste disk, not lose records.
//
// Concurrency: fr runs multiple replicas, so an unguarded periodic DELETE would
// be a thundering herd of writers on the same rows. Singleton-per-tick via a
// Postgres *transaction-scoped* advisory lock, exactly as workers/analytics-
// rollup.ts does. Transaction-scoped and not `pg_try_advisory_lock` (session-
// scoped) for the reason documented at length there: postgres.js hands a
// different pooled connection per statement, so a later `pg_advisory_unlock`
// lands on a different backend, returns false without raising, and the lock
// leaks forever through pgbouncer's transaction-mode server pool.

import { sql } from 'drizzle-orm';

import { LOCK_KEYS } from '../db/advisory-lock-keys';
import { db as defaultDb } from '../db/client';
import {
  IDEMPOTENCY_SWEEP_BATCH_SIZE,
  sweepExpiredIdempotency,
} from '../domain/engagement/idempotency';

// Advisory-lock key. Registered in src/db/advisory-lock-keys.ts — the only
// place one may be declared. Do not restate the keyspace here.
const ADVISORY_LOCK_KEY = LOCK_KEYS.idempotencySweep;

const DEFAULT_INTERVAL_MS = 3_600_000; // hourly — expiry is a 7-day horizon
/** Rows per DELETE statement. */
const BATCH_SIZE = IDEMPOTENCY_SWEEP_BATCH_SIZE;
/**
 * Max batches per tick. Paces the backlog drain: the first tick after deploy
 * faces every row that has accumulated since 2026-04-24, and we would rather
 * spread that over a few ticks than hold one long write transaction.
 */
const MAX_BATCHES_PER_TICK = 10;

export type SweepOutcome = 'ok' | 'skipped' | 'failed';

export interface SweepTickResult {
  outcome: SweepOutcome;
  /** True if this replica won the advisory lock for this tick. */
  acquiredLock: boolean;
  deleted: number;
  batches: number;
  /** True when MAX_BATCHES_PER_TICK was exhausted and rows probably remain. */
  more: boolean;
  error?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one sweep under the advisory lock.
 */
export async function runIdempotencySweepTick(): Promise<SweepTickResult> {
  const db = defaultDb;
  const result: SweepTickResult = {
    outcome: 'ok',
    acquiredLock: false,
    deleted: 0,
    batches: 0,
    more: false,
  };

  const drain = async (): Promise<void> => {
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const n = await sweepExpiredIdempotency();
      result.batches++;
      result.deleted += n;
      if (n < BATCH_SIZE) return;
    }
    result.more = true;
  };

  try {
    // The lock is held for the whole tick so two replicas cannot interleave
    // batches; the DELETEs themselves run on the autocommit `queryClient`
    // handle (sweepExpiredIdempotency), which is what we want — a crash
    // mid-drain keeps the batches already committed.
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

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Start the periodic sweep. Idempotent — calling twice is a no-op.
 * Interval override: `IDEMPOTENCY_SWEEP_INTERVAL_MS`.
 */
export function startIdempotencySweepWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(
    process.env.IDEMPOTENCY_SWEEP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[idempotency-sweep] interval invalid, refusing to start');
    return;
  }

  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runIdempotencySweepTick();
      if (r.outcome !== 'skipped' && (r.deleted > 0 || r.outcome === 'failed')) {
        console.log(
          `[idempotency-sweep] outcome=${r.outcome} deleted=${r.deleted} ` +
            `batches=${r.batches} more=${r.more}` +
            (r.error ? ` error=${r.error}` : ''),
        );
      }
    } catch (err) {
      console.error('[idempotency-sweep] tick failed:', err);
    } finally {
      tickInFlight = false;
    }
  };

  // Kick off immediately: on a fresh deploy the backlog is the whole history.
  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  console.log(`[idempotency-sweep] scheduler started, interval=${intervalMs}ms`);
}

export function stopIdempotencySweepWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
