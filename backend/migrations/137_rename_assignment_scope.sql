-- backend/migrations/137_rename_assignment_scope.sql
--
-- RENAME the asset-assignment scope: type `scope_level` -> `assignment_scope`,
-- column `asset_assignments.scope_level` -> `asset_assignments.scope_kind`.
--
-- WHY. fr carried two unrelated things under the one name `scope_level`:
--
--   A. the 8-value work-granularity ladder (multi_repo | repo | app | module |
--      component | file | class | function) — `projects.scope_level` (TEXT +
--      CHECK projects_scope_level_canonical, migration 088), `card_contracts.
--      scope_level` (128), three API routes (POST /api/projects, POST
--      /api/cards/improvement, GET /api/projects/:id/brief), ~1,330 live Planka
--      `Metadata.scope_level` card values, and n8n_custom_nodes. A KEEPS the name.
--   B. the Postgres ENUM `scope_level` (workspace | department | project) and
--      the one column that uses it, `asset_assignments.scope_level`. B lives only
--      in the fr backend, is in no API or OpenAPI contract, and is read by no
--      other repo. B is the one renamed (operator ruling, 2026-09-28).
--
-- `routes/assets/assignments.ts` already called the B value `scope_kind` on the
-- wire, so the column now matches the name its only HTTP surface used.
--
-- MEASURED BEFORE WRITING THIS (prod `fr`, worker4, 2026-09-28, READ ONLY):
--   asset_assignments rows: workspace 5,149 · project 19
--   views / matviews / functions / non-internal triggers referencing the
--   table or the name: 0 / 0 / 0 / 0
--   columns typed `scope_level`: asset_assignments.scope_level only (plus its
--   three indexes, which follow the column by attnum, not by name)
--   live n8n workflows (n8n, n8n_demo, cdmsfirst_n8n) whose nodes mention
--   `asset_assignments`: 0
--
-- METADATA ONLY. Both statements rewrite catalog rows; no table rewrite, no
-- data change, and every index / CHECK over the column follows it by attnum,
-- so asset_assignments_uq_workspace, asset_assignments_uq_with_target,
-- asset_assignments_lookup and the channel CHECK keep working with no DDL of
-- their own. Their NAMES are unchanged.
--
-- Historical migrations 030 / 034 / 053 / 111 still say `scope_level`. That is
-- correct and they must NOT be edited: on a fresh database they run in numeric
-- order BEFORE this file, against the old names, and this file renames the
-- result.
--
-- IDEMPOTENT. Each rename is guarded on the OLD name existing and the NEW name
-- not existing, so a replay (or the runner's reapplyIfProbeFails self-heal) is a
-- no-op, and a `drizzle-kit push`-built CI database — which already has the new
-- names from src/db/schema.ts — passes straight through. Registered in
-- COLUMN_PROBES (src/db/migration-runner.ts) so a database restored from a
-- pre-137 dump with an empty `_migrations` keeps this file PENDING instead of
-- being stamped applied over the old names.
--
-- DEPLOY ORDER. fr-backend runs this at boot, before Bun.serve, in the NEW pod
-- (Deployment `fr`, replicas 1, RollingUpdate maxSurge 1 / maxUnavailable 0).
-- The OLD pod keeps serving until the new one is Ready, and its code still says
-- `scope_level`, so asset-assignment reads/writes on the old pod fail with 42703
-- for that window (seconds; bounded by the new pod's startup + readiness).
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'scope_level'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'assignment_scope'
  ) THEN
    ALTER TYPE scope_level RENAME TO assignment_scope;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'asset_assignments'
       AND column_name = 'scope_level'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'asset_assignments'
       AND column_name = 'scope_kind'
  ) THEN
    ALTER TABLE asset_assignments RENAME COLUMN scope_level TO scope_kind;
  END IF;
END $$;
