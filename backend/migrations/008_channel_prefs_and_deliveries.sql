-- Migration: Phase 6 — user channel preferences + engagement delivery log
-- Date: 2026-04-23
-- Reason: Move channel/address routing decisions out of callers and into the
--         notifications service. Every delivery (success, failure, or skip)
--         is audited in engagement_deliveries so the reporting layer (and
--         future agent-over-Signal / agent-over-Teams channels) can answer
--         "who got notified about what, when, how".

-- ---------------------------------------------------------------------------
-- user_channel_prefs
--
-- Who receives notifications, on which channel, at which address.
-- A single user can have multiple prefs per channel (e.g. two Signal numbers)
-- but each (user, channel, address) tuple is unique. `is_default` marks the
-- user's preferred pref per channel — resolveRecipients() orders defaults first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_channel_prefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL,          -- 'signal' | 'teams' | 'websocket' | 'email'
    address TEXT NOT NULL,          -- phone / webhook URL / ws connection id / email
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_channel_prefs_user_channel_address
    ON user_channel_prefs(user_id, channel, address);

CREATE INDEX IF NOT EXISTS idx_user_channel_prefs_user_id
    ON user_channel_prefs(user_id);

-- ---------------------------------------------------------------------------
-- engagement_deliveries
--
-- Audit of every delivery attempt. One row per (engagement, channel, address)
-- attempt — including the "skipped_disabled" case when the user has no prefs.
-- engagement_id is intentionally TEXT + nullable so future non-UUID engagement
-- types (card comments, report pings, …) can reuse the table without a schema
-- change. For now engagement_id is the approvals.id string.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engagement_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id TEXT,
    engagement_type TEXT NOT NULL,   -- 'approval' for now
    channel TEXT NOT NULL,
    recipient_user_id TEXT,
    recipient_address TEXT NOT NULL,
    status TEXT NOT NULL,            -- 'sent' | 'failed' | 'skipped_disabled'
    error TEXT,
    metadata_json JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engagement_deliveries_engagement_id
    ON engagement_deliveries(engagement_id);

CREATE INDEX IF NOT EXISTS idx_engagement_deliveries_user_created
    ON engagement_deliveries(recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engagement_deliveries_channel_created
    ON engagement_deliveries(channel, created_at DESC);
