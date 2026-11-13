// src/lib/priority-compensation-metrics.ts
//
// One counter: how many card-priority writes left Planka in an UNCERTAIN state
// because the compensation (restore-what-was-read) itself failed — split only
// by the phase that needed compensating. Two label values, bounded — no card,
// project, tenant or actor label, ever (those are unbounded and ride in the log
// line instead).
//
// WHY IT EXISTS. routes/cards/priority.ts writes the audit row in a Postgres
// transaction and the provenance + value to Planka inside it. When the Planka
// write or the COMMIT fails, it restores what it read so no unaudited change
// survives. If THAT restore fails, Planka may hold a priority change with no
// priority_change_events row — the one state the audit exists to rule out.
// Before this module it was a `console.error` that died with the pod and a
// 502/500 indistinguishable from an ordinary Planka outage. Now it is:
//   * this counter (durable: scraped from /metrics, alertable; the expected
//     steady state is ZERO, so the pre-seeded zero IS the measurement);
//   * one error-level structured line tagged `[priority-compensation-failed]`
//     naming the card, project and both errors (what a human chases);
//   * a 500 `priority_compensation_failed` naming the card to the caller.
//
// The mechanism is `card-phase-lease-emit-metrics.ts`'s shape: closed label
// set, pre-seeded to zero, increment-only recorder, `render*` for
// routes/metrics.ts. Lives in `lib/` so
// routes/metrics.ts can render it without importing the Planka/db graph.

export const PRIORITY_COMPENSATION_PHASES = [
  /** A Planka provenance/value write failed after the audit insert; restore failed. */
  'write_failed',
  /** Every write landed but the audit transaction's COMMIT failed; restore failed or was unsafe. */
  'commit_failed',
] as const;
export type PriorityCompensationPhase = (typeof PRIORITY_COMPENSATION_PHASES)[number];

/** The stable log tag. Grep / Loki-query this, never the free-text message. */
export const PRIORITY_COMPENSATION_FAILED_TAG = '[priority-compensation-failed]';

const failuresTotal = new Map<PriorityCompensationPhase, number>(
  PRIORITY_COMPENSATION_PHASES.map((p) => [p, 0]),
);

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Count one failed compensation AND emit the error-level structured line.
 * Never throws: it runs on an error path whose response must still be sent.
 */
export function reportPriorityCompensationFailure(args: {
  phase: PriorityCompensationPhase;
  projectId: string;
  cardId: string;
  cause: unknown;
  compensationError: unknown;
}): void {
  failuresTotal.set(args.phase, (failuresTotal.get(args.phase) ?? 0) + 1);
  try {
    console.error(
      PRIORITY_COMPENSATION_FAILED_TAG,
      JSON.stringify({
        event: 'priority_compensation_failed',
        phase: args.phase,
        project_id: args.projectId,
        card_id: args.cardId,
        cause: errText(args.cause),
        compensation_error: errText(args.compensationError),
      }),
    );
  } catch {
    // The counter already moved; a broken logger must not mask the 500.
  }
}

/** Prometheus text-exposition lines for the counter. Rendered by routes/metrics.ts. */
export function renderPriorityCompensationMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_priority_compensation_failed_total Card-priority writes whose restore-after-failure itself failed: Planka may hold a priority change with no priority_change_events row. Expected steady state is zero; any increase means look at the [priority-compensation-failed] log line for the card.',
    '# TYPE fr_priority_compensation_failed_total counter',
  ];
  for (const p of PRIORITY_COMPENSATION_PHASES) {
    lines.push(`fr_priority_compensation_failed_total{phase="${p}"} ${failuresTotal.get(p) ?? 0}`);
  }
  return lines;
}
