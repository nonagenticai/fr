-- Migration: 168_project_template
-- Date: 2026-10-09
-- Refs: U-PS-ENTRY + U-PS-ROUTE (fr half) — PROJECT-START-PROCESS-DESIGN §4,
--       §12.2; CONVEYOR-TAXONOMY-DESIGN D4/D7.
--
-- `projects.template_id` + `projects.template_hash`: the pm project template
-- (`template_id@hash`) a project was STARTED from. Written only by promote,
-- from the approved outline version's `phase_plan` (migration 167) — never from
-- a request body, so no direct create can claim a template.
--
-- A project WITH a template is a "plan project": its phase is computed from the
-- plan (design D4), so both PATCH /api/projects/:id/phase lanes refuse it with
-- `phase_is_computed`. A project WITHOUT one is legacy and keeps every existing
-- phase writer. The U-TX-LEGACY cut later archives the active, orchestrated,
-- EXEC, template_id-IS-NULL projects — that is a data op needing George's OK,
-- not this migration.
--
-- NULLABLE, NO BACKFILL, NO BEHAVIOUR CHANGE for any existing row: every
-- project today has no template and reads NULL.
--
-- Named CHECK, both-or-neither: an id without its version hash (or the
-- reverse) names no template version anyone can resolve.
--
-- RUNNER CONTRACT: pure DDL; mirrored in src/db/schema.ts. No BEGIN/COMMIT.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS template_id text,
  ADD COLUMN IF NOT EXISTS template_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_template_pair_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_template_pair_check
      CHECK ((template_id IS NULL) = (template_hash IS NULL));
  END IF;
END$$;

COMMENT ON COLUMN projects.template_id IS
  'pm project_templates id this project was started from (promote only, from '
  'the approved outline phase_plan). NULL = legacy project (no plan). Authority: '
  'backend/migrations/168_project_template.sql.';
COMMENT ON COLUMN projects.template_hash IS
  'The template version body hash (template_id@hash). Paired with template_id.';
