-- backend/migrations/050_streams_slug.sql
--
-- Streams Frontend Removal plan, Task 1.1 (2026-05-04).
--
-- Adds a stable per-tenant `slug` to `streams` so n8n custom-node aggregator
-- credentials can resolve the system-tenant baseline streams by name instead
-- of UUID. The two baselines:
--
--   tenant 00000000-0000-4000-8000-000000000001 (workflow) → '__system_workflow__'
--   tenant 00000000-0000-4000-8000-000000000002 (prompt)   → '__system_prompt__'
--
-- Forward-only: the create-stream code path now requires `slug`. Any
-- pre-existing rows that came in via the application path before this
-- migration get backfilled by the UPDATEs below; on a fresh DB those are
-- no-ops, and the 2 baseline rows materialize the first time
-- POST /api/assets/streams (or the AG-UI streams.create action) is called
-- against the matching system tenant.
--
-- NOTE: no BEGIN/COMMIT here — the migration runner wraps every file in a
-- SAVEPOINT inside an outer transaction (see src/db/migration-runner.ts).
-- Explicit BEGIN/COMMIT inside the file would COMMIT the outer tx and break
-- the next file's SAVEPOINT.

ALTER TABLE streams ADD COLUMN IF NOT EXISTS slug text;

-- Defensive backfill for any rows that may already exist from before this
-- migration ran. No-op on fresh DBs; idempotent on re-run.
UPDATE streams
SET slug = '__system_workflow__'
WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
  AND kind = 'workflow'
  AND slug IS NULL;

UPDATE streams
SET slug = '__system_prompt__'
WHERE tenant_id = '00000000-0000-4000-8000-000000000002'
  AND kind = 'prompt'
  AND slug IS NULL;

ALTER TABLE streams ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS streams_tenant_slug_uniq
  ON streams (tenant_id, slug);
