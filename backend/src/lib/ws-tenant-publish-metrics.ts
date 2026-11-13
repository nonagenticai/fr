// src/lib/ws-tenant-publish-metrics.ts
//
// fr row 14d-2 — a WebSocket event that was NOT published because fr could not
// tell which tenant it belongs to.
//
// Since 14d-2 every kanban and approvals event is published ONLY to the
// per-tenant channel of the event's own tenant (`kanban:tenant:<id>`,
// `approvals:tenant:<id>`; the card's board tenant, the approval's tenant_id,
// the report's tenant_id). There is no cross-tenant firehose left, so an event
// whose tenant cannot be derived has nowhere safe to go: it is DROPPED (fail
// closed) and counted here. Live UIs degrade to their next refresh for those.
//
// Shape copied from lib/active-tenant-header-metrics.ts: closed label sets,
// pre-seeded to zero, increment-only, render for routes/metrics.ts.
// No tenant/board/card label (unbounded).

export const WS_PUBLISH_CHANNELS = ['kanban', 'approvals'] as const;
export type WsPublishChannel = (typeof WS_PUBLISH_CHANNELS)[number];

export const WS_PUBLISH_DROP_REASONS = [
  /** The event carries no board/card (kanban) or no tenant_id (approvals/reports). */
  'event_has_no_scope',
  /** The board/card resolved to no fr tenant (ad-hoc board, unknown card). */
  'tenant_unresolved',
  /** The tenant lookup threw (DB / Planka). */
  'lookup_failed',
  /** No resolver wired (server.ts never called setKanbanTenantResolver). */
  'resolver_unset',
] as const;
export type WsPublishDropReason = (typeof WS_PUBLISH_DROP_REASONS)[number];

const key = (c: WsPublishChannel, r: WsPublishDropReason): string => `${c}|${r}`;
const dropped = new Map<string, number>();
function zeroAll(): void {
  for (const c of WS_PUBLISH_CHANNELS) for (const r of WS_PUBLISH_DROP_REASONS) dropped.set(key(c, r), 0);
}
zeroAll();

/** Count one dropped publish and log it. Never throws. */
export function recordWsPublishDropped(args: {
  channel: WsPublishChannel;
  reason: WsPublishDropReason;
  eventType: string;
  scope?: string | null;
}): void {
  const k = key(args.channel, args.reason);
  dropped.set(k, (dropped.get(k) ?? 0) + 1);
  try {
    console.warn(
      '[ws-publish-dropped]',
      JSON.stringify({
        event: 'ws_publish_dropped',
        channel: args.channel,
        reason: args.reason,
        event_type: args.eventType,
        scope: args.scope ?? null,
      }),
    );
  } catch {
    /* telemetry never changes the outcome */
  }
}

export function renderWsPublishDroppedMetrics(): string[] {
  const lines = [
    '# HELP fr_ws_publish_dropped_total WebSocket events fr did not publish because their tenant could not be derived (fr row 14d-2: per-tenant channels only, fail closed).',
    '# TYPE fr_ws_publish_dropped_total counter',
  ];
  for (const c of WS_PUBLISH_CHANNELS) {
    for (const r of WS_PUBLISH_DROP_REASONS) {
      lines.push(`fr_ws_publish_dropped_total{channel="${c}",reason="${r}"} ${dropped.get(key(c, r)) ?? 0}`);
    }
  }
  return lines;
}
