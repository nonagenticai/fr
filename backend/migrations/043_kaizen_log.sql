-- Plan 5 Stage 1.3 — kaizen_log.
--
-- The DONE phase of every improvement loop card writes one row here.
-- UNIQUE (kaizen_card_id) makes POST /api/kaizen/log idempotent on
-- webhook retries — a re-emit of the same DONE event finds the existing
-- row and returns it instead of double-writing.
--
-- This is distinct from `kaizen_candidates` (migration 029) which holds
-- ad-hoc execution candidates *before* they enter a loop; kaizen_log
-- captures the loop's final outcome with measured deltas.

CREATE TABLE kaizen_log (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kaizen_card_id         text NOT NULL UNIQUE,
    stream_id              uuid NOT NULL REFERENCES streams(id) ON DELETE RESTRICT,
    asset_kind             asset_kind NOT NULL,
    asset_id               uuid NOT NULL,
    card_type              text NOT NULL,
    -- 'workflow_redesign' | 'workflow_development' | 'prompt_redesign' | ...
    action                 text NOT NULL,
    -- 'promoted' | 'analysis_recorded' | 'rolled_back' | ...
    old_version            integer,
    new_version            integer,
    predicted_deltas       jsonb NOT NULL DEFAULT '{}'::jsonb,
    measured_deltas        jsonb NOT NULL DEFAULT '{}'::jsonb,
    replay_run_id          uuid,
    canary_window_minutes  integer,
    approved_by            uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kaizen_log_stream_created_idx
    ON kaizen_log (stream_id, created_at DESC);

CREATE INDEX kaizen_log_asset_idx
    ON kaizen_log (asset_kind, asset_id, created_at DESC);

COMMENT ON TABLE kaizen_log IS
    'Plan 5/6 outcome log. One row per improvement card that reached '
    'DONE. UNIQUE on kaizen_card_id makes POST /api/kaizen/log '
    'idempotent on webhook retries.';
