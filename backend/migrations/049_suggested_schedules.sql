-- Migration: 044_suggested_schedules — Spec 2 Plan 2-D Foundation
-- Date: 2026-05-01
-- Spec ref: docs/archive/2026-04-27-continuous-project-model-design.md §9
-- Plan ref: confirmed-spec-2-spicy-breeze.md Phase 5
--
-- Adds the `suggested_schedules` table backing the Suggestion Inbox surface.
-- Rows here are *candidates* for promotion to a real `scheduled_triggers`
-- row (the Spec 2 inbound cron). Two ways a row lands here:
--
--   1. `source = 'manual'` — admin/QA stub (POST /api/internal/suggested-schedules)
--   2. `source = 'heuristic'` — future auto-detector (out of scope this phase)
--
-- Lifecycle: status transitions are 'new' -> 'accepted' | 'dismissed'.
-- Accept atomically inserts a `scheduled_triggers` row from `payload.suggested_*`
-- and writes the new id back into `promoted_trigger_id` so the FE can render
-- "from suggestion #<id>" provenance and so we never double-promote.
--
-- ON DELETE SET NULL on promoted_trigger_id keeps the suggestion row visible
-- (audit trail) even if an admin later deletes the promoted trigger.
--
-- All DDL is idempotent (IF NOT EXISTS). Pre-prod, forward-only — see memory
-- `feedback-no-backwards-compat-pre-prod.md`.

BEGIN;

CREATE TABLE IF NOT EXISTS suggested_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid,
  source text NOT NULL CHECK (source IN ('manual', 'heuristic')),
  ad_hoc_summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'dismissed')),
  promoted_trigger_id uuid REFERENCES scheduled_triggers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS suggested_schedules_project_status_idx
  ON suggested_schedules (project_id, status);

CREATE INDEX IF NOT EXISTS suggested_schedules_tenant_idx
  ON suggested_schedules (tenant_id);

COMMIT;
