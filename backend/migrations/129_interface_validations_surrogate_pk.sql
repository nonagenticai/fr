-- backend/migrations/129_interface_validations_surrogate_pk.sql
--
-- interface_validations: replace the (family_id, run_at) PRIMARY KEY with a
-- surrogate BIGSERIAL `id` (fr #1173 audit follow-up, roadmap B1).
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
--
-- Migration 128 keyed the table on (family_id, run_at) with run_at DEFAULT NOW().
-- NOW() is the TRANSACTION start time, so two validation runs for one family
-- inside one transaction get the same run_at and the second INSERT raises 23505
-- (duplicate key). Two runs in separate transactions that start within the same
-- microsecond collide the same way. A run record is an event, not an identity:
-- nothing about (family, time) makes it unique.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
--
-- `id BIGSERIAL PRIMARY KEY`. A sequence value is unique per call regardless of
-- transaction boundaries, and it is monotonic, so "the latest row per family is
-- the current verdict" (128's table comment) is now decidable even when run_at
-- ties: ORDER BY id DESC. interface_validations_family_id_idx (family_id, id)
-- serves that read.
--
-- Measured on prod before writing this (worker4, direct psql, BEGIN READ ONLY,
-- 2026-09-23): 128 applied, PK named interface_validations_pkey, 0 rows —
-- nothing writes the table yet (the interface-validate route is not built).
-- The ADD COLUMN is nonetheless correct on a non-empty table: BIGSERIAL fills
-- existing rows from the new sequence.
--
-- ⛔ src/db/schema.ts declares the same shape (CI builds its DB with drizzle-kit
-- push from it and stamps this file applied WITHOUT executing it).
-- tests/integration/decomposition/family-decisions-claim.integration.test.ts
-- executes 128 + 129 verbatim into a throwaway schema and compares the result
-- with the push-built `public`, so the two emitters cannot drift silently.
--
-- DDL only (no INSERT/UPDATE/DELETE/TRUNCATE/trigger/function), so
-- scripts/check-migration-dml-probed.ts needs no COLUMN_PROBES entry.
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

-- 128 created the PK with an inline PRIMARY KEY clause, so Postgres named it
-- interface_validations_pkey (verified on prod). The second DROP covers a dev DB
-- built by drizzle-kit push from the pre-129 schema.ts, whose composite
-- primaryKey() is named <table>_<cols>_pk.
ALTER TABLE interface_validations DROP CONSTRAINT IF EXISTS interface_validations_pkey;
ALTER TABLE interface_validations DROP CONSTRAINT IF EXISTS interface_validations_family_id_run_at_pk;

ALTER TABLE interface_validations ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE interface_validations ADD CONSTRAINT interface_validations_pkey PRIMARY KEY (id);

CREATE INDEX IF NOT EXISTS interface_validations_family_id_idx
  ON interface_validations (family_id, id);

COMMENT ON COLUMN interface_validations.id IS
  'Surrogate key (migration 129). Replaces the (family_id, run_at) PK, which '
  'collided for two runs in one transaction because run_at defaults to NOW() '
  '(transaction start time). Monotonic: the latest run per family is MAX(id), '
  'which stays decidable when run_at ties.';
