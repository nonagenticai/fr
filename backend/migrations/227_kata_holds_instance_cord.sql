-- Migration: 227_kata_holds_instance_cord
-- Date: 2026-11-03
--
-- George 2026-11-03: a kata runs entirely on its own n8n (kata-n8n), and while it runs the WHOLE
-- conveyor n8n stops — the kata holds the same instance cord the operator pulls
-- (`n8n/n8n-worker` → 0), as one holder in `andon_state.kata_holders` (migration 225, kept: it
-- IS the holder set). The per-project kata cord (`projects.andon_reason = 'kata'`) is gone, so
-- the reason CHECK goes back to its R318 shape (migration 206).
--
-- Defensive: any project still held by a kata is released first (measured on prod 2026-11-03:
-- none), so the narrowed CHECK cannot fail on an existing row.
--
-- RUNNER CONTRACT: idempotent (the UPDATE matches nothing on a re-run; the CHECK is dropped and
-- re-added only while it still admits 'kata'), mirrored in src/db/schema.ts. No BEGIN/COMMIT — the
-- runner wraps each file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

UPDATE projects
   SET andon_engaged = false,
       andon_engaged_at = NULL,
       andon_engaged_by = NULL,
       andon_reason = NULL,
       andon_request_id = NULL,
       andon_approval_id = NULL
 WHERE andon_reason = 'kata';

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
  ), '') LIKE '%''kata''%' THEN
    ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_andon_reason_check;
    ALTER TABLE projects
      ADD CONSTRAINT projects_andon_reason_check
      CHECK (andon_reason IS NULL OR andon_reason IN ('operator', 'move_request'));
  END IF;
END
$$;
