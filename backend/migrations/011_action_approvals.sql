-- Migration: E-5 action-approval bus columns on approvals
-- Date: 2026-04-24
-- Reason: The agent-callable action registry (E-2) must defer write actions
--         through the existing approvals domain. Instead of creating a
--         parallel approvals table, we extend `approvals` with the five
--         fields that bind an approval row to a pending action invocation:
--         the action id/name, the serialized input, the originating
--         correlation id, and the originating channel. Approval lifecycle
--         (pending/approved/rejected), fan-out, and consensus math continue
--         to run through the existing columns and services.

ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS action_id UUID,
    ADD COLUMN IF NOT EXISTS action_name TEXT,
    ADD COLUMN IF NOT EXISTS action_input_json JSONB,
    ADD COLUMN IF NOT EXISTS action_correlation_id TEXT,
    ADD COLUMN IF NOT EXISTS action_channel TEXT;

-- Action-keyed lookup for `resolvePendingAction(actionId)`. Partial index so
-- traditional (non-action) approvals pay no index cost.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_action_id
    ON approvals(action_id)
    WHERE action_id IS NOT NULL;
