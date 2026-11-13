-- Migration: 150_decomposition_split_provenance
-- Date: 2026-10-01
--
-- ncn#1960 — the Readying split (POST /api/decompositions/split) records ONE
-- `decompositions` family per split parent card, and the family carries WHO
-- decided the split and WHY:
--
--   computed_by  'rule'      a deterministic rule split the card (the D2
--                            coherence check excuses a rule-computed family)
--                'invest_t'  the INVEST-T split judge decided it
--   reason       <= 200 chars, the one-line rationale the caller sent
--
-- ⛔ NULLABLE ON PURPOSE, NO BACKFILL (pre-prod is forward-only). A NULL
-- `computed_by` is a family recorded by POST /api/decompositions/commit (the
-- C1-58 deliverable minter), which is not a split; the split route treats an
-- existing NULL-computed_by family under the same id as a conflict.
--
-- The CHECKs are written so NULL passes (a commit family has neither).

ALTER TABLE decompositions ADD COLUMN IF NOT EXISTS computed_by TEXT;
ALTER TABLE decompositions ADD COLUMN IF NOT EXISTS reason TEXT;

ALTER TABLE decompositions DROP CONSTRAINT IF EXISTS decompositions_computed_by_check;
ALTER TABLE decompositions ADD CONSTRAINT decompositions_computed_by_check
  CHECK (computed_by IS NULL OR computed_by IN ('rule', 'invest_t'));

ALTER TABLE decompositions DROP CONSTRAINT IF EXISTS decompositions_reason_length_check;
ALTER TABLE decompositions ADD CONSTRAINT decompositions_reason_length_check
  CHECK (reason IS NULL OR char_length(reason) <= 200);

COMMENT ON COLUMN decompositions.computed_by IS
  'Readying split only (ncn#1960): rule | invest_t. NULL = a C1-58 commit family, not a split.';
COMMENT ON COLUMN decompositions.reason IS
  'Readying split only (ncn#1960): the caller''s one-line split rationale (<= 200 chars).';
