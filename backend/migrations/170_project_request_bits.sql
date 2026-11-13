-- Migration: 170_project_request_bits
-- Date: 2026-10-09
-- Refs: U-PS-S0 (fr half) — PROJECT-START-PROCESS-DESIGN §6.3 step 2, §7
--       `request_bit_unknown`, §12.2.
--
-- `project_requests.request_bits`: the DISCRIMINATING request bits a template
-- start selects on (pm utils/template_predicates.py REQUEST_BITS), each with its
-- `bit_source`:
--   { "has_feature_statement":  {"value": true|false|null, "bit_source": "form"|"extracted"|"unknown"},
--     "has_interface_contract": {...},
--     "has_bdd_ac":             {...} }
-- value NULL <=> bit_source 'unknown' (a 3-sample disagreement, or never
-- assessed). `repo_count` is NOT stored: it is computed from the request's repo
-- list on read (lib/request-bits.ts requestBitVector), so it cannot go stale.
--
-- fr stores, validates and exposes; the 3-of-3 extraction is ncn's (E18).
-- Shape is validated in zod (lib/request-bits.ts); the DB guards only that the
-- column is an object.
--
-- NULLABLE, NO BACKFILL, NO BEHAVIOUR CHANGE: NULL = not recorded (every
-- existing request), which a reader treats as every bit unknown.
--
-- RUNNER CONTRACT: pure DDL; mirrored in src/db/schema.ts. No BEGIN/COMMIT.

ALTER TABLE project_requests
  ADD COLUMN IF NOT EXISTS request_bits jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_requests_request_bits_object_check'
       AND conrelid = 'project_requests'::regclass
  ) THEN
    ALTER TABLE project_requests
      ADD CONSTRAINT project_requests_request_bits_object_check
      CHECK (request_bits IS NULL OR jsonb_typeof(request_bits) = 'object');
  END IF;
END$$;

COMMENT ON COLUMN project_requests.request_bits IS
  'U-PS-S0 discriminating request bits {bit: {value, bit_source}}; NULL = not recorded. Authority: backend/migrations/170_project_request_bits.sql.';
