-- Migration: 068_scheduled_triggers_origin
-- Date: 2026-05-19
-- Plan ref: ~/.claude/plans/fr-kag-and-artifact-agile-wadler.md (PR fr#4)
--
-- Adds the canonical origin columns to scheduled_triggers so the
-- bound_assets UX can distinguish:
--   - tenant-wide triggers (rare; admin-authored)
--   - project-scoped triggers (the default — every existing row)
--   - workflow-authored triggers (n8n created via a future internal endpoint)
--
-- Mirrors the columns already on requirements / principles / decisions /
-- agentic_procedures / artifacts upstream services. scheduled_triggers
-- lives in fr-backend itself (Drizzle, not a separate upstream service),
-- so the column is added here.
--
-- Backfill: every existing row has project_id NOT NULL → origin_kind = 'project',
-- origin_project_id = project_id, created_by_user_id left NULL (we cannot
-- recover the historical author from the row alone; new rows will populate it).
--
-- All DDL is idempotent. Pre-prod, forward-only.

BEGIN;

-- Add the four origin columns. origin_kind has a CHECK constraint so
-- new values are caught at insert time rather than surfacing later as
-- a UI bug.
ALTER TABLE scheduled_triggers
  ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'project',
  ADD COLUMN IF NOT EXISTS origin_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_workflow_run_id text,
  ADD COLUMN IF NOT EXISTS created_by_user_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_triggers_origin_kind_check'
  ) THEN
    ALTER TABLE scheduled_triggers
      ADD CONSTRAINT scheduled_triggers_origin_kind_check
      CHECK (origin_kind IN ('tenant', 'project', 'workflow'));
  END IF;
END$$;

-- Backfill existing rows: scheduled_triggers.project_id is NOT NULL by
-- the column definition, so every row gets origin_kind='project' and
-- origin_project_id mirrors project_id.
UPDATE scheduled_triggers
  SET origin_kind = 'project',
      origin_project_id = project_id
  WHERE origin_project_id IS NULL;

-- After backfill, an n8n-authored row would have origin_kind='workflow'
-- + origin_workflow_run_id set; consistency is enforced at app level
-- (no DB-side check beyond the kind enum, to keep the constraint
-- composable with future kinds).

COMMIT;
