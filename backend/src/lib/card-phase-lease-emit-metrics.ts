// src/lib/card-phase-lease-emit-metrics.ts
//
// One counter: how many `lease.released` emits to n8n FAILED, split only by the
// reason the lease ended. Three label values, bounded — no card, tenant or holder
// label, ever (those are unbounded).
//
// WHY IT EXISTS. `services/card-phase-lease-events.ts` posts `lease.released` to
// n8n FIRE-AND-FORGET after the release / supersede has committed: a failed or
// slow POST must never fail, delay or roll back the lease response (§3.4 CLOSED
// degradation is about the lease, not the notification). The cost of that choice
// is that a lost emit is otherwise invisible — the consumer (event-driven QA
// re-pull) simply never hears about the freed card and falls back to its poll.
// This counter is what makes that loss a number.
//
// Lives in `lib/` so `routes/metrics.ts` can render it without importing the n8n
// client graph (the metering-span-metrics.ts shape).

export const LEASE_RELEASE_REASONS = ['released', 'expired_superseded', 'preempted'] as const;
export type LeaseReleaseReason = (typeof LEASE_RELEASE_REASONS)[number];

const emitFailuresTotal = new Map<LeaseReleaseReason, number>(
  LEASE_RELEASE_REASONS.map((r) => [r, 0]),
);

/** Count one failed (thrown, non-2xx, or timed-out) `lease.released` emit. */
export function recordLeaseReleaseEmitFailure(reason: LeaseReleaseReason): void {
  emitFailuresTotal.set(reason, (emitFailuresTotal.get(reason) ?? 0) + 1);
}

/** Prometheus text-exposition lines for the counter. Rendered by routes/metrics.ts. */
export function renderCardPhaseLeaseEmitMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_card_phase_lease_release_emit_failures_total lease.released emits to n8n that failed (fire-and-forget; the lease op itself succeeded), by why the lease ended.',
    '# TYPE fr_card_phase_lease_release_emit_failures_total counter',
  ];
  for (const r of LEASE_RELEASE_REASONS) {
    lines.push(
      `fr_card_phase_lease_release_emit_failures_total{reason="${r}"} ${emitFailuresTotal.get(r) ?? 0}`,
    );
  }
  return lines;
}
