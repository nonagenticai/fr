-- Migration: 065_andon_global — replace the per-workspace andon cord
-- (064) with a single global state row.
-- Date: 2026-05-18
--
-- The Andon cord is a global safety switch: one click by a super-admin
-- halts every n8n automation across all tenants until released. Not
-- per-tenant; not gated on a reason field. 064 is dropped wholesale
-- (pre-prod, forward-only).

BEGIN;

-- 1. Drop 064 trigger + function before dropping its dependencies.
DROP TRIGGER IF EXISTS trg_workspaces_andon_history ON workspaces;
DROP FUNCTION IF EXISTS workspaces_andon_history_trg();

-- 2. Drop the per-workspace history table from 064.
DROP TABLE IF EXISTS workspaces_andon_history;

-- 3. Drop the per-workspace andon columns + index from 064.
DROP INDEX IF EXISTS idx_workspaces_andon_engaged;
ALTER TABLE workspaces
  DROP COLUMN IF EXISTS andon_engaged,
  DROP COLUMN IF EXISTS andon_engaged_at,
  DROP COLUMN IF EXISTS andon_engaged_by,
  DROP COLUMN IF EXISTS andon_reason;

-- 4. Singleton table holding the global cord state. The CHECK + PK on
-- id=1 enforces a single row at the database level so the application
-- never has to disambiguate which row "global" means.
CREATE TABLE IF NOT EXISTS andon_state (
  id          INT          PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  engaged     BOOLEAN      NOT NULL DEFAULT FALSE,
  engaged_at  TIMESTAMPTZ,
  engaged_by  TEXT
);

INSERT INTO andon_state (id, engaged) VALUES (1, FALSE)
  ON CONFLICT (id) DO NOTHING;

-- 5. Append-only history of every flip, populated by AFTER UPDATE
-- trigger. Audit visibility is the point of an andon — every pull and
-- release leaves a trace.
CREATE TABLE IF NOT EXISTS andon_state_history (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  engaged     BOOLEAN      NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  changed_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_andon_state_history_changed_at
  ON andon_state_history (changed_at DESC);

CREATE OR REPLACE FUNCTION andon_state_history_trg() RETURNS trigger AS $$
BEGIN
    IF NEW.engaged IS DISTINCT FROM OLD.engaged THEN
        INSERT INTO andon_state_history (engaged, changed_by)
        VALUES (NEW.engaged, NEW.engaged_by);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_andon_state_history ON andon_state;
CREATE TRIGGER trg_andon_state_history
    AFTER UPDATE OF engaged ON andon_state
    FOR EACH ROW
    EXECUTE FUNCTION andon_state_history_trg();

COMMIT;
