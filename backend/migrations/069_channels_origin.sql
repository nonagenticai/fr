-- Migration: 069_channels_origin
-- Date: 2026-05-20
-- Plan ref: ~/.claude/plans/fr-kag-and-artifact-agile-wadler.md (channel internal-create)
--
-- Adds the canonical origin columns to channels so the bound_assets UX
-- and the n8n internal-create path can distinguish:
--   - tenant-wide / department channels (the default — every existing row,
--     human/admin-authored)
--   - workflow-authored channels (n8n created via
--     POST /api/internal/assets/channel)
--
-- Mirrors migration 068 (scheduled_triggers) and the upstream services
-- (requirements/principles/decisions/agentic_procedures/artifacts).
-- channels live in fr-backend itself (Drizzle, not a separate upstream
-- service), so the columns are added here.
--
-- Scope rule (Spec 1 §6.5): channels are NEVER project-scoped. So the
-- origin_kind CHECK is ('tenant','workflow') only — no 'project'. This is
-- tighter than the scheduled_triggers CHECK on purpose.
--
-- Backfill: ADD COLUMN ... NOT NULL DEFAULT 'tenant' backfills every
-- existing row to origin_kind='tenant'. created_by_user_id left NULL (we
-- cannot recover the historical author from the row alone; new rows
-- populate it). origin_project_id on a workflow-authored channel is
-- provenance only (the authoring project), not dispatch scope.
--
-- All DDL is idempotent. Pre-prod, forward-only.

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'tenant',
  ADD COLUMN IF NOT EXISTS origin_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_workflow_run_id text,
  ADD COLUMN IF NOT EXISTS created_by_user_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_origin_kind_check'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_origin_kind_check
      CHECK (origin_kind IN ('tenant', 'workflow'));
  END IF;
END$$;

COMMIT;
