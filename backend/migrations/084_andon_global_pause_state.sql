-- Migration: 084_andon_global_pause_state
-- Date: 2026-06-24
-- Plan ref: ~/.claude/plans/global-andon-enforced-freeze.md
--
-- The global andon cord (andon_state singleton, migration 065) was cosmetic:
-- nothing checked it and no n8n workflow honored it. We are making it an
-- ENFORCED system-wide freeze — engaging deactivates every active n8n workflow
-- via the n8n REST API, and disengaging reactivates EXACTLY the set that was
-- running. To restore that exact set we must persist it at engage time.
--
-- `paused_workflow_ids` holds the JSON array of n8n workflow ids that THIS pull
-- deactivated (so a workflow a super-admin had already turned off by hand is not
-- spuriously reactivated on release). `n8n_paused_at` records when the pause
-- ran; `n8n_pause_error` surfaces a partial-failure summary (some workflows
-- failed to deactivate) so the operator can see the cord did not fully land.
--
-- Pre-prod, forward-only.

BEGIN;

ALTER TABLE andon_state
  ADD COLUMN IF NOT EXISTS paused_workflow_ids JSONB,
  ADD COLUMN IF NOT EXISTS n8n_paused_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS n8n_pause_error     TEXT;

COMMIT;
