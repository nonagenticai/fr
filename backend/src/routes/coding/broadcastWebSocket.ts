// src/routes/coding/broadcastWebSocket.ts
//
// Namespaced Stack-2 container-lifecycle broadcast surface:
// /api/coding/broadcast/ws/:container.
//
// This is the CONSUMER side of the coding-realtime broadcast pipeline (D9 gave
// it a publish endpoint; D2 gave it cross-replica fan-out). Nothing in fr
// subscribed before — so container-lifecycle events (created / running /
// stopped / health) were published to nobody. This proxy subscribes fr clients
// to a container's broadcasts via the gateway's WebSocket route
// (coding-gateway `/api/broadcast/subscribe` → coding-realtime).
//
// Forwards `x-tenant-id`/`x-user-id` identity headers (never the END USER's
// bearer — S6/S8) plus fr's own service licence, and translates the upstream
// 1008 policy close into the typed NO_CONTAINER frame the frontend classifier
// treats as terminal. The service credential is mandatory on this hop: a
// browser cannot set Authorization on a WebSocket handshake, so the gateway can
// only authenticate the proxy by fr's own licence.

import { validateAuth } from '../../middleware/auth';
import { config } from '../../config';
import type { User } from '../../types/api';
import { extractWsBearerToken } from '../../utils/wsAuth';
import { attachCodingServiceCredential } from '../../integrations/_lib/service-credential';

/** Client `/api/coding/broadcast/ws/:container` upgrade paths. */
export const CODING_BROADCAST_WS_PATTERN = /^\/api\/coding\/broadcast\/ws\/[^/]+$/;

/**
 * Validate auth for broadcast WebSocket upgrade requests. Returns the
 * authenticated user; the caller stashes identity on
 * ws.data so `handleBroadcastOpen` forwards `x-tenant-id`/`x-user-id` to the
 * upstream gateway proxy.
 */
export async function validateBroadcastWebSocketAuth(
  req: Request,
  preExtractedToken: string | null = null,
): Promise<User> {
  const token = preExtractedToken ?? extractWsBearerToken(req).token;
  if (token) {
    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${token}`);
    req = new Request(req, { headers });
  }
  return await validateAuth(req);
}

/** Active proxy connections from client WS to the gateway broadcast WS. */
const proxyConnections = new Map<any, WebSocket>();

/** Client → gateway (subscription filter updates, pings). */
export function handleBroadcastMessage(ws: any, message: string | Buffer) {
  const upstream = proxyConnections.get(ws);
  if (upstream && upstream.readyState === WebSocket.OPEN) {
    upstream.send(typeof message === 'string' ? message : message.toString());
  }
}

/**
 * Translate the upstream 1008 policy close (bad tenant / unknown container)
 * into the same NO_CONTAINER frame contract the frontend classifier treats as
 * terminal, so the client renders "no active container" rather than looping its
 * reconnect backoff.
 */
export function handleUpstreamClose(
  ws: any,
  event: { code: number; reason?: string },
  opts: { containerName?: string } = {},
) {
  if (event.code === 1008) {
    console.warn('[broadcast-ws] upstream-1008', {
      containerName: opts.containerName,
      reason: event.reason,
    });
    if (ws.readyState === 1) {
      try {
        ws.send(
          JSON.stringify({ type: 'error', code: 'NO_CONTAINER', message: 'No active container' }),
        );
      } catch {
        // Best-effort frame; suppress send-after-close races.
      }
      ws.close(1008, 'No container');
    }
    return;
  }
  ws.close();
}

/** Establish the proxy connection to the gateway broadcast WS on client open. */
export function handleBroadcastOpen(ws: any) {
  const data = ws.data as
    | {
        kind?: 'broadcast';
        containerName?: string;
        userId?: string;
        tenantId?: string;
        userName?: string;
        userEmail?: string;
      }
    | undefined;
  const containerName = data?.containerName;
  console.log('[broadcast-ws] open', {
    containerName,
    userId: data?.userId,
    tenantId: data?.tenantId,
  });

  if (!containerName) {
    if (ws.readyState === 1) {
      try {
        ws.send(
          JSON.stringify({ type: 'error', code: 'NO_CONTAINER', message: 'No active container' }),
        );
      } catch {
        // Best-effort frame.
      }
      ws.close(1008, 'No container');
    }
    return;
  }

  const gatewayUrl = new URL(config.services.codingGateway);
  // coding-gateway proxies /api/broadcast/subscribe (WS) to coding-realtime.
  // The subscribe endpoint requires connection_id + container_name as QUERY
  // params (coding-realtime reads the container from the query), and a tenant
  // via the X-Tenant-Id header (forwarded by the gateway). We NEVER forward the
  // END USER's bearer on the coding hop (S6/S8) — fr's own licence, below, is a
  // different credential and a different question.
  const upstreamHeaders: Record<string, string> = {};
  if (data?.tenantId) upstreamHeaders['x-tenant-id'] = data.tenantId;
  if (data?.userId) upstreamHeaders['x-user-id'] = data.userId;
  if (data?.userName) upstreamHeaders['x-user-name'] = data.userName;
  if (data?.userEmail) upstreamHeaders['x-user-email'] = data.userEmail;
  // fr's own licence — see the file header. NOT the end user's bearer: the
  // comment above still holds, and a browser cannot set one on a handshake
  // anyway, which is precisely why the proxy has to prove its own identity.
  attachCodingServiceCredential(upstreamHeaders);

  const connectionId = crypto.randomUUID();
  const query = new URLSearchParams({
    connection_id: connectionId,
    container_name: containerName,
  });
  const upstream = new WebSocket(
    `ws://${gatewayUrl.host}/api/broadcast/subscribe?${query.toString()}`,
    { headers: upstreamHeaders },
  );

  proxyConnections.set(ws, upstream);

  // gateway → client
  upstream.addEventListener('message', (event) => {
    if (ws.readyState === 1) {
      ws.send(event.data);
    }
  });

  upstream.addEventListener('close', (event) => {
    proxyConnections.delete(ws);
    handleUpstreamClose(ws, event, { containerName });
  });

  upstream.addEventListener('error', (err) => {
    console.error('[broadcast-ws] upstream-error', { containerName, err });
    proxyConnections.delete(ws);
    if (ws.readyState === 1) {
      try {
        ws.send(
          JSON.stringify({ type: 'error', code: 'UPSTREAM_ERROR', message: 'Broadcast upstream unavailable' }),
        );
      } catch {
        // Best-effort.
      }
      ws.close();
    }
  });
}

/** Tear down the upstream connection when the client disconnects. */
export function handleBroadcastClose(ws: any) {
  const upstream = proxyConnections.get(ws);
  if (upstream) {
    try {
      upstream.close();
    } catch {
      // Best-effort.
    }
    proxyConnections.delete(ws);
  }
}
