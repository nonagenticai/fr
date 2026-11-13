/**
 * tempo-url.ts
 *
 * Pure helper for building a Grafana Explore deep-link that points at a Tempo
 * trace lookup keyed by `execution_id` (and optionally `workflow_id`). Keeping
 * this as a tiny pure function lets us unit-test the URL shape exhaustively
 * without dragging in a Svelte runtime.
 *
 * Backend mirror: `backend/src/routes/tools/n8n.ts::buildTraceUrl` produces
 * the same shape and is the source of truth for `trace_url` on each row of
 * `n8n.list_executions` / `n8n.get_execution`. The frontend helper exists for
 * the case where a row only carries `traceId` (no precomputed URL) — e.g.
 * future surfaces that consume raw trace IDs from other integrations.
 *
 * Plan ref: docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
 *   §"Open follow-ups" — "Tempo deep-link".
 */

/**
 * Default Grafana host. Comes from build-time `VITE_GRAFANA_URL`
 * (Vite/Svelte injects it from gitops env). When unset, defaults to ''
 * and `buildTempoUrl` returns a relative URL — operators must set
 * `VITE_GRAFANA_URL` in the frontend ConfigMap for production.
 *
 * Per config-externalization-policy.md (deployment), no
 * hardcoded `grafana.nonagentic.ai` fallback in source.
 */
const DEFAULT_GRAFANA_BASE: string =
  (import.meta.env?.VITE_GRAFANA_URL as string | undefined) ?? '';

export interface BuildTempoUrlInput {
  /** Required: the execution id we're tracing (n8n execution id, etc). */
  executionId: string;
  /** Optional: the workflow id, narrows the Tempo query. */
  workflowId?: string | undefined;
  /**
   * Optional: override the Grafana host. Defaults to
   * `import.meta.env.VITE_GRAFANA_URL` (set at frontend build time from
   * the gitops fr-frontend ConfigMap).
   */
  grafanaBase?: string | undefined;
}

/**
 * Build a Grafana Explore URL pointing Tempo at the given execution_id.
 *
 * URL shape (mirrors backend `buildTraceUrl`):
 *   `<base>/explore?left=<urlencoded(JSON.stringify([
 *     "now-1h", "now", "tempo", { expr: "{execution_id=\"X\", workflow_id=\"Y\"}" }
 *   ]))>`
 *
 * `workflow_id` is omitted from the expr when undefined.
 */
export function buildTempoUrl(input: BuildTempoUrlInput): string {
  const base = (input.grafanaBase ?? DEFAULT_GRAFANA_BASE).replace(/\/+$/, '');
  const exprParts = [`execution_id="${input.executionId}"`];
  if (input.workflowId) {
    exprParts.push(`workflow_id="${input.workflowId}"`);
  }
  const queryObj = { expr: `{${exprParts.join(', ')}}` };
  const left = encodeURIComponent(
    JSON.stringify(['now-1h', 'now', 'tempo', queryObj]),
  );
  return `${base}/explore?left=${left}`;
}
