-- migrations/046_scheduled_reports_partial_failure_status.sql
--
-- Spec 2 Plan 2-D §6 — extend scheduled_reports.last_run_status to allow
-- 'partial_failure' (returned when one channel succeeds but another fails)
-- so the orchestrator in services/report-render.ts can persist its
-- aggregate status onto the parent row without violating the inline CHECK
-- constraint declared in migration 041.
--
-- The original constraint in 041 is anonymous (CREATE TABLE inline CHECK);
-- Postgres auto-names it with a `_check` suffix derived from the column.
-- We discover and drop it dynamically, then re-add a named constraint.
--
-- Idempotent — safe to re-run.

DO $$
DECLARE
  cn text;
BEGIN
  -- Find the existing CHECK constraint on scheduled_reports.last_run_status
  -- (named or auto-named). We look for a constraint whose definition
  -- references last_run_status to handle both shapes.
  SELECT conname
    INTO cn
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'scheduled_reports'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%last_run_status%'
   LIMIT 1;

  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE scheduled_reports DROP CONSTRAINT %I', cn);
  END IF;
END
$$;

ALTER TABLE scheduled_reports
  ADD CONSTRAINT scheduled_reports_last_run_status_check CHECK (
    last_run_status IS NULL
    OR last_run_status IN (
      'ok',
      'error',
      'template_not_found',
      'render_error',
      'skipped_no_connector',
      'partial_failure'
    )
  );
