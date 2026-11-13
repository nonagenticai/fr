-- Migration: 166_project_type_check
-- Date: 2026-10-09
-- Refs: fr#1476 (U-TX-PTYPE), CONVEYOR-TAXONOMY-DESIGN rev 2 D3.
--
-- A named CHECK closing `projects.project_type` to the 7-value vocabulary
-- {it, feature, program, kaizen, meta_prompt, meta_procedure, system_ops}
-- (`src/lib/project-type.ts` PROJECT_TYPES), with two deliberate admissions:
--
--  1. ARCHIVED / CANCELLED ROWS ARE EXEMPT. Measured on prod (worker4, BEGIN
--     READ ONLY, 2026-10-09): archived rows carry NULL (2) and the retired
--     value 'analysis' (1). History is not rewritten; a row that is no longer
--     live may keep the type it was born with. `cancelled` is the terminal
--     state of a rejected/withdrawn request's pre-approval row (fr#1487).
--     ⚠️ So the exemption is one-way: UN-archiving such a row back to a live
--     status is refused until its type is set to a vocabulary value.
--
--  2. NULL IS ADMITTED ON EVERY STATUS — STATED, NOT ACCIDENTAL. Postgres
--     passes a CHECK whose expression is NULL, so `project_type IN (...)`
--     alone would already let NULL through; the explicit `IS NULL` arm says so
--     out loud. Two writers produce it today and both must keep working:
--       * the `pending` pre-approval row fr#1487 allocates at request submit
--         (`routes/project-request-lifecycle.ts allocatePreApprovalProject`)
--         writes NO project_type — read, not inferred: its INSERT names only
--         name/repository_url/branch/owner_id/status/project_data;
--       * an untyped create (`POST /api/projects` without project_type, and the
--         AG-UI `agent.create_project` raw insert) — this works today, so
--         refusing it would be a behaviour change that needs its own flag, not
--         a CHECK. Measured: 0 live (non-archived) NULL rows on prod.
--
-- SAFE ON LIVE DATA. Prod (worker4, BEGIN READ ONLY, 2026-10-09; 147 rows:
-- 6 active, 141 archived, 0 pending/cancelled). Active types: system_ops 3,
-- kaizen 1, meta_prompt 1, meta_procedure 1 — all in the list, no NULL. The
-- 141 archived rows (it 127, feature 5, system_ops 3, NULL 2, analysis 1,
-- kaizen 1, meta_prompt 1, meta_procedure 1) pass via the exemption. `status`
-- itself has no CHECK; the exemption names exact values.
--
-- ⛔ THE LIST BELOW MUST EQUAL `PROJECT_TYPES` (tests/unit/db/
-- project-vocabulary-checks.test.ts parses it). `src/db/schema.ts` builds the
-- SAME named CHECK from the constant, so `drizzle-kit push` lands it on CI.
--
-- RUNNER CONTRACT: pure DDL, the 159/165 shape (DROP a same-name constraint
-- whose DEFINITION is stale, then ADD). No DML. Idempotent. Replayable by hand.
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'projects_project_type_check'
     AND c.conrelid = 'projects'::regclass;

  -- A same-name constraint with an OLDER definition (no `cancelled` exemption,
  -- no `IS NULL` arm, a shorter type list) is dropped and re-added —
  -- definition, not name (the 159 shape). This condition is a SUPERSET of the
  -- runner probe's (`'system_ops'`, `IS NULL`, `'archived'`, `'cancelled'`), so
  -- after this file runs the probe cannot read FALSE.
  IF existing_def IS NOT NULL
     AND (existing_def NOT LIKE '%''it''%'
          OR existing_def NOT LIKE '%''feature''%'
          OR existing_def NOT LIKE '%''program''%'
          OR existing_def NOT LIKE '%''kaizen''%'
          OR existing_def NOT LIKE '%''meta_prompt''%'
          OR existing_def NOT LIKE '%''meta_procedure''%'
          OR existing_def NOT LIKE '%''system_ops''%'
          OR existing_def NOT LIKE '%''archived''%'
          OR existing_def NOT LIKE '%''cancelled''%'
          OR existing_def NOT LIKE '%IS NULL%') THEN
    ALTER TABLE projects DROP CONSTRAINT projects_project_type_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_project_type_check
      CHECK (
        project_type IS NULL
        OR project_type IN (
          'it',
          'feature',
          'program',
          'kaizen',
          'meta_prompt',
          'meta_procedure',
          'system_ops'
        )
        OR status IN ('archived', 'cancelled')
      );
  END IF;
END$$;
