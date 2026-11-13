// src/routes/engagements/deliveries-schemas.ts
//
// The list query schema of GET /api/engagements/deliveries
// (routes/engagements/deliveries.ts), moved here verbatim so the fr-agui
// capability declaration (P4c part 1, capabilities/observe/engagements.ts) shares
// the route's own schema. ⛔ Side-effect free: zod only.

import { z } from 'zod';

// Channels actually emitted by the fan-out paths (see channels/* + adapters).
export const ChannelEnum = z.enum([
  'teams',
  'websocket',
  'email',
  'inapp',
  'voice',
  'web',
]);

// Statuses written by `notifications.fanOutToUser` + action-approvals fan-out.
// `queued` and `delivered` are reserved for future write-paths (e.g. async
// transports that ack out-of-band); listing them keeps the read API stable
// when those land.
export const StatusEnum = z.enum([
  'queued',
  'sent',
  'delivered',
  'failed',
  'skipped_disabled',
]);

export const ListQuerySchema = z
  .object({
    userId: z.string().uuid().optional(),
    channel: ChannelEnum.optional(),
    status: StatusEnum.optional(),
    actionId: z.string().uuid().optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strip();
