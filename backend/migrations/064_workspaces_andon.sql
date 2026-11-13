-- Migration: 064_workspaces_andon — Plan 6 W1 (Andon Cord, tenant-level)
-- Date: 2026-05-18
-- Plan ref: ~/.claude/plans/plan-is-at-floating-patterson.md (W1)
--
-- Extends the andon-cord substrate (migration 057) from per-project +
-- per-stream to per-tenant. The header AndonCord button reflects this
-- column and toggles it; the n8n `andon-check` sub-workflow consults
-- the matching internal endpoint and silently halts when ENGAGED.
--
-- Shape mirrors projects.andon_* / streams.andon_* (boolean + timestamp
-- + actor). Adds `andon_reason` (free-text) because the header pull is
-- always interactive and an audit reason is mandatory on stop.
--
-- History: a sister table `workspaces_andon_history` records every flip
-- via an AFTER UPDATE trigger. Visibility is the point of an andon —
-- every pull and release must leave a trace.
--
-- Pre-prod, forward-only. All DDL idempotent.

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS andon_engaged    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS andon_engaged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS andon_engaged_by TEXT,
  ADD COLUMN IF NOT EXISTS andon_reason     TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_andon_engaged
  ON workspaces (andon_engaged) WHERE andon_engaged = TRUE;

CREATE TABLE IF NOT EXISTS workspaces_andon_history (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engaged      BOOLEAN      NOT NULL,
  changed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  changed_by   TEXT,
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_andon_history_ws_changed
  ON workspaces_andon_history (workspace_id, changed_at DESC);

CREATE OR REPLACE FUNCTION workspaces_andon_history_trg() RETURNS trigger AS $$
BEGIN
    IF NEW.andon_engaged IS DISTINCT FROM OLD.andon_engaged THEN
        INSERT INTO workspaces_andon_history (workspace_id, engaged, changed_by, reason)
        VALUES (NEW.id, NEW.andon_engaged, NEW.andon_engaged_by, NEW.andon_reason);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workspaces_andon_history ON workspaces;
CREATE TRIGGER trg_workspaces_andon_history
    AFTER UPDATE OF andon_engaged ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION workspaces_andon_history_trg();

COMMIT;
