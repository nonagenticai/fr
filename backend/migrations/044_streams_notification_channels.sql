-- Plan 5 Stage 1.4 — per-stream notification channel config.
--
-- The improvement loops fire notifications on three events: 'design'
-- (GATE 1 created), 'release' (GATE 2 created), 'rollback' (canary
-- auto-rollback), 'done' (kaizen_log entry written). Per-stream
-- configuration lets operators target specific channels (a Signal
-- group, a Teams channel, an email distro list, an in-app inbox)
-- per event without per-user channel-prefs gymnastics.
--
-- Spec 3 §8.1 DONE phase: "Notify channels per stream config."
-- Shape: array of { kind, target, on: [event, ...] }.

ALTER TABLE streams
    ADD COLUMN IF NOT EXISTS notification_channels jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A simple shape check at write time. Validates the JSON is an array;
-- per-row entry validation happens in the application layer via zod.
DO $$
BEGIN
    ALTER TABLE streams
        ADD CONSTRAINT streams_notification_channels_is_array
        CHECK (jsonb_typeof(notification_channels) = 'array');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

COMMENT ON COLUMN streams.notification_channels IS
    'Plan 5 Stage 1.4. Array of {kind:''signal''|''teams''|''email''|''inapp'', '
    'target:string, on:(''design''|''release''|''rollback''|''done'')[]}. '
    'Empty default = no per-stream notifications; user channel-prefs '
    'still apply to required-approver fan-out.';
