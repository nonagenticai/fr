-- Migration: E-13 agent session token refresh
-- Date: 2026-04-25
-- Reason: The agent core needs a long-lived, independently revocable
--         credential to call FR on the user's behalf. We mint a short-lived
--         FR access token (15 min) by exchanging a 30-day agent-session
--         refresh token. Refresh tokens are stored as sha256 hex of the raw
--         256-bit random value (preimage resistance comes from token entropy,
--         not hash slowness — bcrypt would buy nothing here). Rotation on
--         each refresh + replay detection via `replaced_by`.

CREATE TABLE IF NOT EXISTS agent_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
    revoked_at TIMESTAMPTZ,
    replaced_by UUID REFERENCES agent_sessions(id)
);

-- Supports the "list active sessions for user" query that backs the future
-- per-row revoke UI panel. Partial — pays no cost for revoked rows.
CREATE INDEX IF NOT EXISTS agent_sessions_user_active_idx
    ON agent_sessions(user_id)
    WHERE revoked_at IS NULL;
