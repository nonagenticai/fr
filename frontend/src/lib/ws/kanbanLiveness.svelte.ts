// src/lib/ws/kanbanLiveness.svelte.ts
//
// Tiny rune holder for the most recent kanban heartbeat ack timestamp.
//
// Why this is split out from `kanbanSocket.ts`:
//   Svelte 5 runes (`$state`, `$derived`, `$effect`) only work inside `.svelte`
//   and `.svelte.ts` files. `kanbanSocket.ts` is a plain `.ts` module so it
//   can't host a rune-backed reactive value. This module owns the singleton
//   reactive state; `kanbanSocket.ts` writes to it via setLastHeartbeatTs /
//   clearLastHeartbeatTs, and `LivenessBadge.svelte` reads it via
//   getLastHeartbeatTs (which the component re-evaluates on each tick).
//
// Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
//   §"Frontend"  — extend kanbanSocket.ts to expose a `lastHeartbeatTs` rune

let lastHeartbeatTs = $state<number | null>(null);
let socketOpen = $state<boolean>(false);
let socketOpenedAtTs = $state<number | null>(null);

/** Record an inbound `kanban:heartbeat` arrival time (ms since epoch). */
export function setLastHeartbeatTs(ts: number): void {
  lastHeartbeatTs = ts;
}

/** Clear the heartbeat ts — called when the socket closes so the badge flips
 * to "disconnected" without waiting for the lag threshold. */
export function clearLastHeartbeatTs(): void {
  lastHeartbeatTs = null;
}

/** Reactive read; safe to call from .svelte / .svelte.ts files. */
export function getLastHeartbeatTs(): number | null {
  return lastHeartbeatTs;
}

/** Track whether the underlying WebSocket is currently open. The kanban
 * socket calls this with `true` from `onopen` and `false` from `onclose`
 * (and `close()`); the badge uses it to render a `Connecting` state during
 * the gap between socket open and the first `kanban:heartbeat` frame
 * (which can be ~15s — see the 2026-05-02 kanban page-load memo).
 *
 * Also stamps `socketOpenedAtTs` on the false→true transition. That stamp is
 * what BOUNDS the "Connecting" state: without it, an open socket whose peer
 * never sends a heartbeat (e.g. Planka is not deployed, so the backend has
 * nothing to heartbeat about) left the badge on "Connecting" forever, because
 * `lastHeartbeatTs` stays null and nothing else could tell how long it had
 * been null for. `computeLiveness` reads it to expire that state.
 *
 * The stamp is taken on the TRANSITION, not on every call, so a redundant
 * `setSocketOpen(true)` cannot silently restart the deadline and make a
 * never-heartbeating socket look perpetually fresh. It is cleared on close so
 * the next connection gets its own deadline rather than inheriting the
 * previous socket's. */
export function setSocketOpen(v: boolean): void {
  if (v) {
    if (!socketOpen) socketOpenedAtTs = Date.now();
  } else {
    socketOpenedAtTs = null;
  }
  socketOpen = v;
}

/** Reactive read for the current socket-open flag. */
export function getSocketOpen(): boolean {
  return socketOpen;
}

/** Reactive read for when the current socket opened (ms since epoch), or null
 * when no socket is open. Feeds `computeLiveness`'s connecting deadline. */
export function getSocketOpenedAtTs(): number | null {
  return socketOpenedAtTs;
}
