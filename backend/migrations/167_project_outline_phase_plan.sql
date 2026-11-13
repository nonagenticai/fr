-- Migration: 167_project_outline_phase_plan
-- Date: 2026-10-09
-- Refs: U-PS-OUTLINE (PROJECT-START-PROCESS-DESIGN §6.2 "Plan instance",
--       §12.2), CONVEYOR-TAXONOMY-DESIGN D1/D4.
--
-- Each OUTLINE VERSION carries the phase plan it was instantiated with:
--   phase_plan       jsonb — `{template_id, template_hash, phases[], ...}`,
--                    validated by src/lib/phase-plan.ts PhasePlanSchema
--                    (phases = an ordered subset of the 11-phase spine);
--   phase_plan_hash  text  — sha256 hex of the JCS-canonical plan, COMPUTED by
--                    fr at write time (never caller-supplied).
--
-- Per version, not per request: the outline is already versioned (123), and a
-- re-proposal is exactly a new plan. The approval decides ONE version, so the
-- plan the requester approved is the plan on that row and nothing else.
--
-- NULLABLE, NO BACKFILL, NO BEHAVIOUR CHANGE. Every existing outline (and every
-- outline the current analysis workflow delivers) has no plan; it reads NULL and
-- promotes exactly as before. Only an outline that DELIVERS a plan gets one.
--
-- Two named CHECKs:
--   * both-or-neither — a plan without its hash, or a hash with no plan, is a
--     half-written row; refuse it rather than let a reader guess which half is
--     true;
--   * the hash shape — 64 lowercase hex, the sha256 hex digest.
--
-- RUNNER CONTRACT: pure DDL (ADD COLUMN IF NOT EXISTS + pg_constraint-guarded
-- ADD CONSTRAINT). No DML. Mirrored in src/db/schema.ts so drizzle-kit push
-- lands identical columns and constraints on CI. No BEGIN/COMMIT.

ALTER TABLE project_outlines
  ADD COLUMN IF NOT EXISTS phase_plan jsonb,
  ADD COLUMN IF NOT EXISTS phase_plan_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_outlines_phase_plan_pair_check'
       AND conrelid = 'project_outlines'::regclass
  ) THEN
    ALTER TABLE project_outlines
      ADD CONSTRAINT project_outlines_phase_plan_pair_check
      CHECK ((phase_plan IS NULL) = (phase_plan_hash IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_outlines_phase_plan_hash_hex'
       AND conrelid = 'project_outlines'::regclass
  ) THEN
    ALTER TABLE project_outlines
      ADD CONSTRAINT project_outlines_phase_plan_hash_hex
      CHECK (phase_plan_hash IS NULL OR phase_plan_hash ~ '^[0-9a-f]{64}$');
  END IF;
END$$;

COMMENT ON COLUMN project_outlines.phase_plan IS
  'The phase plan this outline version was instantiated with: {template_id, '
  'template_hash, phases[] (ordered spine subset), ...}. NULL = no template '
  '(legacy outline). Authority: backend/migrations/167_project_outline_phase_plan.sql.';
COMMENT ON COLUMN project_outlines.phase_plan_hash IS
  'sha256 hex of the JCS-canonical phase_plan, computed by fr at write time.';
