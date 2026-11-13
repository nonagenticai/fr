-- Migration: 085_andon_history_app_recorded — record the ACTOR of every global
-- andon flip (engage AND release), and move history recording from the DB
-- trigger into the application layer.
-- Date: 2026-06-25
--
-- Until now `andon_state_history` was populated by an AFTER-UPDATE trigger
-- (migration 065) that copied `NEW.engaged_by`. The engage/disengage handler
-- nulls `engaged_by` on release (it means "who currently holds the cord"), so
-- every RELEASE history row had a NULL actor — you could see who pulled the
-- emergency stop but never who released it.
--
-- Fix: the handlers now INSERT the history row explicitly with the acting
-- super-admin's identity on both transitions (see routes/andon.ts
-- recordAndonFlip). Drop the trigger + function so the app is the single
-- recorder (no double insert). The append-only `andon_state_history` table is
-- unchanged. Pre-existing release rows keep their NULL actor (unrecoverable).
--
-- NOTE: in CI the trigger never existed (the test DB is built via drizzle-kit
-- push, which does not manage triggers); DROP ... IF EXISTS is a no-op there
-- and runs for real in prod. Forward-only, pre-prod.

BEGIN;

DROP TRIGGER IF EXISTS trg_andon_state_history ON andon_state;
DROP FUNCTION IF EXISTS andon_state_history_trg();

COMMIT;
