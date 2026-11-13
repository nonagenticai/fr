-- 095_scheduled_trigger_runs_retention_index.sql
--
-- Supporting index for the scheduled_trigger_runs retention reaper
-- (src/workers/scheduled-trigger-run-prune.ts).
--
-- WHY: the table had NO retention of any kind — no TTL column, no prune
-- function, no CronJob (fr ships zero k8s CronJob manifests), no admin
-- endpoint. Measured on prod (worker4, db `fr`) 2026-08-05: 65,822 rows,
-- 2026-05-01 → 2026-08-02. The bulk of that is one dead trigger that
-- re-POSTed to a deleted n8n workflow on every cron slot, writing ~720 rows
-- a day until it was disabled. #752 removed the SOURCE of that growth (a
-- trigger now auto-disables after 3 consecutive permanent 4xx); this bounds
-- the TABLE, which is a separate concern and still unbounded.
--
-- The reaper deletes on `created_at`, and the two existing indexes are
-- (trigger_kind, trigger_id, fired_at DESC) and (project_id, fired_at DESC)
-- — neither has created_at in a usable leading position, so the retention
-- DELETE would seq-scan the whole table every tick forever.
--
-- NB created_at, not fired_at: `fired_at` is when the slot ran and is
-- nullable-in-spirit for rows written by other paths, while `created_at` is
-- the row's own insert stamp with a NOT NULL DEFAULT now(). Retention is a
-- statement about when the ROW was written, so it must key on the column
-- that is always populated. Using fired_at would silently spare any row that
-- ever gets a NULL there.
--
-- CONCURRENTLY is deliberately NOT used: the migration runner wraps each file
-- in a transaction (CREATE INDEX CONCURRENTLY cannot run inside one), and at
-- 65k rows this builds in well under a second.
--
-- ⚠️ THIS INDEX IS ALSO DECLARED IN src/db/schema.ts, and the duplication is
-- load-bearing. This file covers PROD, which has a real migration history and
-- applies it normally. It does NOT cover a freshly provisioned database: CI runs
-- `drizzle-kit push` (from schema.ts) and the migration runner then BACKFILLS
-- `_migrations` with every known filename as a no-op apply, so this file never
-- executes there and the index would simply be absent. Keep the two in sync —
-- the reaper's integration test asserts the index exists by name, and it caught
-- exactly this split by going RED in CI while passing locally.

BEGIN;

CREATE INDEX IF NOT EXISTS scheduled_trigger_runs_created_at_idx
  ON scheduled_trigger_runs (created_at);

COMMIT;
