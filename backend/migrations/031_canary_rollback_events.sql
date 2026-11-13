-- Migration: 028_canary_rollback_events — auto-rollback webhook audit log
-- Date: 2026-04-29
-- Slice: 2026-04-27-continuous-improvement-design (Plan 4 W1/W2)
--
-- Records every auto-rollback webhook received from inference-router
-- (kind='prompt') or worker_management (kind='workflow'). Plan 5/6 will
-- read these rows to reconcile kanban-card state (move to BLOCKED, etc.);
-- the receivers themselves only persist + 200 so the upstream can move on
-- without coupling to fr's reconciliation cadence.
--
-- Forward-only / additive. Idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS canary_rollback_events (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT         NOT NULL CHECK (kind IN ('prompt', 'workflow')),
    payload      JSONB        NOT NULL,
    received_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Reconciliation queries scan recent events; index keeps the tail cheap.
CREATE INDEX IF NOT EXISTS canary_rollback_events_received_at
    ON canary_rollback_events (received_at DESC);
