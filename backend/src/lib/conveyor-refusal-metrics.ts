// src/lib/conveyor-refusal-metrics.ts
//
// ⛔ WHAT THIS COUNTS: an INBOUND conveyor request that fr REFUSED.
//
// The conveyor is a loop. n8n (and the Claude sessions driving cards) call INTO
// fr to report what happened — an execution event, a card comment, a project
// read-back. When fr refuses one of those, the event is GONE: n8n's HTTP node does not
// retry a 4xx, and fr writes nothing. The only trace was a line in the pod's
// stdout, which dies with the pod.
//
// MEASURED 2026-09-10, prod fr pod, one hour:
//     POST /api/webhooks/n8n/execution-event   404 x3
//     POST /api/kanban/cards/<id>/comments     404 x2
//     POST /api/kaizen/log                     404 x2
// Three separate writeback channels dark at once, and nothing anywhere held a
// number for it. A PR auditor produced a full review of ems #145 and could leave
// no record on the card — the refusal was as silent to the producer as to us.
//
// ⚠️ A REFUSAL IS NOT AUTOMATICALLY A BUG, and this counter deliberately does
// not decide that. Some of these refusals are CORRECT (n8n naming an entity fr
// genuinely does not have) and some are DEFECTS (fr unable to see something that
// exists). The point is that both must be VISIBLE. `reason` is what separates
// them after the fact — `project_id_is_tenant_id` is a producer defect,
// `project_not_found` may be either.
//
// ⛔ THE COUNTER IS THE DURABLE HALF, NOT THE LOG. `console.error` here names the
// offending id, which is what a human actually needs — but that line lives only
// as long as the pod. Prometheus scrapes `/metrics` and retains, so the counter
// is what survives a restart and what an alert can be written against. Both are
// emitted on purpose; neither substitutes for the other.
//
// Cardinality: surface x reason, both CLOSED sets, pre-seeded to zero. An
// unrecognised value collapses to `other` rather than minting a series, and the
// zero baseline is deliberate — a series that only appears once it fires cannot
// be distinguished from an exporter that is not wired up.
//
// Lives in `lib/` for the same reason `metering-span-metrics.ts` does: the
// callers (a webhook receiver, a project read) are unit-tested
// without a database, so this module must not transitively import `db/client`.

export const CONVEYOR_SURFACES = [
  /** POST /api/webhooks/n8n/execution-event */
  'n8n_execution_event',
  /** GET /api/projects/:id — the conveyor's own read-back of a project */
  'project_read',
] as const;
export type ConveyorSurface = (typeof CONVEYOR_SURFACES)[number];

export const CONVEYOR_REFUSAL_REASONS = [
  /** No `projects` row with that id, under any tenant. The lookup is unscoped. */
  'project_not_found',
  /**
   * The id sent as a PROJECT id is a canonical TENANT (workspace) id — e.g.
   * `0195f48b-d000-7000-8000-000000000004` (`prompt-improvement`). fr is right
   * to refuse; the producer is naming the wrong entity kind. Split out from
   * `project_not_found` because the fix belongs to a different component.
   */
  'project_id_is_tenant_id',
  'other',
] as const;
export type ConveyorRefusalReason = (typeof CONVEYOR_REFUSAL_REASONS)[number];

const key = (s: ConveyorSurface, r: ConveyorRefusalReason): string => `${s}|${r}`;

const refusals = new Map<string, number>();
for (const s of CONVEYOR_SURFACES) {
  for (const r of CONVEYOR_REFUSAL_REASONS) refusals.set(key(s, r), 0);
}

function normaliseReason(reason: string): ConveyorRefusalReason {
  return (CONVEYOR_REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as ConveyorRefusalReason)
    : 'other';
}

/** Increment only. Exported for callers that have already logged their own line. */
export function recordConveyorRefusal(
  surface: ConveyorSurface,
  reason: ConveyorRefusalReason,
): void {
  const k = key(surface, normaliseReason(reason));
  refusals.set(k, (refusals.get(k) ?? 0) + 1);
}

export interface ConveyorRefusalDetail {
  surface: ConveyorSurface;
  reason: ConveyorRefusalReason;
  /** The id fr could not resolve. Named in the log line, never in a label. */
  subject_id?: string | null;
  /** Free-form, log-only. Keep it short and factual. */
  detail?: Record<string, unknown>;
}

/**
 * Count the refusal AND emit one structured line naming the id.
 *
 * ⛔ Never throws. Recording a refusal must not itself become a failure — the
 * caller is already on an error path and a throw here would replace a
 * diagnosable 404 with an undiagnosable 500.
 */
export function reportConveyorRefusal(d: ConveyorRefusalDetail): void {
  try {
    recordConveyorRefusal(d.surface, d.reason);
    console.error(
      JSON.stringify({
        telemetry: 'conveyor_inbound_refused',
        surface: d.surface,
        reason: normaliseReason(d.reason),
        subject_id: d.subject_id ?? null,
        ...(d.detail ?? {}),
      }),
    );
  } catch {
    // Deliberately silent: see above.
  }
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderConveyorRefusalMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_conveyor_inbound_refused_total Inbound conveyor requests fr refused, by surface and reason.',
    '# TYPE fr_conveyor_inbound_refused_total counter',
  ];
  for (const s of CONVEYOR_SURFACES) {
    for (const r of CONVEYOR_REFUSAL_REASONS) {
      lines.push(
        `fr_conveyor_inbound_refused_total{surface="${s}",reason="${r}"} ${refusals.get(key(s, r)) ?? 0}`,
      );
    }
  }
  return lines;
}

