// src/utils/wsAuth.ts
//
// Extracts a Bearer JWT from a WebSocket upgrade Request, preferring
// the secure subprotocol channel and falling back to the legacy patterns
// for transitional compatibility.
//
// Precedence (highest first):
//   1. `Sec-WebSocket-Protocol: bearer.<jwt>` (preferred — never logged in
//      access logs, never in browser history)
//   2. `Authorization: Bearer <jwt>` (also fine — but browsers can't set
//      this header on the WebSocket constructor)
//   3. `?token=<jwt>` query string (DEPRECATED — leaks via access logs,
//      browser history, CSP reports; emits a one-time warning per process)
//
// When the token came via subprotocol, the upgrade response MUST echo back
// `Sec-WebSocket-Protocol: bearer.<jwt>` (or any single accepted protocol)
// or the browser closes the connection with code 1006.

import { statusForError } from './errors';

const PROTOCOL_PREFIX = 'bearer.';

let queryDeprecationWarned = false;

export interface WsBearerExtraction {
  /** The raw JWT string, or null if no auth was found. */
  token: string | null;
  /**
   * The matching `bearer.<jwt>` subprotocol string when (and only when) the
   * token was obtained via `Sec-WebSocket-Protocol`. The caller MUST echo
   * this back as the response's `Sec-WebSocket-Protocol` header during
   * `server.upgrade(...)`, otherwise the handshake fails.
   */
  protocolHeader: string | null;
  /** The source the token was obtained from. */
  source: 'subprotocol' | 'authorization' | 'query' | 'none';
}

/**
 * Resolve the bearer token for a WebSocket upgrade Request, walking the
 * precedence chain above. Pure: no DB / network access.
 */
export function extractWsBearerToken(req: Request): WsBearerExtraction {
  // 1. Sec-WebSocket-Protocol: comma-separated list, find the first
  //    `bearer.<token>` entry.
  const protocolHeader = req.headers.get('Sec-WebSocket-Protocol');
  if (protocolHeader) {
    const entries = protocolHeader.split(',').map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      if (entry.startsWith(PROTOCOL_PREFIX)) {
        const token = entry.slice(PROTOCOL_PREFIX.length);
        if (token.length > 0) {
          return { token, protocolHeader: entry, source: 'subprotocol' };
        }
      }
    }
  }

  // 2. Authorization: Bearer <token>
  const authHeader = req.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) {
      return { token, protocolHeader: null, source: 'authorization' };
    }
  }

  // 3. Legacy ?token=<jwt> — keep working for now, but warn once per
  //    process so we can deprecate the path on the backend later.
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken.length > 0) {
    if (!queryDeprecationWarned) {
      queryDeprecationWarned = true;
      console.warn(
        '[wsAuth] DEPRECATED: WebSocket auth via ?token= query string detected. ' +
        'Migrate clients to Sec-WebSocket-Protocol `bearer.<jwt>` (lib/net/wsClient.ts).',
      );
    }
    return { token: queryToken, protocolHeader: null, source: 'query' };
  }

  return { token: null, protocolHeader: null, source: 'none' };
}

/**
 * The upgrade-refusal Response for a WebSocket route whose token validation
 * THREW.
 *
 * ⚠️ WHY THIS EXISTS. Both WS upgrade handlers in `server.ts` used to end their
 * `catch` with a hard-coded `401 {"error":"Invalid token"}`. That predated
 * `KeycloakService.validateToken` learning to tell "your token is bad" apart
 * from "fr could not reach Keycloak to find out" (see the classification note
 * in `services/keycloak.ts`), and it threw that distinction away one line after
 * it was made: during a Keycloak / Cloudflare-path outage every user holding a
 * perfectly valid token was told their token was invalid, and every client-side
 * "401 => force re-login" flow then drove the whole userbase at the Keycloak
 * that was already down. Exactly the defect fixed inside `validateToken` —
 * still live here, because the caller overwrote the verdict.
 *
 * ⛔ The status comes from `statusForError`, the ONE mapping the HTTP boundary
 * already uses (`handleError` shares it), never from a second `instanceof`
 * ladder here. Two tables of the same mapping is how they drift.
 *
 * ⚠️ FAIL-CLOSED: this function only ever RETURNS a refusal — there is no path
 * through it that admits a caller. It changes which status and message a
 * rejected client sees, never whether it is rejected. The `< 400` clamp is
 * belt-and-braces on that: no code `statusForError` can currently return is
 * below 400, but if one ever were, an upgrade must not become admissible by
 * accident.
 */
export function wsAuthRejectionResponse(err: unknown, route: string): Response {
  const mapped = statusForError(err);
  const status = mapped >= 400 ? mapped : 500;
  // A 401 is the only status that may accuse the TOKEN. Anything else is fr's
  // own dependency failing, and saying "invalid token" there is precisely the
  // lie this change removes.
  const body =
    status === 401
      ? { error: 'Invalid token' }
      : { error: 'Authentication service unavailable' };
  // The old line said "token rejected" unconditionally, which was false for an
  // outage — the token was never judged at all.
  console.warn(
    status === 401
      ? '[ws-auth] token rejected'
      : '[ws-auth] token could not be validated (auth dependency failure)',
    { route, status, err: String(err) },
  );
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
