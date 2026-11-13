-- Migration: 216_user_channel_prefs_tenant
-- Date: 2026-10-30
--
-- George 2026-10-30: a channel link (Telegram, mcp, ...) is per person AND per tenant. A user
-- who belongs to more than one workspace links an address FOR one of them; a message from that
-- address then acts in that workspace (channels/index.ts, principal.ts resolveChannelTenant),
-- and fan-out for another workspace's approvals skips it (channel-prefs.ts resolveRecipients).
--
--   user_channel_prefs.tenant_id  text NULL   NULL = not pinned (the membership rule decides)

ALTER TABLE user_channel_prefs ADD COLUMN IF NOT EXISTS tenant_id text;
