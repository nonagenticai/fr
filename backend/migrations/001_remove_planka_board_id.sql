-- Migration: Remove planka_board_id column from projects table
-- Date: 2025-11-14
-- Reason: Decoupling FR Backend from Planka implementation details.
--         Orchestrator now manages Planka integration internally.

-- Remove the planka_board_id column
ALTER TABLE projects DROP COLUMN IF EXISTS planka_board_id;

-- Add comment explaining the change
COMMENT ON TABLE projects IS 'Projects table - orchestrator_project_id references orchestrator which manages Planka integration internally';
