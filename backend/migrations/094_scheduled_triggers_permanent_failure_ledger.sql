-- 094: scheduled_triggers.permanent_failure_count + .disabled_reason —
-- the consecutive-failure ledger behind the permanent-4xx auto-disable.
--
-- Auto-disable on the FIRST permanent status was too sharp an edge. n8n answers
-- `404 Received request for unknown webhook` for a workflow that is merely
-- DEACTIVATED — a normal, transient state during an edit or a redeploy — so a
-- single-404 rule would permanently switch off a healthy customer trigger for
-- the duration of someone else's save. The count makes the worker require N
-- CONSECUTIVE permanent failures (PERMANENT_FAILURE_DISABLE_THRESHOLD in
-- src/workers/scheduled-trigger-tick.ts) before it takes that action, and any
-- successful dispatch resets it to 0 — so the edit window has to persist across
-- three whole cron slots before a trigger is touched.
--
-- NOT NULL DEFAULT 0: every pre-094 row starts the ledger clean. Existing rows
-- that are ALREADY failing get three fresh slots before they are disabled, which
-- is the correct conservative reading — this migration must never disable
-- anything by itself.
ALTER TABLE scheduled_triggers
    ADD COLUMN IF NOT EXISTS permanent_failure_count INTEGER NOT NULL DEFAULT 0;

-- disabled_reason: the DURABLE marker distinguishing an auto-disable from a
-- human one. `enabled = false` alone is ambiguous — an operator reading a
-- disabled row cannot tell whether a colleague switched it off deliberately or
-- whether the worker did it, and the difference decides whether the right action
-- is "re-enable it" or "fix the webhook first". The worker writes a stable
-- machine-readable token here; a human disable (PATCH .../:id {enabled:false})
-- leaves it NULL, and a human RE-ENABLE clears it along with the counter so a
-- repaired trigger does not inherit a stale strike count and die on its first
-- 404. Free-form TEXT rather than an enum/CHECK: this is an operator-facing
-- diagnostic, and a future reason must not require a migration to record.
ALTER TABLE scheduled_triggers
    ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
