// src/lib/metering-span-metrics.ts
//
// One counter: how many metering spans fr-backend emitted, split ONLY by
// whether the span carried a tenant. Two label values, so this series can never
// blow up on request-path cardinality.
//
// WHY IT EXISTS. `services/metering-emit.ts` sends `tenant_id: ''` when the
// request context has no tenant, and billing does NOT reject that row — it logs
// `tenant_id_unattributed` and writes it to the nil tenant
// (`00000000-0000-0000-0000-000000000000`) anyway
// (`billing_service/src/services/event_flusher.py:143-172`,
// `billing_service/src/services/_parsers.py:51-66`). So an attribution leak was
// silent from BOTH ends: nothing on fr's side counted it, and nothing on
// billing's side refused it. Measured in `billing_metering_events` on worker4
// over 3h on 2026-09-04, fr's three n8n webhook routes alone accounted for 384
// such rows — ≈2,733/day, 85% of it `router-dedupe`.
//
// `attributed="no"` is therefore a real signal, not noise: it means fr emitted
// a billing event it could not attribute to anyone. Expected small and
// non-zero (genuinely anonymous pre-auth routes exist); a STEP CHANGE in it is
// a new leak.
//
// This lives in `lib/` rather than in `routes/metrics.ts` on purpose:
// `middleware/usage-spans.ts` is on every request's path and is unit-tested
// without a database, so it must not transitively import `db/client` or the
// websocket manager. `routes/metrics.ts` imports the render helper from here.

const METERING_SPAN_ATTRIBUTION = ['yes', 'no'] as const;
type MeteringSpanAttribution = (typeof METERING_SPAN_ATTRIBUTION)[number];

const meteringSpansTotal = new Map<MeteringSpanAttribution, number>(
  METERING_SPAN_ATTRIBUTION.map((a) => [a, 0]),
);

/**
 * Count one emitted metering span. Called from `middleware/usage-spans.ts` on
 * every non-skipped request, immediately before the span is pushed.
 */
export function recordMeteringSpanAttribution(attributed: boolean): void {
  const key: MeteringSpanAttribution = attributed ? 'yes' : 'no';
  meteringSpansTotal.set(key, (meteringSpansTotal.get(key) ?? 0) + 1);
}

/** Prometheus text-exposition lines for the counter. Rendered by routes/metrics.ts. */
export function renderMeteringSpanMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_metering_spans_total Metering spans emitted by fr-backend, split by whether the span carried a tenant.',
    '# TYPE fr_metering_spans_total counter',
  ];
  for (const a of METERING_SPAN_ATTRIBUTION) {
    lines.push(`fr_metering_spans_total{attributed="${a}"} ${meteringSpansTotal.get(a) ?? 0}`);
  }
  return lines;
}
