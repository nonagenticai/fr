-- Migration: E-4 action idempotency store
-- Date: 2026-04-24
-- Reason: Agent-callable actions and retry-prone channel fan-in need a
--         durable idempotency cache. Postgres instead of Redis because the
--         same retry window can span minutes across channels and we
--         already depend on Postgres for correctness.

CREATE TABLE IF NOT EXISTS action_idempotency (
    key        TEXT PRIMARY KEY,
    value_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- For the sweep job that deletes expired rows.
CREATE INDEX IF NOT EXISTS idx_action_idempotency_expires_at
    ON action_idempotency(expires_at);
