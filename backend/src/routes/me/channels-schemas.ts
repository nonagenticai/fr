// src/routes/me/channels-schemas.ts
//
// The `/api/me/channels` body schemas, side-effect free (zod only) so the route
// (routes/me/channels.ts) and its capability declaration (fr-agui P4b part 3,
// capabilities/account/me.ts) share ONE schema.
import { z } from 'zod';

export const ChannelEnum = z.enum(['teams', 'telegram', 'websocket', 'email', 'mcp']);

export const PrefSchema = z.object({
  id: z.string().uuid().optional(),
  channel: ChannelEnum,
  address: z.string().min(1).max(512),
  /** The workspace this link acts in (one of the caller's memberships); null/absent = unpinned. */
  tenant_id: z.string().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

export const ReplaceBodySchema = z.object({
  prefs: z.array(PrefSchema),
});
