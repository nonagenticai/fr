/**
 * Kanban WebSocket — heartbeat + liveness tracking.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
 *   §"Kanban liveness: backend-driven heartbeat over the existing WS"
 *   §"Backend" — heartbeat broadcast, ack handler, per-subscription lag
 *
 * The existing `wsManager` (domain/engagement/adapters/websocket.ts) already owns the
 * kanban WS upgrade + subscribe/unsubscribe paths. Rather than fork a
 * parallel WS server (which would also fork the kanban event pub/sub), this
 * module hooks into the existing socket lifecycle from `server.ts`:
 *
 *   - registerKanbanSocket(ws)   — called from the WS open handler
 *   - handleKanbanInbound(ws, m) — called from the WS message handler;
 *                                  returns true if the frame was a
 *                                  `kanban:heartbeat_ack` (consumed),
 *                                  false to fall through.
 *   - unregisterKanbanSocket(ws) — called from the WS close handler.
 *
 * Heartbeats: a single 15s timer broadcasts
 * `{type: "kanban:heartbeat", event: {seq, ts}}` to every registered
 * socket. Subscribers reply with
 * `{type: "kanban:heartbeat_ack", event: {seq}}`; we record the ack ts
 * against the subscriber so `getKanbanLivenessSnapshot()` can compute the
 * max lag for the metrics route + the activity.liveness_status action.
 *
 * Auth: this module does not call validateAuth — `/api/kanban/ws` upgrade
 * in server.ts already validated the token and gave us a userId on
 * `ws.data`. We trust that here.
 */

import type { ServerWebSocket } from 'bun';

const HEARTBEAT_INTERVAL_MS = 15_000;

interface SubscriberRecord {
  ws: ServerWebSocket<unknown>;
  subscriptionId: string;
  /** Project the subscription is scoped to (currently undefined — clients
   * use `kanbanAll: true`; we keep the field so the gauge can later grow
   * per-project labels without a wire-protocol change). */
  projectId: string | undefined;
  lastBroadcastSeq: number;
  lastAckSeq: number;
  /** Last ack ts in ms; undefined when no ack has been seen yet. */
  lastAckTs: number | undefined;
  /** Connection-open ts in ms — baseline so a fresh socket starts at ~0
   * lag rather than now-vs-1970. Also exposed as `subscribeAt` (same value)
   * so the snapshot helper / future Prom exporter can use the more
   * domain-y name. */
  openedAt: number;
  /** Alias of `openedAt`; the time the subscription was registered. */
  subscribeAt: number;
}

const subscribers = new Map<ServerWebSocket<unknown>, SubscriberRecord>();
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let nextSeq = 1;
let nextSubscriptionId = 1;

function ensureHeartbeatTimer(): void {
  if (heartbeatTimer !== undefined) return;
  heartbeatTimer = setInterval(broadcastHeartbeat, HEARTBEAT_INTERVAL_MS);
  if (typeof (heartbeatTimer as unknown as { unref?: () => void }).unref === 'function') {
    (heartbeatTimer as unknown as { unref: () => void }).unref();
  }
}

function stopHeartbeatTimerIfIdle(): void {
  if (subscribers.size === 0 && heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function broadcastHeartbeat(): void {
  const seq = nextSeq++;
  const ts = Date.now();
  const payload = JSON.stringify({
    type: 'kanban:heartbeat',
    event: { seq, ts },
    timestamp: new Date(ts).toISOString(),
  });
  for (const rec of subscribers.values()) {
    try {
      rec.ws.send(payload);
      rec.lastBroadcastSeq = seq;
    } catch {
      // Send failure means the socket is dead — drop it on the next tick.
    }
  }
}

export function registerKanbanSocket(
  ws: ServerWebSocket<unknown>,
  opts: { projectId?: string } = {},
): SubscriberRecord {
  const subscribeAt = Date.now();
  const rec: SubscriberRecord = {
    ws,
    subscriptionId: `kws-${nextSubscriptionId++}`,
    projectId: opts.projectId,
    lastBroadcastSeq: 0,
    lastAckSeq: 0,
    lastAckTs: undefined,
    openedAt: subscribeAt,
    subscribeAt,
  };
  subscribers.set(ws, rec);
  ensureHeartbeatTimer();
  return rec;
}

export function unregisterKanbanSocket(ws: ServerWebSocket<unknown>): void {
  subscribers.delete(ws);
  stopHeartbeatTimerIfIdle();
}

/**
 * Returns true if this module consumed the frame (the kanban heartbeat-ack
 * path); false to fall through to the existing wsManager subscribe/
 * unsubscribe handler.
 */
export function handleKanbanInbound(
  ws: ServerWebSocket<unknown>,
  message: string | Buffer,
): boolean {
  let parsed: { type?: unknown; event?: unknown };
  try {
    parsed = JSON.parse(typeof message === 'string' ? message : message.toString());
  } catch {
    return false;
  }
  if (parsed.type !== 'kanban:heartbeat_ack') return false;

  const event = parsed.event as { seq?: unknown } | undefined;
  const seq = typeof event?.seq === 'number' ? event.seq : undefined;
  if (seq === undefined) return true; // malformed but we still claim it
  const rec = subscribers.get(ws);
  if (!rec) return true;
  // Out-of-order acks accepted; we only record the highest-seen seq.
  if (seq >= rec.lastAckSeq) {
    rec.lastAckSeq = seq;
    rec.lastAckTs = Date.now();
  }
  return true;
}

export interface KanbanLivenessSnapshot {
  lastBroadcastSeq: number;
  subscribers: number;
  /** Alias of `subscribers` for the user-facing snapshot shape. */
  subscriberCount: number;
  /** Seconds — max(now - lastAckTs) across active subscribers; 0 when none. */
  maxLagSeconds: number;
  /** Milliseconds — max(now - lastAckTs) across active subscribers; 0 when none.
   * Same value as `maxLagSeconds * 1000` but exposed in ms so n8n / Prom
   * exporter side can avoid the float-precision round-trip. */
  oldestLagMs: number;
  /** Per-subscription lag rows for the Prom gauge / debugging. */
  perSubscriber: Array<{
    subscriptionId: string;
    projectId: string | undefined;
    lagMs: number;
  }>;
  /** Per-subscription rows for the Prom gauge (legacy seconds shape). */
  subscriptionLags: Array<{
    subscriptionId: string;
    projectId: string | undefined;
    lagSeconds: number;
  }>;
}

export function getKanbanLivenessSnapshot(
  projectId?: string,
): KanbanLivenessSnapshot {
  const now = Date.now();
  let maxLagMs = 0;
  let lastSeq = 0;
  const subscriptionLags: KanbanLivenessSnapshot['subscriptionLags'] = [];
  const perSubscriber: KanbanLivenessSnapshot['perSubscriber'] = [];
  let count = 0;
  for (const rec of subscribers.values()) {
    if (projectId !== undefined && rec.projectId !== projectId) continue;
    count++;
    if (rec.lastBroadcastSeq > lastSeq) lastSeq = rec.lastBroadcastSeq;
    const reference = rec.lastAckTs ?? rec.openedAt;
    const lagMs = Math.max(0, now - reference);
    if (lagMs > maxLagMs) maxLagMs = lagMs;
    subscriptionLags.push({
      subscriptionId: rec.subscriptionId,
      projectId: rec.projectId,
      lagSeconds: lagMs / 1000,
    });
    perSubscriber.push({
      subscriptionId: rec.subscriptionId,
      projectId: rec.projectId,
      lagMs,
    });
  }
  return {
    lastBroadcastSeq: lastSeq,
    subscribers: count,
    subscriberCount: count,
    maxLagSeconds: maxLagMs / 1000,
    oldestLagMs: maxLagMs,
    perSubscriber,
    subscriptionLags,
  };
}

