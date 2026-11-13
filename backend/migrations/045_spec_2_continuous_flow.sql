-- Spec 2 — Continuous-Flow Project Model
-- Single migration: projects.shape + scheduled_triggers + scheduled_reports
--                   + scheduled_trigger_runs.
-- Spec ref: docs/archive/2026-04-27-continuous-project-model-design.md
-- Plan ref: docs/superpowers/plans/2026-04-29-spec-2-plan-a-schema-and-cron-loop.md

BEGIN;

-- §4.2 — projects.shape
ALTER TABLE projects
  ADD COLUMN shape text NOT NULL DEFAULT 'deliverable'
    CHECK (shape IN ('deliverable', 'continuous_flow'));

CREATE INDEX projects_shape_idx ON projects (shape);

-- §5.1 — scheduled_triggers (cron-driven inbound work pulls)
CREATE TABLE scheduled_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  source_connector text NOT NULL CHECK (
    source_connector IN ('file', 's3', 'rss', 'imap', 'github_query', 'n8n_webhook')
  ),
  connector_config jsonb NOT NULL,
  payload_mapper jsonb NOT NULL,
  target_list text NOT NULL DEFAULT 'INBOX',
  card_template jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_run_status text CHECK (
    last_run_status IS NULL
    OR last_run_status IN ('ok', 'error', 'no_new_records', 'skipped_no_connector')
  ),
  last_run_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_triggers_cron_nonempty CHECK (length(cron) > 0)
);

CREATE INDEX scheduled_triggers_tick_idx
  ON scheduled_triggers (enabled, last_run_at)
  WHERE enabled = true;

CREATE INDEX scheduled_triggers_project_idx
  ON scheduled_triggers (project_id);

-- §5.1 / §6 — scheduled_reports (cron-driven outbound progress reports)
CREATE TABLE scheduled_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  template_procedure_name text NOT NULL,
  template_procedure_version integer,
  recipients_channel_ids jsonb NOT NULL,
  workstream_filter jsonb,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_run_status text CHECK (
    last_run_status IS NULL
    OR last_run_status IN ('ok', 'error', 'template_not_found', 'render_error', 'skipped_no_connector')
  ),
  last_run_error text,
  last_run_artifact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_reports_cron_nonempty CHECK (length(cron) > 0)
);

CREATE INDEX scheduled_reports_tick_idx
  ON scheduled_reports (enabled, last_run_at)
  WHERE enabled = true;

CREATE INDEX scheduled_reports_project_idx
  ON scheduled_reports (project_id);

-- §5.5 — scheduled_trigger_runs audit log (append-only)
-- Used by the Channels detail page (2-C) and by WorkflowExceptionStrip later.
CREATE TABLE scheduled_trigger_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('scheduled_intake', 'scheduled_report')),
  trigger_id uuid NOT NULL,
  tenant_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (
    status IN ('ok', 'error', 'no_new_records', 'skipped_no_connector',
               'template_not_found', 'render_error', 'in_progress')
  ),
  records_processed integer NOT NULL DEFAULT 0,
  error_message text,
  kind text NOT NULL DEFAULT 'cron' CHECK (kind IN ('cron', 'manual')),
  triggered_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_trigger_runs_trigger_idx
  ON scheduled_trigger_runs (trigger_kind, trigger_id, fired_at DESC);

CREATE INDEX scheduled_trigger_runs_project_idx
  ON scheduled_trigger_runs (project_id, fired_at DESC);

COMMIT;
