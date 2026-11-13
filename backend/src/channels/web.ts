// E-7: Web (FR chat-box) inbound channel.
//
// Two ingress paths:
//
// 1. **AG-UI thread API** (primary, browser frontend) — POST /api/agui/threads
//    authenticated by FR-issued agent JWT (HS256, aud=fr-agent). The frontend
//    `stores/threads.svelte.ts` writes here directly.
//
// 2. **Webhook injection** (parseWebhook in this file) — for non-frontend
//    clients (n8n workflows, scripts, mobile relays without an agent JWT)
//    that need to inject a user-attributed message into an existing AG-UI
//    thread. Authenticated via the shared `N8N_WEBHOOK_SECRET` (same
//    pattern as scheduled-reports' validateInternalSecret). Body shape:
//        { user_id: <uuid>, text: <string>, session_id?: <string>,
//          worker_name?: <string> }
//    parseWebhook upserts the agent_runtime_sessions row, appends a
//    `{role:'user', content:text}` ConversationMessage, then returns
//    InboundMessage so the channel dispatcher continues normal routing.

import { db } from '../db/client';
import { agentRuntimeSessions } from '../db/schema';
import { appendMessage } from '../agent/session-store';
import { config } from '../config';
import { isAuthorizedBySharedSecret } from '../utils/webhook-secret';
import { wsManager } from '../domain/engagement/adapters/websocket';
import type { ChannelInbound, InboundMessage } from './index';
import type { ChannelMessage } from '../domain/engagement/notifications';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const webChannel: ChannelInbound = {
  name: 'web',

  /**
   * Webhook injection path (see header). Returns null on auth failure,
   * malformed body, or invalid user_id — caller (channels router) maps
   * null to a 4xx without leaking which check failed.
   */
  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    // Auth: shared webhook secret. An unset secret used to skip the check
    // entirely in EVERY environment; it is now skipped only outside production,
    // so blanking or rotating N8N_WEBHOOK_SECRET breaks this channel loudly
    // instead of silently opening it. `validateProductionConfig` already
    // requires that var at boot, so in a correctly-configured prod deploy the
    // fail-closed branch is unreachable — it exists for the deploys where that
    // boot guard is inert, which is exactly when this would otherwise be open.
    if (
      !isAuthorizedBySharedSecret({
        secret: config.services.n8n.webhookSecret,
        provided: req.headers.get('X-Webhook-Secret'),
        envVarName: 'N8N_WEBHOOK_SECRET',
        receiver: 'channels/web',
      })
    ) {
      return null;
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }
    if (!body || typeof body !== 'object') return null;
    const b = body as {
      user_id?: unknown;
      text?: unknown;
      session_id?: unknown;
      worker_name?: unknown;
    };
    if (typeof b.user_id !== 'string' || !UUID_RE.test(b.user_id)) return null;
    if (typeof b.text !== 'string' || b.text.length === 0) return null;
    const userId = b.user_id;
    const text = b.text;
    const threadId = typeof b.session_id === 'string' ? b.session_id : '';
    const workerName =
      typeof b.worker_name === 'string' && b.worker_name.length > 0
        ? b.worker_name
        : 'fr-agent-default';
    const correlationId = crypto.randomUUID();

    // Upsert thread row to get a stable id; the (user_id, channel,
    // thread_id) triple is unique. Then defer the message append to
    // session-store.appendMessage which uses Postgres-side `||` jsonb
    // concat — race-safe under concurrent webhooks for the same thread.
    const inserted = await db
      .insert(agentRuntimeSessions)
      .values({
        user_id: userId,
        channel: 'web',
        thread_id: threadId,
        worker_name: workerName,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .onConflictDoUpdate({
        target: [
          agentRuntimeSessions.user_id,
          agentRuntimeSessions.channel,
          agentRuntimeSessions.thread_id,
        ],
        set: { updated_at: new Date() },
      })
      .returning({ id: agentRuntimeSessions.id });
    const row = inserted[0];
    if (!row) return null;

    await appendMessage(row.id, {
      role: 'user',
      content: text,
      ts: new Date().toISOString(),
    });

    return {
      channel: 'web',
      userId,
      address: userId,
      text,
      correlationId,
      raw: body,
    };
  },

  async postReply(_threadId: string | undefined, message: ChannelMessage): Promise<void> {
    // The web channel is broadcast-only at the transport layer (no per-thread
    // routing yet). Address is unused by websocket-manager.sendMessage.
    await wsManager.sendMessage('', message);
  },
};
