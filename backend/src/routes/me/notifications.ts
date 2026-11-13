// src/routes/me/notifications.ts
//
// WS1 Phase 1A — the per-user project-execution notification inbox. Every read
// and write is scoped to the authed caller's `user.id`; there is no admin
// surface here. The durable rows are written by
// NotificationService.fanOutEventToUser (see domain/engagement/notifications.ts).
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, notifications } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse, successResponse } from '../../utils/response';
import { NotFoundError } from '../../utils/errors';
import { isUuidShape } from '../../lib/uuid-shape';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** GET /api/me/notifications?status=unread|all&limit=N */
export async function handleListMyNotifications(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const where = status === 'unread'
    ? and(eq(notifications.user_id, user.id), isNull(notifications.read_at))
    : eq(notifications.user_id, user.id);

  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.created_at))
    .limit(limit);

  return jsonResponse({ data: rows });
}

/** GET /api/me/notifications/unread-count — cheap badge query (partial index). */
export async function handleMyNotificationsUnreadCount(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.user_id, user.id), isNull(notifications.read_at)));
  return jsonResponse({ data: { count: row?.count ?? 0 } });
}

/** POST /api/me/notifications/:id/read */
export async function handleMarkMyNotificationRead(req: Request, id: string): Promise<Response> {
  const user = await validateAuth(req);
  // `notifications.id` is a `uuid` column (schema.ts:712) — note `user_id` is
  // `text` and is deliberately NOT guarded here. A `:id` that is not UUID-shaped
  // aborts the UPDATE with 22P02 `invalid input syntax for type uuid` rather
  // than matching zero rows, so the handler 500s instead of 404ing. Throw the
  // SAME NotFoundError the zero-rows branch below throws, keeping malformed
  // indistinguishable from another user's notification. `isUuidShape`, not
  // `isValidUuid` (utils/tenant), which pins version/variant and would 404 rows.
  if (!isUuidShape(id)) throw new NotFoundError('Notification not found');
  const updated = await db
    .update(notifications)
    .set({ read_at: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.user_id, user.id)))
    .returning({ id: notifications.id });
  if (updated.length === 0) throw new NotFoundError('Notification not found');
  return successResponse('marked read');
}

/** POST /api/me/notifications/read-all — mark every unread row for the user. */
export async function handleMarkAllMyNotificationsRead(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const updated = await db
    .update(notifications)
    .set({ read_at: new Date() })
    .where(and(eq(notifications.user_id, user.id), isNull(notifications.read_at)))
    .returning({ id: notifications.id });
  return jsonResponse({ data: { marked: updated.length } });
}
