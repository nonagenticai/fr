// src/lib/kanban-ws-refusal-metrics.ts
//
// ⛔ WHAT THIS COUNTS: a kanban WebSocket upgrade or subscribe that fr REFUSED
// (fr row 14d-0b).
//
// Before 14d-0b every `/api/kanban/ws` connection was auto-subscribed to
// `kanban:all`, which carries every tenant's card events, and every client
// `subscribe` frame was honoured unchecked. The fix admits kanban topics only
// for a `kind:'kanban'` socket whose resolved active tenant is a PLATFORM
// tenant. A refused subscribe is answered with a `subscribe_refused` frame the
// shipped frontend ignores, so without this counter a customer whose board
// stopped updating live is a non-event. Same mechanism as
// `board-tenant-gate-metrics.ts`: closed label sets, pre-seeded to zero,
// increment-only, one structured log line per refusal. Tenant and user ids are
// LOG-ONLY, never labels.
//
// Lives in `lib/` and imports nothing, so the hermetic websocket unit tests can
// import its callers with no database.

export const KANBAN_WS_REFUSAL_SURFACES = [
  /** The `/api/kanban/ws` upgrade itself (no resolvable tenant). */
  'upgrade',
  /** `{type:'subscribe', kanbanAll:true}` — the cross-tenant broadcast. */
  'subscribe_all',
  /** `{type:'subscribe', boardId}` — not tenant-scoped (any id is accepted). */
  'subscribe_board',
  /** `{type:'subscribe', cardId}` — not tenant-scoped (any id is accepted). */
  'subscribe_card',
] as const;
export type KanbanWsRefusalSurface = (typeof KANBAN_WS_REFUSAL_SURFACES)[number];

export const KANBAN_WS_REFUSAL_REASONS = [
  /** The connection's active tenant resolved, but is not in PLATFORM_TENANT_IDS. *
   * RETIRED by fr row 14d-2 (per-tenant channels admit every tenant to its
   * OWN channel); kept pre-seeded so the series does not vanish. */
  'tenant_not_platform',
  /** The connection carries no resolvable tenant. Fail-closed. */
  'tenant_unresolved',
  /** A kanban topic requested on a non-kanban socket (e.g. /api/approvals/ws). */
  'not_kanban_socket',
  /**
   * fr row 14d-2: a board/card topic whose board/card does not belong to the
   * socket's own tenant (another tenant's, or unresolvable). Fail-closed.
   */
  'scope_tenant_mismatch',
  /** fr row 14d-2: the board/card → tenant lookup threw. Fail-closed. */
  'lookup_failed',
  /** fr row 14d-2: no board/card → tenant resolver wired. Fail-closed. */
  'resolver_unset',
] as const;
export type KanbanWsRefusalReason = (typeof KANBAN_WS_REFUSAL_REASONS)[number];

const key = (s: KanbanWsRefusalSurface, r: KanbanWsRefusalReason): string => `${s}|${r}`;

const refusals = new Map<string, number>();
function zeroAll(): void {
  for (const s of KANBAN_WS_REFUSAL_SURFACES) {
    for (const r of KANBAN_WS_REFUSAL_REASONS) refusals.set(key(s, r), 0);
  }
}
zeroAll();

export interface KanbanWsRefusalDetail {
  surface: KanbanWsRefusalSurface;
  reason: KanbanWsRefusalReason;
  /** Log-only. */
  userId?: string | null;
  /** Log-only. The resolved active tenant, when there is one. */
  tenantId?: string | null;
  /** Log-only. The board/card id the client asked for. */
  target?: string | null;
}

export function reportKanbanWsRefusal(d: KanbanWsRefusalDetail): void {
  const k = key(d.surface, d.reason);
  refusals.set(k, (refusals.get(k) ?? 0) + 1);
  console.warn(
    JSON.stringify({
      telemetry: 'kanban_ws_refused',
      surface: d.surface,
      reason: d.reason,
      user_id: d.userId ?? null,
      tenant_id: d.tenantId ?? null,
      target: d.target ?? null,
    }),
  );
}

export function renderKanbanWsRefusalMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_kanban_ws_refused_total Kanban WebSocket upgrades/subscribes refused by the platform-tenant gate (fr row 14d-0b), by surface and reason.',
    '# TYPE fr_kanban_ws_refused_total counter',
  ];
  for (const s of KANBAN_WS_REFUSAL_SURFACES) {
    for (const r of KANBAN_WS_REFUSAL_REASONS) {
      lines.push(
        `fr_kanban_ws_refused_total{surface="${s}",reason="${r}"} ${refusals.get(key(s, r)) ?? 0}`,
      );
    }
  }
  return lines;
}
