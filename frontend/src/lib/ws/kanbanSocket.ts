// src/lib/ws/kanbanSocket.ts
// WebSocket client for /api/kanban/ws — forwards typed kanban events to
// subscribers, supports board/card topic subscriptions, and auto-reconnects
// with exponential backoff (1s → 2s → 4s → … capped at 30s).
//
// See backend `KanbanEvent` (src/services/websocket-manager.ts) for the
// full set of event kinds.
//
// Liveness heartbeats (n8n-observability slice, 2026-04-24):
//   - Backend pushes `kanban:heartbeat {event: {seq, ts}}` every 15s.
//   - This client replies with `kanban:heartbeat_ack {event: {seq}}` and
//     stamps the receive time into `kanbanLiveness.svelte.ts` so the
//     LivenessBadge component can derive a status without coupling to this
//     module's internals.
//   - Heartbeat frames are intentionally NOT forwarded to user-supplied
//     `onEvent` handlers — kanbanStore consumers shouldn't see them as
//     domain events.

import {
  setLastHeartbeatTs,
  clearLastHeartbeatTs,
  setSocketOpen,
} from '$lib/ws/kanbanLiveness.svelte';
import { buildWsUrl, buildSubprotocols } from '$lib/net/wsClient';

const KANBAN_WS_PATH = '/api/kanban/ws';
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface KanbanEvent {
  /** Event type, always begins with `kanban:` (e.g. `kanban:card_created`). */
  type: string;
  /** Opaque payload keyed by backend `KanbanEvent` variant. */
  event: Record<string, unknown>;
  /** ISO-8601 timestamp the backend published the event. */
  timestamp: string;
}

export type KanbanEventHandler = (event: KanbanEvent) => void;

export interface KanbanSocketOptions {
  /**
   * The session's active tenant, read at every (re)connect.
   *
   * fr row 14d-0b: the backend no longer auto-subscribes anyone to the
   * cross-tenant `kanban:all` broadcast. When this resolves to a PLATFORM
   * tenant the client asks for it explicitly; otherwise it does not, and a
   * customer view refreshes instead of updating live. The value is also sent
   * as the `activeTenant` query parameter — the WebSocket stand-in for the
   * `X-Active-Tenant` header — and the backend accepts it under the same
   * super-admin switch rules as HTTP.
   */
  getActiveTenant: () => string | undefined;
}

/**
 * Source of the bearer JWT, called at EVERY socket open — the first connect and
 * every reconnect. A token captured once at connect time is a ~5-minute
 * Keycloak access token, so a reconnect after it expires would be rejected at
 * upgrade forever. May be async so callers can refresh before handing it over.
 */
export type KanbanTokenGetter = () => string | undefined | Promise<string | undefined>;

type Subscription =
  | { kind: 'board'; boardId: string }
  | { kind: 'card'; cardId: string };

export class KanbanSocket {
  private readonly getActiveTenant: () => string | undefined;

  private getToken: KanbanTokenGetter | null = null;
  // Bumped per openSocket(); an async token read that resolves after a newer
  // open (or a close) compares and drops itself, so we never open two sockets.
  private openGen = 0;
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private handlers = new Set<KanbanEventHandler>();
  private pendingSubs = new Map<string, Subscription>();

  constructor(opts: KanbanSocketOptions) {
    this.getActiveTenant = opts.getActiveTenant;
  }

  /** Open the socket, reading the JWT from `getToken` at each open. Idempotent. */
  connect(getToken: KanbanTokenGetter): void {
    this.getToken = getToken;
    this.closed = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN
      || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closed || !this.getToken) return;
    const gen = ++this.openGen;
    let read: string | undefined | Promise<string | undefined>;
    try {
      read = this.getToken();
    } catch {
      read = undefined;
    }
    if (read instanceof Promise) {
      read.then(
        (token) => this.openWithToken(token, gen),
        () => this.openWithToken(undefined, gen),
      );
    } else {
      this.openWithToken(read, gen);
    }
  }

  private openWithToken(token: string | undefined, gen: number): void {
    // Superseded by a newer open, closed meanwhile, or already connected.
    if (gen !== this.openGen || this.closed || this.socket) return;
    // No token (signed out / refresh failed) — stay closed rather than
    // open an unauthenticated socket.
    if (!token) return;

    // JWT travels via Sec-WebSocket-Protocol (`bearer.<jwt>`), not the URL
    // query string — see lib/net/wsClient.ts for rationale.
    const activeTenant = this.getActiveTenant();
    const url = activeTenant
      ? `${buildWsUrl(KANBAN_WS_PATH)}?activeTenant=${encodeURIComponent(activeTenant)}`
      : buildWsUrl(KANBAN_WS_PATH);
    const protocols = buildSubprotocols(token);

    const ws = new WebSocket(url, protocols);
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // fr row 14d-2: `kanbanAll` now subscribes this socket to its OWN
      // tenant's channel (the backend keys it on the tenant resolved at
      // upgrade), so every session — customer or platform — asks for it and
      // receives only its own tenant's live card events.
      this.sendFrame({ type: 'subscribe', kanbanAll: true });
      // Re-send any subscription frames after a reconnect.
      for (const sub of this.pendingSubs.values()) {
        this.sendSubscribeFrame(sub);
      }
      // Flag the socket open so LivenessBadge can show "Connecting" until
      // the first kanban:heartbeat frame stamps lastHeartbeatTs.
      setSocketOpen(true);
    };

    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string'
        ? ev.data
        : (ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : null);
      if (!raw) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // ignore non-JSON frames
      }
      if (!parsed || typeof parsed !== 'object') return;
      const msg = parsed as { type?: unknown };
      if (typeof msg.type !== 'string') return;
      if (!msg.type.startsWith('kanban:')) return;

      // Heartbeat: stamp + ack, do NOT forward to event handlers.
      if (msg.type === 'kanban:heartbeat') {
        const event = (parsed as { event?: { seq?: unknown } }).event;
        const seq = typeof event?.seq === 'number' ? event.seq : null;
        setLastHeartbeatTs(Date.now());
        if (seq !== null && this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(
            JSON.stringify({ type: 'kanban:heartbeat_ack', event: { seq } }),
          );
        }
        return;
      }

      const payload = parsed as KanbanEvent;
      for (const h of this.handlers) {
        try {
          h(payload);
        } catch (err) {
          // Never let one handler crash the socket.
          console.error('[kanban-ws] handler threw', err);
        }
      }
    };

    ws.onerror = () => {
      // Swallow — browsers log these automatically. Errors lead to onclose.
    };

    ws.onclose = () => {
      this.socket = null;
      // Flip the badge to "disconnected" instantly rather than waiting for the
      // 60s lag threshold to expire on a stale ts.
      clearLastHeartbeatTs();
      setSocketOpen(false);
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempt),
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Subscribe to events scoped to a single board. */
  subscribeBoard(boardId: string): void {
    const key = `board:${boardId}`;
    this.pendingSubs.set(key, { kind: 'board', boardId });
    this.sendSubscribeFrame({ kind: 'board', boardId });
  }

  /** Subscribe to events scoped to a single card. */
  subscribeCard(cardId: string): void {
    const key = `card:${cardId}`;
    this.pendingSubs.set(key, { kind: 'card', cardId });
    this.sendSubscribeFrame({ kind: 'card', cardId });
  }

  /** Remove a previously-registered board subscription. */
  unsubscribeBoard(boardId: string): void {
    this.pendingSubs.delete(`board:${boardId}`);
    this.sendFrame({ type: 'unsubscribe', boardId });
  }

  /** Remove a previously-registered card subscription. */
  unsubscribeCard(cardId: string): void {
    this.pendingSubs.delete(`card:${cardId}`);
    this.sendFrame({ type: 'unsubscribe', cardId });
  }

  private sendSubscribeFrame(sub: Subscription): void {
    if (sub.kind === 'board') {
      this.sendFrame({ type: 'subscribe', boardId: sub.boardId });
    } else {
      this.sendFrame({ type: 'subscribe', cardId: sub.cardId });
    }
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
    // If not open, the pendingSubs map will replay when onopen fires.
  }

  /** Register an event handler. Returns an unsubscribe fn. */
  onEvent(fn: KanbanEventHandler): () => void {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  /** True if the socket is OPEN. */
  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Close the socket and suppress auto-reconnect. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // noop
      }
      this.socket = null;
    }
    this.pendingSubs.clear();
    this.handlers.clear();
    // Intentional close → badge to red immediately. (`onclose` may not fire
    // synchronously in every WS implementation, so we clear here too.)
    clearLastHeartbeatTs();
    setSocketOpen(false);
  }
}
