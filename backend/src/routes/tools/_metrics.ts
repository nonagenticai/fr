/**
 * In-process Prometheus-text-format metrics for the activity surface.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
 *   §"Telemetry emitted":
 *     - fr_kanban_liveness_lag_seconds (gauge)  — read from kanbanWebSocket
 *     - fr_n8n_executions_total{status}  (counter) — written by activity.list
 *     - fr_activity_list_duration_seconds (histogram) — written by activity.list
 *
 * Exposes the in-memory counters and a `renderProm()` text-format
 * serializer the metrics route mounts at GET /api/metrics/prom. It is
 * intentionally additive — the canonical OTel `emitSpan` helper still owns
 * traces; this is the thin Prom mirror for the gauges + counters this slice
 * needs in Grafana for alerting.
 */

import { getKanbanLivenessSnapshot } from '../kanbanWebSocket';
import { recordN8nExecutionStatus } from '../metrics';

const executionsTotalByStatus = new Map<string, number>();

export function recordTerminalExecution(status: string): void {
  executionsTotalByStatus.set(status, (executionsTotalByStatus.get(status) ?? 0) + 1);
  // Mirror into the canonical Prom exporter at /api/metrics/prom so the
  // status-keyed counter stays in sync with the legacy in-process map.
  recordN8nExecutionStatus(status);
}

const HIST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface Histogram {
  buckets: Map<number, number>;
  inf: number;
  sum: number;
  count: number;
}

const listDuration: Histogram = {
  buckets: new Map(HIST_BUCKETS.map((b) => [b, 0])),
  inf: 0,
  sum: 0,
  count: 0,
};

export function observeListDuration(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  for (const b of HIST_BUCKETS) {
    if (seconds <= b) listDuration.buckets.set(b, (listDuration.buckets.get(b) ?? 0) + 1);
  }
  listDuration.inf += 1;
  listDuration.sum += seconds;
  listDuration.count += 1;
}

export { getKanbanLivenessSnapshot };
