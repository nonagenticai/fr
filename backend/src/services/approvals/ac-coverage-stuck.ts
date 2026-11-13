// src/services/approvals/ac-coverage-stuck.ts
//
// ⭐ INDEXED. The WHERE names `kind` (the leading key of `approvals_ac_coverage_sweep_idx`)
// and spells the index predicate's `status` / `completed_at` clauses exactly as migration 153
// does, so the planner can use that tiny partial index instead of scanning `approvals`.
// (`approvals_kind_status_idx` is partial on status = 'pending' and cannot serve decided
// rows.)
//
// Samples the population behind `fr_ac_coverage_stuck_approvals` (lib/ac-coverage-stuck-
// metrics.ts): decided coverage sign-offs with no completed ac_coverage delivery, decided
// more than 6 h ago, grouped by the reason the marker records. Run once per redelivery tick.
//
// "Decided at" is `approvals.completed_at` (stamped by the completing UPDATE), falling back
// to updated_at for a row that somehow lacks it. ⛔ NEVER THROWS: a failed sample keeps the
// previous snapshot, whose age series then grows — which is the signal.

import { sql, type SQL } from 'drizzle-orm';

import { db } from '../../db/client';
import { AC_COVERAGE_STUCK_AFTER_HOURS, publishAcCoverageStuck } from '../../lib/ac-coverage-stuck-metrics';
import { COVERAGE_SIGNOFF_KIND } from './u3-gates';

function sinkConfigured(): boolean {
  return Boolean(process.env.AA_TRACE_SINK_URL?.trim() && process.env.AA_TRACE_SINK_SECRET?.trim());
}

/** The sampling statement: stuck rows grouped by the reason they are stuck. */
function acCoverageStuckQuery(): SQL {
  return sql`
      SELECT CASE
               WHEN NOT (metadata ? 'coverage_decision') THEN 'coverage_decision_absent'
               WHEN metadata -> 'ac_coverage_delivery' ->> 'last_error' = 'decided_trace_id_missing' THEN 'decided_trace_id_missing'
               WHEN metadata -> 'ac_coverage_delivery' ->> 'last_error' IS NOT NULL THEN 'sink_error'
               ELSE 'not_attempted'
             END AS reason,
             count(*)::int AS n
        FROM approvals
       WHERE kind = ${COVERAGE_SIGNOFF_KIND}::approval_kind
         AND status IN ('approved', 'rejected')
         AND COALESCE((metadata -> 'ac_coverage_delivery') ? 'completed_at', false) = false
         AND COALESCE(completed_at, updated_at) < now() - make_interval(hours => ${AC_COVERAGE_STUCK_AFTER_HOURS})
       GROUP BY 1`;
}

/** Returns the published counts, or null when the sample failed (snapshot left as it was). */
export async function sampleAcCoverageStuck(): Promise<Record<string, number> | null> {
  try {
    const rows = await db.execute<{ reason: string; n: number }>(acCoverageStuckQuery());
    const counts: Record<string, number> = {};
    const configured = sinkConfigured();
    for (const r of Array.isArray(rows) ? rows : []) {
      // With no sink configured every stuck row is stuck for THAT reason first.
      const reason = configured ? String(r.reason) : 'sink_unconfigured';
      counts[reason] = (counts[reason] ?? 0) + Number(r.n);
    }
    publishAcCoverageStuck(counts);
    return counts;
  } catch (err) {
    console.warn('[ac-coverage] stuck_sample_failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}
