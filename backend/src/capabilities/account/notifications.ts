// fr-agui SPEC §13 P4b (part 3) — spec drain: the caller's project-execution
// notification inbox `/api/me/notifications` (routes/me/notifications.ts) and its
// per-type preferences `/api/me/notification-prefs` (routes/me/notification-prefs.ts),
// re-expressed with NO behaviour change (`legacyHandler`).
//
// Gate: validateAuth only (its doors): `isAuthenticatedUser`. Every read and write
// is keyed by the caller's own id; there is no admin surface.
import { z } from 'zod';

import { ExecutionEventTypeSchema } from '../../domain/engagement/event-types';
import { NotificationChannelSchema, ReplaceBodySchema } from '../../routes/me/notification-prefs-schemas';
import { isAuthenticatedUser } from '../rbac-rules';
import { isoTime, pathId, routeRule, settingsCapabilities, standardResponses } from './_shared';

/** A `notifications` row as `jsonResponse` serialises it. */
const notification = z.object({
  id: z.string(),
  tenant_id: z.string(),
  user_id: z.string(),
  event_type: z.string(),
  severity: z.string().describe('info | success | warning | error'),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  project_id: z.string().nullable(),
  card_id: z.string().nullable(),
  execution_id: z.string().nullable(),
  source: z.string(),
  correlation_id: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  read_at: isoTime.nullable(),
  created_at: isoTime,
});

/** One (event type × channel) cell of the preference matrix (stored over the code defaults). */
const matrix = z.object({
  data: z.array(
    z.object({
      event_type: ExecutionEventTypeSchema,
      channel: NotificationChannelSchema,
      enabled: z.boolean(),
      is_default: z.boolean().describe('true: no stored preference, the code default applies.'),
    }),
  ),
});

export const MY_NOTIFICATION_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Notifications', tenancy: 'self',
    module: 'src/routes/me/notifications.ts', load: () => import('../../routes/me/notifications'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.list_notifications', method: 'GET', path: '/api/me/notifications', handler: 'handleListMyNotifications',
      summary: "The caller's notifications, newest first", effect: 'read',
      input: z.object({
        status: z.string().optional().describe("'unread': only unread ones; anything else (or absent): all."),
        limit: z.string().optional().describe('Rows: default 50, clamped to 1-200; a non-numeric value is the default (never a 400).'),
      }),
      output: z.object({ data: z.array(notification) }),
      responses: standardResponses(),
    },
    {
      id: 'me.count_unread_notifications', method: 'GET', path: '/api/me/notifications/unread-count', handler: 'handleMyNotificationsUnreadCount',
      summary: "How many of the caller's notifications are unread (the badge)", effect: 'read',
      input: z.object({}), output: z.object({ data: z.object({ count: z.number().int() }) }), responses: standardResponses(),
    },
    {
      id: 'me.mark_all_notifications_read', method: 'POST', path: '/api/me/notifications/read-all', handler: 'handleMarkAllMyNotificationsRead',
      summary: "Mark every unread notification of the caller read", effect: 'write',
      input: z.object({}), output: z.object({ data: z.object({ marked: z.number().int() }) }), responses: standardResponses(),
    },
    {
      id: 'me.mark_notification_read', method: 'POST', path: '/api/me/notifications/:id/read', handler: 'handleMarkMyNotificationRead',
      summary: 'Mark one of the caller\'s notifications read', effect: 'write',
      input: z.object({ id: pathId('Notification id (uuid)') }),
      output: z.object({ success: z.literal(true), message: z.string() }),
      responses: standardResponses("404: `error` 'Notification not found' (absent, another user's, or not a uuid). "),
    },
  ],
);

export const MY_NOTIFICATION_PREF_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Notifications', tenancy: 'self',
    module: 'src/routes/me/notification-prefs.ts', load: () => import('../../routes/me/notification-prefs'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.get_notification_prefs', method: 'GET', path: '/api/me/notification-prefs', handler: 'handleListMyNotificationPrefs',
      summary: "The caller's full notification preference matrix (event type × channel)", effect: 'read',
      input: z.object({}), output: matrix, responses: standardResponses(),
    },
    {
      id: 'me.replace_notification_prefs', method: 'PUT', path: '/api/me/notification-prefs', handler: 'handleReplaceMyNotificationPrefs',
      summary: "Replace the caller's explicit notification preferences; answers the merged matrix", effect: 'write',
      input: ReplaceBodySchema, output: matrix,
      responses: standardResponses("422: `error` 'Validation error' (the body fails the schema; `details`). 400: `error` 'invalid JSON body'. "),
    },
  ],
);
