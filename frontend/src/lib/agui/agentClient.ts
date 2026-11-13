/**
 * Plan 3 — High-level client for `/api/agent/chat`.
 *
 * Wraps `streamNdjson` to:
 *  - attach an agent session bearer (auto-issued/refreshed via `agentSession`)
 *  - on 401, refresh the agent session ONCE and retry the call
 *  - type the events as `AgentChatEvent`
 */

import { agentSession } from '../stores/agentSession.svelte';
import { ensureFreshToken } from '$lib/services/keycloak';
import { streamNdjson } from './streamClient';
import type { AgentChatEvent, ChatRequest } from './types';

const ENDPOINT = '/api/agent/chat';

/**
 * worker_management#316: the assistant can use the tenant's own BYO key only
 * when the SIGNED-IN USER's portal token rides along. The agent session token
 * (HS256, aud=fr-agent) cannot prove the tenant, so the Keycloak access token
 * goes next to it in `X-End-User-Token`. fr-backend verifies it (same user,
 * same tenant), keeps it only for this request and forwards it to WM; it is
 * never stored server-side. No Keycloak session ⇒ no header, and WM answers
 * with its own BYO error instead of silently using another key.
 */
export const END_USER_TOKEN_HEADER = 'X-End-User-Token';

/**
 * fr-agui SPEC §5.7 (P1b): also sent on the `/api/agui/threads` calls, whose
 * project READ gate gives a super-admin the `GET /api/projects/:id` answer only
 * when the SIGNED realm role rides along (the agent token carries none).
 */
export async function endUserHeaders(): Promise<Record<string, string>> {
  const tok = await ensureFreshToken(240).catch(() => undefined);
  return tok ? { [END_USER_TOKEN_HEADER]: `Bearer ${tok}` } : {};
}

/**
 * POST a user message and yield the resulting NDJSON event stream.
 * Suitable for use as `for await (const ev of chatStream(...)) ...`.
 */
export async function* chatStream(
  body: ChatRequest,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<AgentChatEvent> {
  let token = await agentSession.getAccessToken();
  let attempt = 0;
  // Single retry on 401 — the streamClient surfaces a server-emitted error
  // event with code 'internal_error' on a 401, and the response itself has
  // status 401. We probe the status by issuing a HEAD-equivalent: in
  // practice we call the same endpoint and inspect the first event. If
  // that event is type 'error' with the specific message, force a refresh.
  // For simplicity, wrap the iterator and if the first event is an
  // unauthorized error, refresh once and start a fresh iterator.
  while (attempt < 2) {
    let yieldedAny = false;
    let unauthorizedSeen = false;
    for await (const ev of streamNdjson<AgentChatEvent>(
      ENDPOINT,
      body,
      { bearerToken: token, signal: options.signal, headers: await endUserHeaders() },
    )) {
      if (
        !yieldedAny &&
        ev.type === 'error' &&
        ev.message.toLowerCase().includes('agent access token')
      ) {
        unauthorizedSeen = true;
        break;
      }
      yieldedAny = true;
      yield ev;
    }
    if (!unauthorizedSeen) return;
    attempt += 1;
    if (attempt >= 2) break;
    // Retry once with a freshly-refreshed token.
    agentSession.active = null;
    token = await agentSession.getAccessToken();
  }
  // The refreshed token was rejected too. Returning normally here would end the
  // stream with zero events and the caller would record the turn as succeeded.
  throw new Error('agent access token rejected after refresh');
}
