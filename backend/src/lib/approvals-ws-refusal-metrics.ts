// src/lib/approvals-ws-refusal-metrics.ts
//
// ⛔ WHAT THIS COUNTS: an approvals WebSocket upgrade or subscribe that fr
// REFUSED (fr row 14d-0b, approvals half).
//
// Before this row every `/api/approvals/ws` connection was auto-subscribed to
// `approvals:all`, which carries EVERY tenant's approval descriptions (plus
// every `new_report` from routes/reports.ts), and `{type:'subscribe',
// projectId}` was honoured for any id. Now `approvals:all` is admitted only
// for a platform-tenant approval socket, and `approvals:project:<id>` only
// when the project's `project_data->>'keycloak_tenant_id'` equals the
// socket's tenant (the 14b predicate; untagged fails closed).
//
// Same mechanism as `kanban-ws-refusal-metrics.ts`: closed label sets,
// pre-seeded to zero, increment-only, one structured log line per refusal.
// Tenant, user and project ids are LOG-ONLY, never labels. Imports nothing, so
// the hermetic websocket unit tests can import its callers with no database.

export const APPROVALS_WS_REFUSAL_SURFACES = [
  /** The `/api/approvals/ws` upgrade itself (no resolvable tenant). */
  'upgrade',
  /** `{type:'subscribe', approvalsAll:true}` — the cross-tenant broadcast. */
  'subscribe_all',
  /** `{type:'subscribe', projectId}` — `approvals:project:<id>`. */
  'subscribe_project',
] as const;
export type ApprovalsWsRefusalSurface = (typeof APPROVALS_WS_REFUSAL_SURFACES)[number];

export const APPROVALS_WS_REFUSAL_REASONS = [
  /** The socket's tenant resolved, but is not in PLATFORM_TENANT_IDS. *
   * RETIRED by fr row 14d-2 (per-tenant channels admit every tenant to its
   * OWN channel); kept pre-seeded so the series does not vanish. */
  'tenant_not_platform',
  /** The socket carries no resolvable tenant. Fail-closed. */
  'tenant_unresolved',
  /** An approvals topic requested on a non-approval socket (e.g. /api/kanban/ws). */
  'not_approval_socket',
  /** `projectId` is not a UUID — no project can match it. */
  'project_id_invalid',
  /** No `projects` row with that id. */
  'project_not_found',
  /** The project carries no `keycloak_tenant_id` tag. Fail-closed. */
  'project_untagged',
  /** The project's tag names a different tenant than the socket's. */
  'project_tenant_mismatch',
  /** The project lookup is not wired or threw. Fail-closed. */
  'lookup_failed',
] as const;
export type ApprovalsWsRefusalReason = (typeof APPROVALS_WS_REFUSAL_REASONS)[number];

const key = (s: ApprovalsWsRefusalSurface, r: ApprovalsWsRefusalReason): string => `${s}|${r}`;

const refusals = new Map<string, number>();
function zeroAll(): void {
  for (const s of APPROVALS_WS_REFUSAL_SURFACES) {
    for (const r of APPROVALS_WS_REFUSAL_REASONS) refusals.set(key(s, r), 0);
  }
}
zeroAll();

export interface ApprovalsWsRefusalDetail {
  surface: ApprovalsWsRefusalSurface;
  reason: ApprovalsWsRefusalReason;
  /** Log-only. */
  userId?: string | null;
  /** Log-only. The socket's resolved tenant, when there is one. */
  tenantId?: string | null;
  /** Log-only. The project id the client asked for. */
  target?: string | null;
}

export function reportApprovalsWsRefusal(d: ApprovalsWsRefusalDetail): void {
  const k = key(d.surface, d.reason);
  refusals.set(k, (refusals.get(k) ?? 0) + 1);
  console.warn(
    JSON.stringify({
      telemetry: 'approvals_ws_refused',
      surface: d.surface,
      reason: d.reason,
      user_id: d.userId ?? null,
      tenant_id: d.tenantId ?? null,
      target: d.target ?? null,
    }),
  );
}

export function renderApprovalsWsRefusalMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_approvals_ws_refused_total Approvals WebSocket upgrades/subscribes refused by the tenant gate (fr row 14d-0b), by surface and reason.',
    '# TYPE fr_approvals_ws_refused_total counter',
  ];
  for (const s of APPROVALS_WS_REFUSAL_SURFACES) {
    for (const r of APPROVALS_WS_REFUSAL_REASONS) {
      lines.push(
        `fr_approvals_ws_refused_total{surface="${s}",reason="${r}"} ${refusals.get(key(s, r)) ?? 0}`,
      );
    }
  }
  return lines;
}

