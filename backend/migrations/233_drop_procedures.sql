-- Migration: 233_drop_procedures
-- Date: 2026-11-04
--
-- George 2026-11-04: procedure_management is archived and retired, and the procedures asset
-- type is removed from fr completely. The code, tests, frontend, generated client and served
-- OpenAPI document are deleted in the same change; this file is the schema half.
--
--   1. DELETE every 'procedure' row from the six tables typed with the three enums below
--      (asset_assignments, asset_bindings, project_asset_copy_intents, asset_stream_membership,
--      streams, tenant_improvement_projects) — the type rewrites in step 4 would otherwise
--      abort on them.
--   2. DROP TABLE scheduled_reports. Its only template source was a procedure
--      (template_procedure_name NOT NULL); the feature is deleted with procedures.
--      Plain DROP, no CASCADE: nothing references it (no FK; scheduled_trigger_runs keys it
--      by (trigger_kind, trigger_id) without one).
--   3. DROP COLUMN card_contracts.procedure_pins, and narrow
--      scheduled_trigger_runs_trigger_kind_check to 'scheduled_intake' only.
--   4. Recreate asset_type, asset_kind and stream_kind without the 'procedure' label
--      (Postgres cannot drop an enum label). A CHECK that casts a literal to the type (prod's
--      `'channel'::asset_type` on asset_assignments) is dropped first and re-added verbatim.
--
-- MEASURED ON PRODUCTION 2026-11-04, before writing this: asset_assignments 'procedure' 2257
-- rows; asset_bindings, project_asset_copy_intents, asset_stream_membership, streams,
-- tenant_improvement_projects 0; scheduled_reports 0 rows; card_contracts.procedure_pins
-- non-null 0; scheduled_trigger_runs trigger_kind 'scheduled_report' 0. No view, function,
-- column default or partial-index predicate references the three types.
--
-- Migration 142's bulk-delete guard covers asset_assignments (2257 rows go). The hatch is
-- armed with SET LOCAL (transaction-scoped, never a session SET — PgBouncer transaction
-- pooling) and DISARMED at the end, because the runner applies later files in the same outer
-- transaction.
--
-- IDEMPOTENT. DELETEs of rows that are gone delete nothing; DROP ... IF EXISTS; each type
-- rewrite acts only while the live type still carries 'procedure'. A drizzle-kit push-built CI
-- database already has the new shapes from src/db/schema.ts and passes straight through.
-- Probed (COLUMN_PROBES '233_drop_procedures.sql') on schema facts only.
--
-- RUNNER CONTRACT: no BEGIN/COMMIT (the runner wraps each file in a SAVEPOINT inside its outer
-- transaction).

SET LOCAL lock_timeout = '10s';
SET LOCAL fr.allow_destructive = 'on';

DO $fr_233$
DECLARE
  targets text[][] := ARRAY[
    ARRAY['asset_stream_membership', 'asset_kind'],
    ARRAY['asset_bindings', 'asset_kind'],
    ARRAY['project_asset_copy_intents', 'asset_kind'],
    ARRAY['asset_assignments', 'asset_type'],
    ARRAY['tenant_improvement_projects', 'kind'],
    ARRAY['streams', 'kind']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(targets, 1) LOOP
    IF to_regclass(format('public.%I', targets[i][1])) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DELETE FROM public.%I WHERE %I::text = %L', targets[i][1], targets[i][2], 'procedure');
  END LOOP;
END
$fr_233$;

DROP TABLE IF EXISTS scheduled_reports;

ALTER TABLE card_contracts DROP COLUMN IF EXISTS procedure_pins;

ALTER TABLE scheduled_trigger_runs DROP CONSTRAINT IF EXISTS scheduled_trigger_runs_trigger_kind_check;
ALTER TABLE scheduled_trigger_runs
  ADD CONSTRAINT scheduled_trigger_runs_trigger_kind_check
  CHECK (trigger_kind IN ('scheduled_intake'));

DO $fr_233$
DECLARE
  types text[] := ARRAY['asset_type', 'asset_kind', 'stream_kind'];
  labels text[] := ARRAY[
    $$'requirement', 'principle', 'decision', 'kag_document', 'workflow', 'trigger', 'artifact', 'channel'$$,
    $$'workflow', 'prompt', 'kag_source', 'coding_repository', 'requirement', 'principle', 'decision', 'artifact', 'card'$$,
    $$'workflow', 'prompt', 'principle', 'requirement', 'decision'$$
  ];
  typ text;
  i int;
  col record;
  con record;
  saved text[][];
  j int;
BEGIN
  FOR i IN 1 .. array_length(types, 1) LOOP
    typ := types[i];
    IF NOT EXISTS (
      SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = typ AND e.enumlabel = 'procedure'
    ) THEN
      CONTINUE;
    END IF;

    -- CHECKs that cast a literal to this type: saved, dropped, re-added after the rewrite.
    saved := ARRAY[]::text[][];
    FOR con IN
      SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%::' || typ || '%'
    LOOP
      saved := saved || ARRAY[ARRAY[con.tbl, con.conname, con.def]];
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', con.tbl, con.conname);
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = typ || '_old'
    ) THEN
      EXECUTE format('DROP TYPE %I', typ || '_old');
    END IF;

    EXECUTE format('ALTER TYPE %I RENAME TO %I', typ, typ || '_old');
    EXECUTE format('CREATE TYPE %I AS ENUM (%s)', typ, labels[i]);
    FOR col IN
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND udt_name = typ || '_old'
    LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE %I USING %I::text::%I',
        col.table_name, col.column_name, typ, col.column_name, typ);
    END LOOP;

    IF array_length(saved, 1) IS NOT NULL THEN
      FOR j IN 1 .. array_length(saved, 1) LOOP
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', saved[j][1], saved[j][2], saved[j][3]);
      END LOOP;
    END IF;

    EXECUTE format('DROP TYPE %I', typ || '_old');
  END LOOP;
END
$fr_233$;

SET LOCAL fr.allow_destructive = 'off';
