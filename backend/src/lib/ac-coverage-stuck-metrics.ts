// src/lib/ac-coverage-stuck-metrics.ts
//
// U3 R5 — how many DECIDED `qa.coverage_signoff` approvals still have no completed
// ac_coverage delivery more than 6 h after their decision, and WHY.
//
// Why a gauge and not a counter: the failure this watches is a row that silently never
// reaches the sink (decided_trace_id never arrives, the sink keeps refusing, the sink was
// never configured). The redelivery sweep retries such a row forever on a backoff and logs a
// warning per attempt — a log line that dies with the pod. What an operator needs is the
// STANDING population, which only a sampled gauge can express. Any value > 0 is a coverage
// record the M4 count is missing.
//
// Same shape as the andon state gauges (lib/andon-halt-metrics.ts): a sampler publishes a
// snapshot, `render*` emits it for routes/metrics.ts, and an AGE series lets a rule refuse to
// trust a stale snapshot. ⛔ No fabricated zero: before the first sample nothing is emitted
// for the population gauge (an absent series and "nothing stuck" must not look alike); after
// it, every reason is emitted, zeros included, so a quiet system is told apart from a dead
// sampler.
//
// Lives in `lib/` and imports nothing from `db/`, like its siblings; the SQL that samples it
// is services/approvals/ac-coverage-stuck.ts, run once per redelivery tick.
//
// Cardinality: one closed label, `reason`, 5 values. Approval / card / tenant ids are never
// labels.

export const AC_COVERAGE_STUCK_REASONS = [
  /** AA_TRACE_SINK_URL / _SECRET unset: nothing can be delivered at all. */
  'sink_unconfigured',
  /** fr#1333's coverage_decision is not on the row; the writeback never infers it. */
  'coverage_decision_absent',
  /** coverage_decision has no decided_trace_id; the writeback never mints a trace. */
  'decided_trace_id_missing',
  /** The last run ended on a retryable sink answer (5xx / 401 / 403 / 429 / network / lease). */
  'sink_error',
  /** Decided, no completed marker and no recorded error: no delivery has run (or finished). */
  'not_attempted',
] as const;
export type AcCoverageStuckReason = (typeof AC_COVERAGE_STUCK_REASONS)[number];

/** A decided approval counts as stuck once it is this old without a completed delivery. */
export const AC_COVERAGE_STUCK_AFTER_HOURS = 6;

interface Snapshot {
  counts: Record<AcCoverageStuckReason, number>;
  observedAtMs: number;
}

let snapshot: Snapshot | null = null;
const nowMs: () => number = () => Date.now();

/** Publish one sample. Unknown reasons are folded into `not_attempted` (never dropped). */
export function publishAcCoverageStuck(counts: Partial<Record<string, number>>): void {
  const out = Object.fromEntries(AC_COVERAGE_STUCK_REASONS.map((r) => [r, 0])) as Record<AcCoverageStuckReason, number>;
  for (const [reason, n] of Object.entries(counts)) {
    const k = (AC_COVERAGE_STUCK_REASONS as readonly string[]).includes(reason)
      ? (reason as AcCoverageStuckReason)
      : 'not_attempted';
    out[k] += Math.max(0, Math.floor(Number(n) || 0));
  }
  snapshot = { counts: out, observedAtMs: nowMs() };
}

export function renderAcCoverageStuckMetrics(): string[] {
  const lines: string[] = [];
  lines.push(
    `# HELP fr_ac_coverage_stuck_approvals Decided qa.coverage_signoff approvals with no completed ac_coverage delivery more than ${AC_COVERAGE_STUCK_AFTER_HOURS}h after the decision, by reason. No sample before the first sampling; any value > 0 is a coverage record missing from the sink.`,
  );
  lines.push('# TYPE fr_ac_coverage_stuck_approvals gauge');
  if (snapshot) {
    for (const r of AC_COVERAGE_STUCK_REASONS) {
      lines.push(`fr_ac_coverage_stuck_approvals{reason="${r}"} ${snapshot.counts[r]}`);
    }
  }
  lines.push(
    '# HELP fr_ac_coverage_stuck_sample_age_seconds Seconds since fr last sampled fr_ac_coverage_stuck_approvals. No sample when it never has. A rule that trusts the gauge must bound this.',
  );
  lines.push('# TYPE fr_ac_coverage_stuck_sample_age_seconds gauge');
  if (snapshot) {
    lines.push(`fr_ac_coverage_stuck_sample_age_seconds ${Math.max(0, (nowMs() - snapshot.observedAtMs) / 1000)}`);
  }
  return lines;
}
