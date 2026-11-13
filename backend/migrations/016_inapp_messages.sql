-- E-10: persistent in-app chat messages (distinct from ephemeral WebSocket push).
CREATE TABLE IF NOT EXISTS inapp_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    text            TEXT NOT NULL,
    correlation_id  TEXT,
    meta_json       JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inapp_messages_user_created
    ON inapp_messages(user_id, created_at DESC);
