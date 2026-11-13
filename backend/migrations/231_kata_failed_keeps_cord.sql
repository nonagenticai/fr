-- Migration: 231_kata_failed_keeps_cord
-- Date: 2026-11-04
--
-- George 2026-11-04: a failed kata does NOT release the conveyor cord. Nothing continues on a
-- timer; only a super-admin releases it (POST /api/katas/:id/release, services/katas/core.ts
-- releaseFailedKata). The release is recorded here: who (cord_released_by) and when
-- (cord_released_at). A failed kata holds the cord exactly while cord_released_at IS NULL.
--
-- And the signature is the kata's identity (K1): every open carries one and a PATCH may never
-- change or clear it, so the column is NOT NULL. The table held 0 rows in prod when this shipped;
-- SET NOT NULL is a no-op on a column that already is.
--
-- RUNNER CONTRACT: pure DDL; mirrored in src/db/schema.ts; probed for the four columns and the
-- NOT NULL. Idempotent — safe under `reapplyIfProbeFails`. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE katas ADD COLUMN IF NOT EXISTS cord_released_at timestamptz;
ALTER TABLE katas ADD COLUMN IF NOT EXISTS cord_released_by text;
ALTER TABLE katas ALTER COLUMN signature SET NOT NULL;

-- A coach repeat whose rollback the guard refused (no base_version_id, or a later kata published
-- on the same target_flow): recorded so /admin/kata can show it. Nothing was requested.
ALTER TABLE katas ADD COLUMN IF NOT EXISTS rollback_refused_at timestamptz;
ALTER TABLE katas ADD COLUMN IF NOT EXISTS rollback_refused_reason text;
