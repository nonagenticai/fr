-- Migration: 047_scheduled_triggers_from_suggestion — Spec 2 Plan 2-D Phase 8
-- Date: 2026-05-01
-- Spec ref: docs/archive/2026-04-27-continuous-project-model-design.md §9
-- Plan ref: confirmed-spec-2-spicy-breeze.md Phase 8 (Plan 2-D UI surfaces)
--
-- Adds a nullable `from_suggestion_id` column to `scheduled_triggers`.
-- Set by the Phase 5 accept handler (POST /api/suggested-schedules/:id/accept)
-- when promoting a suggestion → trigger, so the FE channels detail page can
-- render a "from suggestion #<short-id>" provenance badge linking back to
-- the project streams Suggestion Inbox (Phase 8 Task 8.4).
--
-- Direct hand-created triggers (POST /api/scheduled-triggers) leave the
-- column NULL. There is no FK constraint here on purpose:
--   - suggested_schedules already FKs the OTHER direction
--     (promoted_trigger_id → scheduled_triggers.id ON DELETE SET NULL),
--   - this column is read-only after insert (the accept handler is the
--     sole writer) and is referentially soft — if the source suggestion
--     row ever gets manually deleted (it shouldn't, status='accepted' is
--     a terminal state) we'd rather keep the trigger than cascade-orphan
--     it. The badge just degrades to a dangling link in that edge case.
--
-- All DDL is idempotent (IF NOT EXISTS). Pre-prod, forward-only — see memory
-- `feedback-no-backwards-compat-pre-prod.md`.

BEGIN;

ALTER TABLE scheduled_triggers
  ADD COLUMN IF NOT EXISTS from_suggestion_id uuid;

COMMIT;
