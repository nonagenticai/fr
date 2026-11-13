-- Migration: 203_conveyor_start_refused_outcome
-- Date: 2026-10-20
--
-- U1 (fr part; program/v4-alignment/U1-brief.md "fr", U1.1 response contract):
-- the conveyor start webhook now REFUSES a start it can never accept with
-- `409 {code}`, code one of project_mismatch / tenant_mismatch / phase_not_setup /
-- psra_exists. fr records that as outcome 'refused' (outcome_detail = the code)
-- instead of 'failed' "HTTP 409", so the retry offer (services/conveyor-failures.ts
-- computeRetryOffer) answers `refused_by_conveyor` rather than offering a retry
-- that would be refused again.
--
-- This file widens 199's outcome CHECK (199:48) by one value.
--
-- ⛔ COMPARES THE DEFINITION, NOT THE NAME (the 113 / 119 rule): a database
-- carrying 199's five-value constraint under this same name would be left
-- untouched by an `IF NOT EXISTS (conname)` guard and would then reject every
-- 'refused' write at runtime while this migration reported success. The DO block
-- drops the constraint only when its definition lacks 'refused', then (re)adds it.
--
-- RUNNER CONTRACT: pure DDL, no DML; the six-value CHECK is mirrored in
-- src/db/schema.ts (so a push-built database satisfies the probe). Idempotent —
-- re-running finds the six-value definition and does nothing, so it is safe
-- under `reapplyIfProbeFails`. The table is resolved through pg_class, not
-- `::regclass` (the 119 reason). No BEGIN/COMMIT — the runner wraps each file in
-- a SAVEPOINT. Widening a CHECK accepts every row the old one accepted, so the
-- re-add's validation scan cannot fail.

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'project_conveyor_start_attempts'
     AND c.conname = 'project_conveyor_start_attempts_outcome_check';

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%''refused''%' THEN
    ALTER TABLE project_conveyor_start_attempts
      DROP CONSTRAINT project_conveyor_start_attempts_outcome_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE project_conveyor_start_attempts
      ADD CONSTRAINT project_conveyor_start_attempts_outcome_check
      CHECK (outcome IN ('pending', 'delivered', 'failed', 'board_link_failed', 'inert', 'refused'));
  END IF;
END
$$;
