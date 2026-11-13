// src/routes/inapp-messages.ts
// E-10: in-app chat history endpoints.
//
//   POST /api/inapp/messages         — accept inbound chat from the FR web
//                                       client; routes through the channel
//                                       dispatcher when enabled, otherwise
//                                       persists the message and 202s.
//   GET  /api/inapp/messages?limit=N — return the caller's most-recent N
//                                       persisted messages (default 50,
//                                       capped at 200).
import { db, inappMessages } from '../db/client';
import { eq, desc } from 'drizzle-orm';
import { jsonResponse } from '../utils/response';
import { clientSafeCaughtErrorText } from '../integrations/_lib/errors';
import { validateAuth } from '../middleware/auth';
import { channelDispatcher } from '../channels';
import { tryGetRequestContext } from '../middleware/request-context';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * POST /api/inapp/messages
 * Body: { userId, text, threadId?, correlationId? }.
 * The dispatcher (when enabled) handles intent + reply. When disabled we
 * still want to persist the inbound row so chat history remains accurate;
 * the channel adapter does that itself in its parseWebhook path so we just
 * 202 here when dispatcher returns null.
 */
export async function handleInAppPostMessage(req: Request): Promise<Response> {
  // Auth gates writes to the user's chat history. The body is the source of
  // truth for `userId` (the dispatcher needs it without a Keycloak hop), but
  // we cross-check that the authenticated user matches.
  let user;
  try {
    user = await validateAuth(req);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : 'unauthorized' },
      401,
    );
  }

  // Clone before handing to the dispatcher — we may need to read the body
  // again if dispatcher returns null.
  const cloned = req.clone() as unknown as Request;
  let bodyJson: any = null;
  try {
    bodyJson = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  if (bodyJson?.userId && bodyJson.userId !== user.id) {
    return jsonResponse({ error: 'userId does not match authenticated user' }, 403);
  }

  // The in-app chat box acts in the web SESSION's active workspace (the request
  // frame's tenant, `X-Active-Tenant` rules), never a channel-membership pick
  // (fr-agui SPEC §6.5 applies the membership rule to EXTERNAL channels only).
  const sessionTenantId = tryGetRequestContext()?.tenantId || undefined;
  const dispatched = await channelDispatcher.handleWebhook(
    'inapp',
    cloned,
    sessionTenantId ? { sessionTenant: { id: sessionTenantId } } : undefined,
  );
  if (dispatched) return dispatched;

  // Dispatcher disabled — persist the inbound row directly so chat history
  // is preserved. Mirrors the dispatcher's parseWebhook side effect.
  const text = typeof bodyJson?.text === 'string' ? bodyJson.text : '';
  if (!text) return jsonResponse({ error: 'text is required' }, 400);

  try {
    await db.insert(inappMessages).values({
      user_id: user.id,
      direction: 'inbound',
      text,
      correlation_id: typeof bodyJson?.correlationId === 'string'
        ? bodyJson.correlationId
        : null,
      meta_json: bodyJson?.threadId ? { threadId: bodyJson.threadId } : null,
    });
  } catch (err) {
    // Raw Postgres text is for super-admins only; everyone else gets fr's word.
    console.error('[POST /api/inapp/messages] insert failed', err);
    return jsonResponse({ error: clientSafeCaughtErrorText(err, 'db error') }, 500);
  }
  return jsonResponse({ received: true }, 202);
}

/**
 * GET /api/inapp/messages?limit=N
 * Returns up to N most-recent persisted messages for the authenticated user
 * (newest first).
 */
export async function handleInAppListMessages(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : 'unauthorized' },
      401,
    );
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }

  const rows = await db
    .select()
    .from(inappMessages)
    .where(eq(inappMessages.user_id, user.id))
    .orderBy(desc(inappMessages.created_at))
    .limit(limit);

  return jsonResponse({ messages: rows });
}
