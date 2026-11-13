// src/lib/net/wsClient.ts
// Tiny primitive for opening an authenticated WebSocket without leaking the
// JWT into the URL query string (which would surface in browser history,
// access logs, CSP reports, and referer-style logs).
//
// The browser WebSocket constructor doesn't support custom headers, so the
// industry-standard escape hatch is to encode the token as a subprotocol:
//   new WebSocket(url, [`bearer.${jwt}`])
// The server reads it from `Sec-WebSocket-Protocol` on the upgrade request
// and MUST echo back the matched protocol in the 101 response, otherwise
// the browser fails the handshake with close code 1006.
//
// This module is deliberately small — it's a primitive used by the larger
// WebSocketClient / KanbanSocket clients, not a replacement for them.

/** Compute `wss?://host${path}` (no token!). SSR-safe fallback to ws://localhost. */
export function buildWsUrl(path: string): string {
  if (typeof window === 'undefined' || !window.location) {
    return `ws://localhost${path}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

/** Build the Sec-WebSocket-Protocol subprotocol list that carries the JWT. */
export function buildSubprotocols(token: string): string[] {
  return [`bearer.${token}`];
}
