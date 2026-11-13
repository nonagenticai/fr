-- Migration: Add n8n integration columns, remove orchestrator columns
-- Date: 2026-02-20
-- Reason: Phase 1 migration from orchestrator to n8n.
--         Projects now track n8n_project_id and planka_board_id directly.
--         Orchestrator columns are no longer used.

-- Add new columns (nullable, safe to run multiple times)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS n8n_project_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS planka_board_id TEXT;

-- Update default status for new projects
ALTER TABLE projects ALTER COLUMN status SET DEFAULT 'submitted';

-- Remove obsolete orchestrator columns
ALTER TABLE projects DROP COLUMN IF EXISTS orchestrator_project_id;
ALTER TABLE projects DROP COLUMN IF EXISTS container_name;
