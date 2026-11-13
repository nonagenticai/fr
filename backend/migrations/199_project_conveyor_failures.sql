-- Migration: 199_project_conveyor_failures
-- Date: 2026-10-19
--
-- R311 PR 5 (n8n-workflows design/choices/v4/kanban-coach-errors.md §2.5, §4.1,
-- §7 item 5, R-2, R-8): fr records what the conveyor tells it went wrong and the
-- conveyor start attempts fr made, so a member can see it and retry by hand.
-- fr is a FACILITATOR: nothing here decides anything; a notice never triggers a
-- start, and fr never retries on its own.
--
-- project_conveyor_start_attempts — one row per conveyor start fr SENT (or tried
--   to send) for a project. `attempt_n` = the number of earlier attempts recorded
--   for the project, so the first start is 0 and keeps the bare Idempotency-Key
--   `<fr id>`; every retry n >= 1 sends `<fr id>:retry-<n>` (§2.5: the n8n
--   Dedupe store has no per-value delete, so a retry is released by a fresh key).
--   UNIQUE (project_id, attempt_n) serialises two concurrent retries: the second
--   insert fails and is answered 409, never a second start under one number.
--
-- project_conveyor_failures — the two n8n callbacks, append-only:
--   * kind 'start_failed' (`project.start_failed`, §2.5): idempotent on
--     (project_id, execution_id) — `Coach error` and the backstop may both send
--     one for the same failed start;
--   * kind 'coach_failed' (`project.coach_failed`, §4.1): idempotent on the
--     coach's execution id. Keyed (tenant_id, execution_id), not the bare id: n8n
--     execution ids are per-instance counters, and two tenants' conveyor seats can
--     run on different n8n instances, so a bare id could collide across tenants
--     and drop (or reveal) another tenant's notice.
--
-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime, fr#1283): both PROTECTED —
-- a failure record has no regeneration path. Listed in 142's `protected_tables`
-- AND attached at the bottom of THIS file (as 194 / 196 do): in production 142
-- never re-runs, so this attach is what guards the tables.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (so a
-- push-built database satisfies the probe). Idempotent (IF NOT EXISTS) — safe
-- under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps each file in a
-- SAVEPOINT.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS project_conveyor_start_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  attempt_n integer NOT NULL CHECK (attempt_n >= 0),
  idempotency_key text NOT NULL,
  requested_by text NULL,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'delivered', 'failed', 'board_link_failed', 'inert')),
  outcome_detail text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS project_conveyor_start_attempts_project_n_key
  ON project_conveyor_start_attempts (project_id, attempt_n);
CREATE UNIQUE INDEX IF NOT EXISTS project_conveyor_start_attempts_key_key
  ON project_conveyor_start_attempts (idempotency_key);

CREATE TABLE IF NOT EXISTS project_conveyor_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('start_failed', 'coach_failed')),
  execution_id text NOT NULL,
  idempotency_key text NULL,
  rm_project_id text NULL,
  card_id text NULL,
  flow text NULL,
  node text NULL,
  error_class text NULL,
  error_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_conveyor_failures_start_key
  ON project_conveyor_failures (project_id, execution_id) WHERE kind = 'start_failed';
CREATE UNIQUE INDEX IF NOT EXISTS project_conveyor_failures_coach_key
  ON project_conveyor_failures (tenant_id, execution_id) WHERE kind = 'coach_failed';
CREATE INDEX IF NOT EXISTS project_conveyor_failures_project_created_idx
  ON project_conveyor_failures (project_id, created_at);

-- Attach migration 142's guard (functions fr_refuse_truncate /
-- fr_refuse_bulk_delete). Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_project_conveyor_start_attempts
  BEFORE TRUNCATE ON public.project_conveyor_start_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.project_conveyor_start_attempts
  ENABLE ALWAYS TRIGGER fr_guard_truncate_project_conveyor_start_attempts;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_project_conveyor_start_attempts
  AFTER DELETE ON public.project_conveyor_start_attempts
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.project_conveyor_start_attempts
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_project_conveyor_start_attempts;

CREATE OR REPLACE TRIGGER fr_guard_truncate_project_conveyor_failures
  BEFORE TRUNCATE ON public.project_conveyor_failures
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.project_conveyor_failures
  ENABLE ALWAYS TRIGGER fr_guard_truncate_project_conveyor_failures;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_project_conveyor_failures
  AFTER DELETE ON public.project_conveyor_failures
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.project_conveyor_failures
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_project_conveyor_failures;
