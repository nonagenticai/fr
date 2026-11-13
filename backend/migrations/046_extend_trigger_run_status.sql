-- migrations/042_extend_trigger_run_status.sql
--
-- Spec 2 Plan 2-B: extend status enumerations to include statuses emitted by
-- the real connector dispatch path (config_invalid, partial_failure) and the
-- inbound webhook kind.
--
-- Changes:
--   1. scheduled_trigger_runs.status: add 'config_invalid', 'partial_failure'
--   2. scheduled_trigger_runs.kind: add 'webhook' (inbound n8n_webhook intake)
--   3. scheduled_triggers.last_run_status: add 'config_invalid', 'partial_failure'

-- 1. Drop + re-add status constraint on scheduled_trigger_runs
ALTER TABLE scheduled_trigger_runs
  DROP CONSTRAINT IF EXISTS scheduled_trigger_runs_status_check;

ALTER TABLE scheduled_trigger_runs
  ADD CONSTRAINT scheduled_trigger_runs_status_check CHECK (
    status IN (
      'ok', 'error', 'no_new_records', 'skipped_no_connector',
      'template_not_found', 'render_error', 'in_progress',
      'config_invalid', 'partial_failure'
    )
  );

-- 2. Drop + re-add kind constraint on scheduled_trigger_runs
ALTER TABLE scheduled_trigger_runs
  DROP CONSTRAINT IF EXISTS scheduled_trigger_runs_kind_check;

ALTER TABLE scheduled_trigger_runs
  ADD CONSTRAINT scheduled_trigger_runs_kind_check CHECK (
    kind IN ('cron', 'manual', 'webhook')
  );

-- 3. Drop + re-add last_run_status constraint on scheduled_triggers
ALTER TABLE scheduled_triggers
  DROP CONSTRAINT IF EXISTS scheduled_triggers_last_run_status_check;

ALTER TABLE scheduled_triggers
  ADD CONSTRAINT scheduled_triggers_last_run_status_check CHECK (
    last_run_status IS NULL
    OR last_run_status IN (
      'ok', 'error', 'no_new_records', 'skipped_no_connector',
      'config_invalid', 'partial_failure'
    )
  );
