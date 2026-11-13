-- Migration: 213_conveyor_flow_runs
-- Date: 2026-10-25
--
-- Cockpit A5 / R-CK5 (FR-COCKPIT-IMPL-PLAN-2026-10-25.md §4 A3, A5): one row per n8n execution,
-- written by the n8n-custom execution hook through POST /api/internal/conveyor/flow-runs
-- (services/conveyor-flow-runs.ts). Durable beyond n8n's 72h execution retention; read by the
-- project cockpit's flow block (GET /api/projects/:id/flow-runs).
--
--   execution_id   n8n execution id — PRIMARY KEY; the hook re-fires when a waiting execution
--                  resumes, so every write is an upsert. A running/waiting record never
--                  overwrites a terminal status (success/error/canceled/crashed) that arrived first.
--   project_ref    as received (an fr project id or an RM pm_project id)
--   project_id     fr's resolution of project_ref (NULL when it is not exactly one project);
--                  ON DELETE SET NULL, so a project purge never bulk-deletes run history
--   tenant_id      the resolved project's tenant tag (project_data->>'keycloak_tenant_id')
--   error_message  clipped to 2000 characters by the service
--
-- Attaches migration 142's destructive-statement guard (protected_tables lists it).
--
-- RUNNER CONTRACT: pure DDL plus TRIGGERs (no DML); mirrored in src/db/schema.ts. Probed for the
-- table, both indexes and both guard triggers — push creates the first three, never the triggers,
-- so a push-built database keeps this file pending until it runs. Idempotent (IF NOT EXISTS,
-- CREATE OR REPLACE TRIGGER, a name-guarded CHECK) — safe under `reapplyIfProbeFails`.
-- No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS conveyor_flow_runs (
  execution_id        text PRIMARY KEY,
  workflow_id         text NULL,
  workflow_name       text NULL,
  card_id             text NULL,
  project_ref         text NULL,
  project_id          uuid NULL REFERENCES projects(id) ON DELETE SET NULL,
  tenant_id           uuid NULL,
  status              text NOT NULL,
  started_at          timestamptz NULL,
  stopped_at          timestamptz NULL,
  failed_node         text NULL,
  error_class         text NULL,
  error_message       text NULL,
  retry_of            text NULL,
  parent_execution_id text NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);

DO $flow_run_status$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conveyor_flow_runs_status_check'
       AND conrelid = 'conveyor_flow_runs'::regclass
  ) THEN
    ALTER TABLE conveyor_flow_runs
      ADD CONSTRAINT conveyor_flow_runs_status_check
      CHECK (status IN ('running', 'success', 'error', 'waiting', 'canceled', 'crashed'));
  END IF;
END
$flow_run_status$;

CREATE INDEX IF NOT EXISTS conveyor_flow_runs_project_started_idx
  ON conveyor_flow_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS conveyor_flow_runs_card_started_idx
  ON conveyor_flow_runs (card_id, started_at DESC);

-- Attach migration 142's guard (functions fr_refuse_truncate / fr_refuse_bulk_delete).
-- Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_conveyor_flow_runs
  BEFORE TRUNCATE ON public.conveyor_flow_runs
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.conveyor_flow_runs
  ENABLE ALWAYS TRIGGER fr_guard_truncate_conveyor_flow_runs;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_conveyor_flow_runs
  AFTER DELETE ON public.conveyor_flow_runs
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.conveyor_flow_runs
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_conveyor_flow_runs;
