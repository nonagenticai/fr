-- Migration: 225_kata_andon
-- Date: 2026-11-01
--
-- Kata WP2 (rulings K1, K17, K19, George 2026-10-31): two andon cords a kata pulls and
-- releases itself.
--
--   projects.andon_reason 'kata'  — the PROJECT cord, held by a kata. `andon_request_id`
--                                   carries the kata project id: the release is a CAS on
--                                   (reason 'kata', request_id = that kata), so a kata releases
--                                   only its own hold and never an operator or move cord.
--   andon_state.kata_holders      — the SYSTEM-WIDE kata cord: the kata project ids holding it.
--                                   Non-empty = every project that is not a kata is held (a kata =
--                                   a holder, or a kata holding a project cord).
--                                   It never deactivates workflows (the kata runs on the same
--                                   flows); the operator's global cord (`engaged`) is unchanged.
--
-- RUNNER CONTRACT: pure DDL, mirrored in src/db/schema.ts, idempotent (the CHECK is dropped and
-- re-added only while it lacks 'kata'). No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

ALTER TABLE andon_state ADD COLUMN IF NOT EXISTS kata_holders uuid[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF COALESCE((
    SELECT pg_get_constraintdef(c.oid)
      FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'projects'
       AND c.conname = 'projects_andon_reason_check'
  ), '') NOT LIKE '%''kata''%' THEN
    ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_andon_reason_check;
    ALTER TABLE projects
      ADD CONSTRAINT projects_andon_reason_check
      CHECK (andon_reason IS NULL OR andon_reason IN ('operator', 'move_request', 'kata'));
  END IF;
END
$$;
