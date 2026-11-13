-- Migration: 214_conveyor_flow_run_n8n_status
-- Date: 2026-10-26
--
-- Cockpit A3 follow-up (n8n-custom #17, FR-COCKPIT-IMPL-PLAN-2026-10-25 §4 A3/A5): a conveyor flow
-- that takes its `Flow error` / `Agent failed` path ENDS as an n8n `success`, yet failed as far as
-- the conveyor is concerned. The hook now reports such a run as `status = 'error'` with
-- `error_class` `flow_error` / `agent_failed`, and sends n8n's own final status separately:
--
--   conveyor_flow_runs.n8n_status  text NULL — n8n's final execution status as the hook saw it
--     (e.g. 'success' on a flow_error run whose `status` is 'error'). NULL for every row written
--     before the hook sent it, and for a hook that does not send it. Free text, no CHECK: it is
--     n8n's vocabulary, recorded as received, and a value fr does not know must never make the
--     whole record fail.
--
-- RUNNER CONTRACT: pure DDL (no DML), idempotent (ADD COLUMN IF NOT EXISTS) — mirrored in
-- src/db/schema.ts and probed by the column. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE conveyor_flow_runs ADD COLUMN IF NOT EXISTS n8n_status text NULL;
