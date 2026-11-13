-- Migration: 165_project_phase_check
-- Date: 2026-10-09
-- Refs: fr#1475 (U-TX-FR-VENDOR), CONVEYOR-TAXONOMY-DESIGN D1.
--
-- A named CHECK closing `projects.project_phase` to the 11-phase spine plus the
-- off-spine `continuous` board mode.
--
-- WHY NOW. Migration 081 left the column open text "so adding a phase stays a
-- code change". The spine is now owned by the ncn roster and vendored into fr
-- (`src/lib/project-phase.ts` ALL_PROJECT_PHASES, guarded by
-- `scripts/check-card-type-taxonomy-single-sourced.ts`), so a value outside it
-- is never a new phase — it is a writer bug. `unassigned` in particular is the
-- roster's tray marker for the 5 `open` card types, NOT a phase (design D1); a
-- project stamped with it would fall off every rail.
--
-- SAFE ON LIVE DATA. Measured on prod (worker4, BEGIN READ ONLY, 2026-10-09;
-- 147 rows: 6 active, 141 archived, 0 pending/cancelled): every
-- `project_phase` value is on the spine — request 97, contract 48,
-- preliminary_analysis 1, deep_analysis 1; no NULL, no off-spine value. The ADD
-- CONSTRAINT validates the existing rows; a violating row would fail the
-- migration loudly rather than slip through.
--
-- ⛔ THE LIST BELOW MUST EQUAL `ALL_PROJECT_PHASES`. SQL cannot import the TS
-- constant, so `tests/unit/db/project-vocabulary-checks.test.ts` parses this
-- file and fails if the two differ. `src/db/schema.ts` builds the SAME named
-- CHECK from the constant itself, so `drizzle-kit push` (the CI bootstrap) lands
-- an identical constraint — an unnamed or hand-copied one would let CI accept a
-- phase prod rejects.
--
-- RUNNER CONTRACT: pure DDL — a DO block that reads `pg_get_constraintdef`,
-- DROPs a same-name constraint whose DEFINITION is stale, and ADDs the current
-- one (the 159 shape: definition, not name). No DML, no trigger, no function.
-- Idempotent: a current definition is left untouched. Replayable by hand.
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'projects_project_phase_check'
     AND c.conrelid = 'projects'::regclass;

  -- A same-name constraint with an OLDER definition (a 9-phase draft, a
  -- hand-made one) is dropped and re-added — definition, not name (the 159
  -- shape). Every spine value must be present, and `'unassigned'` (the tray
  -- marker, never a phase) must be absent. This condition is a SUPERSET of the
  -- runner probe's (`'closure'` + `'continuous'`), so after this file runs the
  -- probe cannot read FALSE.
  IF existing_def IS NOT NULL
     AND (existing_def NOT LIKE '%''request''%'
          OR existing_def NOT LIKE '%''preliminary_analysis''%'
          OR existing_def NOT LIKE '%''contract''%'
          OR existing_def NOT LIKE '%''deep_analysis''%'
          OR existing_def NOT LIKE '%''epic_design''%'
          OR existing_def NOT LIKE '%''enabler_architecture''%'
          OR existing_def NOT LIKE '%''enabler_development''%'
          OR existing_def NOT LIKE '%''feature_design''%'
          OR existing_def NOT LIKE '%''feature_development''%'
          OR existing_def NOT LIKE '%''verification''%'
          OR existing_def NOT LIKE '%''closure''%'
          OR existing_def NOT LIKE '%''continuous''%'
          OR existing_def LIKE '%''unassigned''%') THEN
    ALTER TABLE projects DROP CONSTRAINT projects_project_phase_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_project_phase_check
      CHECK (project_phase IN (
        'request',
        'preliminary_analysis',
        'contract',
        'deep_analysis',
        'epic_design',
        'enabler_architecture',
        'enabler_development',
        'feature_design',
        'feature_development',
        'verification',
        'closure',
        'continuous'
      ));
  END IF;
END$$;
