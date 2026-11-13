-- WS-3 — approval_kind extension for the workflow-canary cockpit action.
--
-- The improvement/workflows cockpit "Extend canary" + "Rollback" controls raise
-- a human-approval-gated routing action (kind='improvement.canary_action'). On
-- approval the universal n8n callback receiver dispatches to worker_management,
-- keyed by (card_type, list), to roll back or extend the running canary.
--
-- ALTER TYPE ... ADD VALUE is committed here and only referenced by later
-- runtime transactions (an approval INSERT), never in the same txn — safe.
ALTER TYPE approval_kind ADD VALUE IF NOT EXISTS 'improvement.canary_action';
