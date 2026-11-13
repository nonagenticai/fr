-- Migration: Plan 3 — agent_runtime_sessions extension for the LLM loop
-- Date: 2026-04-28
-- Reason: The Wave-1 stub stored only `state_json` (free-form). The LLM-driven
--         agent loop in `backend/src/agent/loop.ts` needs a durable message
--         ledger (user/assistant/tool turns) and a per-thread worker selector
--         so per-project worker overrides can land later without another
--         migration. Persist after every `assistant-end` event.

ALTER TABLE agent_runtime_sessions
    ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_runtime_sessions
    ADD COLUMN IF NOT EXISTS worker_name TEXT NOT NULL DEFAULT 'fr-agent-default';
