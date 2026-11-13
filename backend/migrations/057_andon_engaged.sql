-- Spec ref: 2026-05-04 user request — andon-cord substrate.
--
-- Adds the (engaged, engaged_at, engaged_by) triple to both `projects`
-- and `streams`. The cord is "engaged" when the boolean is TRUE — every
-- automated loop tick (scheduled triggers, scheduled reports, suggestion
-- heuristic, future improvement n8n loops) pre-flight-checks this column
-- and skips engaged rows.
--
-- Improvement streams default-engage on creation and on backfill so the
-- (currently disabled) n8n improvement loops are inert when eventually
-- enabled. A human must explicitly disengage via the super-admin page or
-- POST /api/library/streams/:id/andon/disengage.

BEGIN;

-- projects.andon_*
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS andon_engaged       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS andon_engaged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS andon_engaged_by    TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_andon_engaged
  ON projects (andon_engaged) WHERE andon_engaged = TRUE;

-- streams.andon_*
ALTER TABLE streams
  ADD COLUMN IF NOT EXISTS andon_engaged       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS andon_engaged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS andon_engaged_by    TEXT;

CREATE INDEX IF NOT EXISTS idx_streams_andon_engaged
  ON streams (andon_engaged) WHERE andon_engaged = TRUE;

-- Backfill: ENGAGE the cord on every existing improvement stream so the
-- (not-yet-enabled) n8n loops are inert when wired up. Recorded as a
-- system-initiated engagement.
UPDATE streams
   SET andon_engaged = TRUE,
       andon_engaged_at = NOW(),
       andon_engaged_by = 'system:migration-050'
 WHERE andon_engaged = FALSE;

-- New improvement streams default-engage. Done via a trigger so future
-- INSERTs into `streams` (e.g. from a future provisioning surface) keep
-- the default-engage invariant without relying on application-side code.
CREATE OR REPLACE FUNCTION default_engage_andon_on_streams() RETURNS trigger AS $$
BEGIN
    IF NEW.andon_engaged IS NULL OR NEW.andon_engaged = FALSE THEN
        NEW.andon_engaged := TRUE;
        NEW.andon_engaged_at := NOW();
        NEW.andon_engaged_by := COALESCE(NEW.andon_engaged_by, 'system:default-on-stream-create');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_streams_default_engage_andon ON streams;
CREATE TRIGGER trg_streams_default_engage_andon
    BEFORE INSERT ON streams
    FOR EACH ROW
    EXECUTE FUNCTION default_engage_andon_on_streams();

COMMIT;
