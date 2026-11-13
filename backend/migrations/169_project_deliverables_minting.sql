-- Migration: 169_project_deliverables_minting
-- Date: 2026-10-09
-- Refs: U-PS-COMMIT (fr half) — PROJECT-START-PROCESS-DESIGN §4 (rolling-wave
--       minting), §12.2; CONVEYOR-TAXONOMY-DESIGN D4, §4 U-PS-COMMIT (amended).
--
-- Deliverables != cards. Promote writes EVERY template deliverable as a
-- project_deliverables row (so the 3..7 rule holds at commit), but the
-- decomposition commit mints cards only for the NON-deferred ones. A deferred
-- deliverable names its `minter` (pm template Deliverable.minter, <=255 chars);
-- that minter attaches its cards later and then reports how many it minted via
-- POST /api/projects/:id/deliverables/:did/minted {count}, which stamps
-- `minted_at` + `minted_count` exactly once (idempotent replay, 409 on a
-- different count).
--
-- Completion (lib/deliverable-complete.ts, read by PR H's planPhaseExit):
--   fixed    — every attached card DONE;
--   deferred — minted_at set AND every attached card DONE; minted_count = 0
--              (a 0-finding hunt) is complete.
--
-- ADDITIVE, NO BACKFILL, NO BEHAVIOUR CHANGE: every existing row reads
-- deferred=false and NULL minter/minted_*, which is exactly today's semantics
-- (every deliverable minted at commit).
--
-- Named CHECKs (mirrored in src/db/schema.ts — two emitters of one shape):
--   * deferred ⇒ minter: a deferred deliverable with no minter is one nobody
--     will ever mint, i.e. a phase that can never exit;
--   * minted_at and minted_count are a pair;
--   * only a deferred deliverable is ever stamped minted;
--   * minted_count >= 0.
--
-- RUNNER CONTRACT: pure DDL; no BEGIN/COMMIT.

ALTER TABLE project_deliverables
  ADD COLUMN IF NOT EXISTS deferred boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS minter text,
  ADD COLUMN IF NOT EXISTS minted_at timestamptz,
  ADD COLUMN IF NOT EXISTS minted_count integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_deliverables_minting_check'
       AND conrelid = 'project_deliverables'::regclass
  ) THEN
    ALTER TABLE project_deliverables
      ADD CONSTRAINT project_deliverables_minting_check
      CHECK (
        (NOT deferred OR minter IS NOT NULL)
        AND ((minted_at IS NULL) = (minted_count IS NULL))
        AND (minted_at IS NULL OR deferred)
        AND (minted_count IS NULL OR minted_count >= 0)
      );
  END IF;
END$$;

COMMENT ON COLUMN project_deliverables.deferred IS
  'true = no card minted at decomposition commit; the named minter attaches cards later (U-PS-COMMIT). Authority: backend/migrations/169_project_deliverables_minting.sql.';
COMMENT ON COLUMN project_deliverables.minter IS
  'The pm template Deliverable.minter that mints this deliverable''s cards. Required when deferred.';
COMMENT ON COLUMN project_deliverables.minted_at IS
  'When the minter reported its last create (POST .../deliverables/:did/minted). NULL = minter has not fired.';
COMMENT ON COLUMN project_deliverables.minted_count IS
  'How many cards the minter created; 0 = nothing to mint (e.g. a 0-finding hunt) and the deliverable is complete.';
