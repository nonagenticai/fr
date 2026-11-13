-- Migration: 206_project_andon_reason
-- Date: 2026-10-20
--
-- R318 §2 (George-approved 2026-10-20, D3): the PROJECT andon cord (migration 050,
-- projects.andon_engaged/_at/_by) is now also pulled by fr itself, for a board-move
-- request on a conveyor project of ANY tenant, beside the super_admin operator cord.
--
--   andon_reason      'operator'      — pulled by a super_admin (POST /api/projects/:id/andon/engage);
--                     'move_request'  — pulled by fr for a waiting board move (R318);
--                     NULL            — a released cord, OR a cord engaged before this migration
--                                       (readers treat engaged + NULL as 'operator').
--   andon_request_id  the move request that pulled the cord (fr's compare-and-set key while
--                     the conveyor evaluates it; NULL for an operator cord).
--   andon_approval_id the `board.move_confirmation` approval that holds it (the conveyor's
--                     release key and its gate bypass; NULL until the approval exists).
--
-- The super_admin engage overwrites `andon_reason` with 'operator' and clears both ids, so a
-- pending move's later release (keyed on the ids) misses and the operator's cord stands.
--
-- RUNNER CONTRACT: pure DDL, no DML (no backfill: engaged + NULL reads as 'operator');
-- mirrored in src/db/schema.ts, so a push-built database satisfies the probe. Idempotent
-- (IF NOT EXISTS; the CHECK is added only when absent) — safe under `reapplyIfProbeFails`.
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS andon_reason text NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS andon_request_id uuid NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS andon_approval_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'projects'
       AND c.conname = 'projects_andon_reason_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_andon_reason_check
      CHECK (andon_reason IS NULL OR andon_reason IN ('operator', 'move_request'));
  END IF;
END
$$;
