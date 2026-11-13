-- Migration: 096_canary_rollback_events_procedure_kind
-- Date: 2026-08-05
--
-- WHY: migration 031 created `canary_rollback_events` with an inline
--   kind TEXT NOT NULL CHECK (kind IN ('prompt', 'workflow'))
-- because at the time only two auto-rollback emitters existed (inference-router
-- → 'prompt', worker_management → 'workflow').
--
-- Migration 066 then built the ENTIRE procedure-improvement surface — the
-- `procedure` stream_kind label, the reserved `procedure-improvement` workspace
-- (…0005) and a rebuilt `streams_kind_tenant_check` — but never widened THIS
-- check. The omission is silent in both directions:
--
--   * READ: services/improvement/procedures.ts `loadRollbackEvents()` selects
--     `WHERE kind = 'procedure'` to populate `rollback_options.rollback_events`
--     and `active_project.recent_rollbacks`. That predicate can never match a
--     row, so the admin observatory has shown zero procedure rollbacks since the
--     day it shipped — a dead read, not an empty one.
--   * WRITE: any emitter persisting kind='procedure' gets a hard Postgres 23514
--     check_violation. This is exactly why
--     tests/integration/routes/admin-improvement-procedures.integration.test.ts
--     could not seed its fixture and failed in beforeAll.
--
-- Fix: widen the CHECK to also accept 'procedure'. Deliberately a WIDENING and
-- not a DROP — 'prompt' | 'workflow' | 'procedure' stays a closed set so a typo
-- or an unknown emitter is still rejected at the database.
--
-- CONSTRAINT NAME IS DISCOVERED, NEVER GUESSED. 031 declared the check INLINE on
-- the column, so Postgres auto-named it (`canary_rollback_events_kind_check`),
-- while a drizzle-kit-push CI database gets the name from the table-level
-- `check()` in schema.ts. Those happen to agree today, but a hardcoded
-- `DROP CONSTRAINT IF EXISTS <guess>` would silently no-op if they ever did not
-- — leaving the narrow constraint in place while the migration reported success
-- (the failure mode migration 090 documents for FKs). So we introspect
-- pg_constraint for every single-column CHECK on the `kind` column and drop what
-- is actually there, by its real name.
--
-- Forward-only / additive / idempotent:
--   * `to_regclass` guard → total no-op when the table does not exist.
--   * early RETURN when a kind CHECK already admits 'procedure' (re-run, or a
--     fresh push-bootstrapped DB built from the updated schema.ts).
--   * the DROP loop + ADD are name-independent, so re-running converges.
-- No data change: widening a CHECK can never invalidate an existing row.

BEGIN;

DO $$
DECLARE
    tbl          oid;
    kind_attnum  smallint;
    con          record;
    dropped      int := 0;
BEGIN
    tbl := to_regclass('public.canary_rollback_events');
    IF tbl IS NULL THEN
        RAISE NOTICE '096: canary_rollback_events does not exist; nothing to do.';
        RETURN;
    END IF;

    SELECT a.attnum
      INTO kind_attnum
      FROM pg_attribute a
     WHERE a.attrelid = tbl
       AND a.attname  = 'kind'
       AND a.attnum   > 0
       AND NOT a.attisdropped;

    IF kind_attnum IS NULL THEN
        RAISE NOTICE '096: canary_rollback_events has no kind column; nothing to do.';
        RETURN;
    END IF;

    -- Already widened? Then this is a re-run (or a drizzle-push DB built from
    -- the updated schema.ts). Do NOT drop/re-add — churning the constraint for
    -- no reason would rewrite-scan the table on every migration run.
    IF EXISTS (
        SELECT 1
          FROM pg_constraint c
         WHERE c.conrelid = tbl
           AND c.contype  = 'c'
           AND array_length(c.conkey, 1) = 1
           AND c.conkey[1] = kind_attnum
           AND pg_get_constraintdef(c.oid) LIKE '%procedure%'
    ) THEN
        RAISE NOTICE '096: kind CHECK already admits procedure; skipping.';
        RETURN;
    END IF;

    -- Drop by DISCOVERED name. Scoped to single-column CHECKs on `kind` so no
    -- other constraint on this table can be caught by the sweep.
    FOR con IN
        SELECT c.conname
          FROM pg_constraint c
         WHERE c.conrelid = tbl
           AND c.contype  = 'c'
           AND array_length(c.conkey, 1) = 1
           AND c.conkey[1] = kind_attnum
    LOOP
        EXECUTE format('ALTER TABLE canary_rollback_events DROP CONSTRAINT %I', con.conname);
        dropped := dropped + 1;
        RAISE NOTICE '096: dropped narrow kind CHECK %.', con.conname;
    END LOOP;

    -- Re-add under the canonical name schema.ts declares, so the CI/prod CHECK
    -- parity assertion in tests/integration/services/db-invariants can pin it.
    EXECUTE $ddl$
        ALTER TABLE canary_rollback_events
          ADD CONSTRAINT canary_rollback_events_kind_check
          CHECK (kind IN ('prompt', 'workflow', 'procedure'))
    $ddl$;

    RAISE NOTICE '096: kind CHECK widened to (prompt, workflow, procedure) after % drop(s).', dropped;
END $$;

COMMIT;
