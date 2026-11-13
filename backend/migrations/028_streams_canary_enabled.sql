-- Migration: 027_streams_canary_enabled — opt-out flag for canary observation
-- Date: 2026-04-29
-- Slice: 2026-04-27-continuous-improvement-design (Plan 4 Lane F)
--
-- Adds `canary_enabled` to streams. When TRUE (default) the workflow-
-- promote / prompt-canary path arms the auto-rollback monitor with a non-
-- zero observation window. When FALSE the upstream caller (Plan 5/6 n8n
-- subflow) skips canary observation by passing observation_window_minutes=0
-- (workflows) or canary_percent=0 (prompts). The fr-backend itself only
-- stores the flag; enforcement lives in the n8n workflow.
--
-- Forward-only / additive. Idempotent via IF NOT EXISTS.

ALTER TABLE streams
    ADD COLUMN IF NOT EXISTS canary_enabled BOOLEAN NOT NULL DEFAULT TRUE;
