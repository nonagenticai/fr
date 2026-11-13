-- backend/migrations/102_router_dedupe_planka_scope_id.sql
--
-- `router_dedupe.tenant_id` NEVER HELD A TENANT. Rename it to what it is.
--
-- The column is written by exactly one caller — POST /api/webhooks/n8n/router-
-- dedupe (`handleN8nRouterDedupe`) — which takes the value verbatim from the
-- n8n AA router node `atomic-dedupe-fr`:
--
--     tenant_id: String(ev.keycloak_tenant_id || ev.boardId || 'unknown')
--
-- and `keycloak_tenant_id` is itself `String(item.projectId || '')`. Both arms
-- are PLANKA ids (project id / board id) — snowflake-shaped integers, never a
-- tenant uuid. All 53 live rows are that shape. Nothing anywhere READS the
-- column as a tenant: it exists solely as the leading segment of the dedupe
-- partition key `(…, card_id, list_id, updated_at_sec)`.
--
-- ⛔ THIS IS A RENAME, NOT A TYPE MIGRATION. Converting the column to `uuid`
-- (the reflex for a badly-typed `tenant_id`) would be destructive: a Planka
-- snowflake is not a uuid, every existing row would fail the cast, and the
-- working dedupe key would be destroyed. The column's TYPE is correct; only its
-- NAME was a lie. `text` stays.
--
-- The PRIMARY KEY and the `router_dedupe_created_at_idx` index survive a column
-- rename unchanged (Postgres renames the column in the constraint definition),
-- so no index/constraint work is needed here.
--
-- Drift-tolerant: renames only when the old name is present and the new one is
-- not, so re-application (or a DB that already carries the new name, e.g. one
-- bootstrapped after this landed) is a clean no-op rather than an error.
--
-- No BEGIN/COMMIT — the migration runner wraps every file in a SAVEPOINT inside
-- an outer transaction (see src/db/migration-runner.ts).

DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'router_dedupe' AND column_name = 'tenant_id'
      )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'router_dedupe' AND column_name = 'planka_scope_id'
      )
  THEN
    ALTER TABLE router_dedupe RENAME COLUMN tenant_id TO planka_scope_id;
  END IF;
END $$;
