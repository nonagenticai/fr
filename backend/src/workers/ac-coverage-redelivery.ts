// src/workers/ac-coverage-redelivery.ts
//
// U3 R5 — re-delivers the ac_coverage rows of decided `qa.coverage_signoff` approvals whose
// first delivery (on the decide path, services/approvals/ac-coverage-writeback.ts) did not
// complete: the sink answered 503/5xx/401/403, the network failed, the pod rolled
// mid-delivery, or fr#1333's `coverage_decision.decided_trace_id` was not there yet.
//
// Modelled on workers/deblock-callback-redelivery.ts: a module-level timer, an in-process
// `tickInFlight` guard, an immediate boot tick placed AFTER the interval guard (a pod at
// generation ~800 often never lives to see its first interval — see that file's
// "IT NOW FIRES ON BOOT" block), a bounded per-tick batch, and a typed tick result.
//
// WHY IT IS SAFE TO RE-SEND, unlike the de-block callback that file guards so heavily:
// the receiver IS idempotent. The ILS sink keys ac_coverage on (card_id, criterion_id,
// coverage_source, approval_id); a byte-identical re-POST is `200 replayed`, and the
// writeback resends the identical body (same persisted decision trace). So the worst
// outcome of a duplicate send is a replay, never a second row.
//
// ONE DELIVERER PER ROW, ACROSS REPLICAS — WITHOUT A LOCK ACROSS HTTP. The tick CLAIMS
// up to n rows in ONE short statement (`FOR UPDATE SKIP LOCKED`, stamping
// `ac_coverage_delivery.lease_until/lease_owner`), which commits before any POST; it then
// delivers each row with no transaction open, and RECORDS each result in a short statement
// that only lands while the lease is still this tick's. The decide path claims through the
// same function family (services/approvals/ac-coverage-writeback.ts), so a second tick on
// another replica — or the decide path racing this one — sees the live lease and POSTs
// nothing. A tick that dies mid-delivery leaves a lease that expires; the next tick
// reclaims the row. (The previous shape held the row locks for the whole tick — up to
// 10 rows × criteria × 5 s of HTTP inside one transaction — the fr#1314 pool-starvation
// pattern.)
//
// CANDIDATES:
//   kind = 'qa.coverage_signoff'
//   status decided (approved | rejected)
//   metadata ? 'coverage_decision'                        (fr#1333 wrote the decision)
//   no metadata.ac_coverage_delivery.completed_at         (not finished)
//   ac_coverage_delivery.lease_until expired or unset     (nobody is delivering it)
//   updated_at < now() - 2 min                            (the decide path had its turn)
//   ac_coverage_delivery.next_attempt_at <= now(), if set (bounded exponential backoff)
// Ordered by the earliest due instant, so a row that keeps failing yields to fresh ones.
//
// INERT WHEN THE SINK IS UNCONFIGURED (AA_TRACE_SINK_URL / AA_TRACE_SINK_SECRET): the tick
// selects nothing, so nothing is locked or written.
//
// Disable via AC_COVERAGE_REDELIVERY_DISABLED=true (server.ts).

import { db } from '../db/client';
import {
  claimAcCoverageBatch,
  deliverClaimedAcCoverage,
  newLeaseOwner,
  type AcCoverageResult,
} from '../services/approvals/ac-coverage-writeback';
import { sampleAcCoverageStuck } from '../services/approvals/ac-coverage-stuck';

export const DEFAULT_INTERVAL_MS = 300_000;
/** Rows claimed per tick. Each is ≤ (criteria × 5 s) of HTTP, with NO lock held across it. */
export const MAX_PER_RUN = 10;
/** The decide path delivers first; the sweep leaves a row alone this long after it changed. */
export const SETTLE_MS = 120_000;

export interface AcCoverageTickResult {
  outcome: 'ok' | 'skipped' | 'failed';
  candidates: number;
  delivered: number;
  emitted: number;
  pending: number;
  skipped: Partial<Record<NonNullable<AcCoverageResult['skipped']>, number>>;
  error?: string;
}

function sinkConfigured(): boolean {
  return Boolean(process.env.AA_TRACE_SINK_URL?.trim() && process.env.AA_TRACE_SINK_SECRET?.trim());
}

export async function runAcCoverageRedeliveryTick(): Promise<AcCoverageTickResult> {
  const result: AcCoverageTickResult = {
    outcome: 'ok',
    candidates: 0,
    delivered: 0,
    emitted: 0,
    pending: 0,
    skipped: {},
  };
  if (!sinkConfigured()) {
    result.outcome = 'skipped';
    return result;
  }
  try {
    // ONE ROW PER CLAIM, up to MAX_PER_RUN per tick: a row claimed in a batch would wait behind
    // the others' HTTP and could see its lease lapse before its turn.
    const owner = newLeaseOwner('sweep');
    for (let i = 0; i < MAX_PER_RUN; i++) {
      // (i) CLAIM — one statement, committed before any HTTP.
      const [row] = await claimAcCoverageBatch({ owner, limit: 1, settleSecs: SETTLE_MS / 1000 }, db);
      if (!row) break;
      result.candidates += 1;
      // (ii) DELIVER + (iii) RECORD, with no transaction open.
      const r = await deliverClaimedAcCoverage(row, db);
      result.emitted += r.emitted;
      if (r.skipped) result.skipped[r.skipped] = (result.skipped[r.skipped] ?? 0) + 1;
      else if (r.pending?.length) result.pending += 1;
      else result.delivered += 1;
    }
  } catch (err) {
    result.outcome = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Same shape as `startDeblockRedeliveryWorker`: refuse a bad interval and fire NOTHING;
 * otherwise one immediate tick (reached only past the guard) and then every interval.
 */
export function startAcCoverageRedeliveryWorker(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer !== null) return;
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) return;

  const runOnce = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runAcCoverageRedeliveryTick();
      // The stuck-row gauge is sampled every tick, configured or not: an unconfigured sink
      // is exactly when decided rows pile up undelivered.
      await sampleAcCoverageStuck();
      if (r.outcome === 'failed') {
        console.error('[ac-coverage-redelivery] tick failed:', r.error);
      } else if (r.candidates > 0) {
        console.log(
          `[ac-coverage-redelivery] candidates=${r.candidates} delivered=${r.delivered} ` +
            `emitted=${r.emitted} pending=${r.pending} skipped=${JSON.stringify(r.skipped)}`,
        );
      }
    } catch (err) {
      console.error('[ac-coverage-redelivery] tick threw:', err instanceof Error ? err.message : String(err));
    } finally {
      tickInFlight = false;
    }
  };

  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
}

export function stopAcCoverageRedeliveryWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
