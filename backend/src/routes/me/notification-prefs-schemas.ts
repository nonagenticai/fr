// src/routes/me/notification-prefs-schemas.ts
//
// The `PUT /api/me/notification-prefs` body schema, side-effect free (zod and the
// event-type vocabulary only) so the route (routes/me/notification-prefs.ts) and
// its capability declaration (fr-agui P4b part 3, capabilities/account/notifications.ts)
// share ONE schema.
import { z } from 'zod';

import { ExecutionEventTypeSchema, NOTIFICATION_CHANNELS } from '../../domain/engagement/event-types';

export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS as unknown as [string, ...string[]]);

export const PrefRowSchema = z.object({
  event_type: ExecutionEventTypeSchema,
  channel: NotificationChannelSchema,
  enabled: z.boolean(),
});

export const ReplaceBodySchema = z.object({
  prefs: z.array(PrefRowSchema),
});
