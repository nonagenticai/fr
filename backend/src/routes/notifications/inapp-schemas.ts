// src/routes/notifications/inapp-schemas.ts
//
// The POST /api/notifications/inapp body (routes/notifications/inapp.ts), shared
// with its fr-agui P4b capability declaration (capabilities/settings/messaging.ts)
// so the declared input IS the route's. Side-effect free (zod only).
import { z } from 'zod';

export const sendInappNotificationSchema = z.object({
  recipientUserId: z.string().uuid(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  level: z.enum(['info', 'warn', 'error']).optional().default('info'),
  linkUrl: z.string().url().max(1000).optional(),
  correlationId: z.string().min(1).max(200).optional(),
  streamId: z.string().uuid().optional(),
});
