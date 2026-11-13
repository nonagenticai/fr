-- Migration: 212_drop_approval_triage_columns
-- Date: 2026-10-25
--
-- Cockpit A5 (FR-COCKPIT-IMPL-PLAN-2026-10-25.md §1 F7): drop the dead `approvals.triage_*`
-- columns that migration 101 added, and their CHECK `approvals_triage_verdict_check`.
--
-- WHY IT IS SAFE NOW. The columns were write-only from the start and have not been written since
-- 2026-09-23 (tests/unit/routes/triage-column-retirement.test.ts pinned that every insert and
-- .set() in backend/src stopped naming them). The ordering rule recorded on the schema — a column
-- may not be dropped in the release that still writes it — is met: every image since has written
-- none of them, so no lagging pod can INSERT into a dropped column. Nothing reads them either
-- (measured on origin/main 9aed7e132: no reader in backend/src or frontend/src). Forward-only, no
-- shim. Removed from src/db/schema.ts in the same change, so both emitters agree.
--
-- RUNNER CONTRACT: probed by its own receipt in `_migration_effects` AND the column's absence.
-- A column-absence probe alone would be vacuous on a push-built database (schema.ts no longer
-- declares the columns), and there migration 101 still runs (its probe reads an index push does
-- not create) and re-adds them — so this file must run after it, which only the receipt
-- guarantees. Idempotent: DROP ... IF EXISTS and ON CONFLICT DO NOTHING.
-- No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_triage_verdict_check;
ALTER TABLE approvals DROP COLUMN IF EXISTS triage_verdict;
ALTER TABLE approvals DROP COLUMN IF EXISTS triage_actor;
ALTER TABLE approvals DROP COLUMN IF EXISTS triage_rationale;
ALTER TABLE approvals DROP COLUMN IF EXISTS triage_at;

CREATE TABLE IF NOT EXISTS _migration_effects (
  migration   TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO _migration_effects (migration, detail)
VALUES ('212_drop_approval_triage_columns.sql', '{"dropped":["triage_verdict","triage_actor","triage_rationale","triage_at"]}'::jsonb)
ON CONFLICT (migration) DO NOTHING;
