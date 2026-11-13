-- Migration: Notification hub - add communication gateway columns
-- Date: 2026-03-19
-- Reason: FR becomes the communication hub between n8n and all user-facing channels.
--         Approvals can now originate from n8n (not just web), and notifications
--         are tracked per-channel for fan-out delivery.

-- Make project_id nullable (n8n-originated approvals may not have a project)
ALTER TABLE approvals ALTER COLUMN project_id DROP NOT NULL;

-- Make requester_id nullable (n8n service account creates approvals)
ALTER TABLE approvals ALTER COLUMN requester_id DROP NOT NULL;

-- Add communication hub columns to approvals
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS callback_path TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS card_id TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'web';
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Notification delivery tracking
CREATE TABLE IF NOT EXISTS notification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at TIMESTAMP,
    error_message TEXT,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for looking up notifications by approval
CREATE INDEX IF NOT EXISTS idx_notification_log_approval_id ON notification_log(approval_id);

-- Index for finding pending notifications
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON notification_log(status) WHERE status = 'pending';
