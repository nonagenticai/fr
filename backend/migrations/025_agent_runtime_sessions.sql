-- Migration: E-11 agent runtime sessions
-- Date: 2026-04-27
-- Reason: The agent runtime needs durable per-(user, channel, thread) state
--         so an inbound message on a channel resumes the same conversation
--         instead of starting fresh. Distinct from `agent_sessions` (E-13)
--         which is the refresh-token rotation table for FR-callable bearer
--         tokens — different concern, different lifetime, different unique
--         key. We use a different table name here to avoid the naming
--         collision the Wave-1 plan accidentally introduced.
--
--         Wave-1 stub policy stores `state_json={}` and only proves the
--         upsert seam works; later waves persist tool-call history etc.

CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    channel     TEXT NOT NULL,
    thread_id   TEXT NOT NULL DEFAULT '',
    state_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

-- Lookup key for `getOrCreate(user, channel, thread)`. UNIQUE so the upsert
-- in session-store.ts can use ON CONFLICT cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_sessions_user_channel_thread
    ON agent_runtime_sessions(user_id, channel, thread_id);

-- TTL sweep for an eventual reaper cron.
CREATE INDEX IF NOT EXISTS idx_agent_runtime_sessions_expires_at
    ON agent_runtime_sessions(expires_at);
