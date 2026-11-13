-- Migration: E-8 engagement_deliveries.action_id
-- Date: 2026-04-24
-- Reason: When an action (E-2) completes — synchronously or via the
--         action-approval bus (E-5) — the result notification to the
--         originating channel goes through the same engagement_deliveries
--         audit path as approvals. Recording action_id on the delivery row
--         lets the Analytics slice (Wave 3) query approvals + actions out
--         of one table.

ALTER TABLE engagement_deliveries
    ADD COLUMN IF NOT EXISTS action_id UUID;

CREATE INDEX IF NOT EXISTS idx_engagement_deliveries_action_id
    ON engagement_deliveries(action_id)
    WHERE action_id IS NOT NULL;
