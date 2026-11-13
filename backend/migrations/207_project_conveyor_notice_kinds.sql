-- Migration: 207_project_conveyor_notice_kinds
-- Date: 2026-10-20
--
-- R318 build step F1: three more conveyor notices recorded in 199's
-- project_conveyor_failures (record-and-show, every member told):
--   'move_stale'       — a confirmed board move was not made: the board changed since it was asked;
--   'move_reverted'    — the conveyor undid a card move made directly on the board (not through fr);
--   'andon_unreadable' — the conveyor could not read the project's hold state, so it held the work.
--
-- Widens 199's kind CHECK (199:61) and adds ONE idempotency index for the new kinds:
-- (tenant_id, kind, idempotency_key) — the caller's notice key (the move request id, the
-- board action id, the execution id) — so a replay answers the stored notice.
--
-- ⛔ COMPARES THE DEFINITION, NOT THE NAME (the 113 / 119 / 203 rule): the DO block drops
-- the CHECK only when its definition lacks 'andon_unreadable', then (re)adds it.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts. Idempotent — safe under
-- `reapplyIfProbeFails`. Widening a CHECK accepts every row the old one accepted, so the
-- re-add's validation scan cannot fail. No BEGIN/COMMIT (the runner's SAVEPOINT).

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
     AND t.relname = 'project_conveyor_failures'
     AND c.conname = 'project_conveyor_failures_kind_check';

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%''andon_unreadable''%' THEN
    ALTER TABLE project_conveyor_failures
      DROP CONSTRAINT project_conveyor_failures_kind_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE project_conveyor_failures
      ADD CONSTRAINT project_conveyor_failures_kind_check
      CHECK (kind IN ('start_failed', 'coach_failed', 'move_stale', 'move_reverted', 'andon_unreadable'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_conveyor_failures_notice_key
  ON project_conveyor_failures (tenant_id, kind, idempotency_key)
  WHERE kind IN ('move_stale', 'move_reverted', 'andon_unreadable');
