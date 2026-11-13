-- Migration: 171_project_deliverables_plan_id
-- Date: 2026-10-09
-- Refs: U-PS-PHASEEXIT (fr#1481) — CONVEYOR-TAXONOMY-DESIGN D4 (computed phase
--       exit), PROJECT-START-PROCESS-DESIGN §6.1 (template deliverables).
--
-- `project_deliverables.plan_deliverable_id`: which deliverable of the
-- project's PHASE PLAN (project_outlines.phase_plan.deliverables[].id, the pm
-- template Deliverable.id) this approved-scope row is. It is the ONLY join from
-- a row to its plan placement (phase, card_types, cardinality): the plan says
-- "D1 is placed in deep_analysis, fixed:1 bug_hunt_sweep", the row holds the
-- approved title/criteria and the minting state (migration 169). Without it
-- `planPhaseExit` cannot know which rows a phase's exit waits on.
--
-- Written only by promote (buildApprovedScopeRows), copied from the approved
-- outline deliverable's `plan_deliverable_id`. NULL = a legacy row (no plan) —
-- every row today. A plan project whose plan names a deliverable with no row
-- carrying its id does NOT exit that phase (fail closed, `deliverable_row_missing`).
--
-- Named UNIQUE (project_id, plan_deliverable_id): one row per plan deliverable
-- per project (Postgres admits any number of NULLs, so legacy rows are
-- unaffected). Named CHECK: the pm template SLUG_PATTERN, so a value that can
-- never match a plan id is refused at write rather than silently never joined.
--
-- NULLABLE, NO BACKFILL, NO BEHAVIOUR CHANGE for any existing row.
--
-- RUNNER CONTRACT: pure DDL; mirrored in src/db/schema.ts (two emitters of one
-- shape — tests/integration/migrations/165-170-project-start-ddl.integration.test.ts
-- executes this file and compares it to the push-built shape). No BEGIN/COMMIT.

ALTER TABLE project_deliverables
  ADD COLUMN IF NOT EXISTS plan_deliverable_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_deliverables_plan_deliverable_id_check'
       AND conrelid = 'project_deliverables'::regclass
  ) THEN
    ALTER TABLE project_deliverables
      ADD CONSTRAINT project_deliverables_plan_deliverable_id_check
      CHECK (plan_deliverable_id IS NULL OR plan_deliverable_id ~ '^[a-z][a-z0-9_]*$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_deliverables_project_plan_deliverable_unique'
       AND conrelid = 'project_deliverables'::regclass
  ) THEN
    ALTER TABLE project_deliverables
      ADD CONSTRAINT project_deliverables_project_plan_deliverable_unique
      UNIQUE (project_id, plan_deliverable_id);
  END IF;
END$$;

COMMENT ON COLUMN project_deliverables.plan_deliverable_id IS
  'The phase-plan deliverable id (pm template Deliverable.id) this row is; the '
  'join planPhaseExit uses for phase placement. NULL = legacy (no plan). '
  'Authority: backend/migrations/171_project_deliverables_plan_id.sql.';
