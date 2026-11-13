-- Migration: 142_destructive_statement_guard
-- Date: 2026-09-30
--
-- REFUSE TRUNCATE AND BULK DELETE ON fr's IRREPLACEABLE TABLES (fr#1283).
--
-- ── WHERE THE AUTHORITY LIVES ─────────────────────────────────────────────
-- THIS FILE is the runtime authority: the refusal is a postgres trigger, so it
-- binds EVERY client holding the owner role — the fr pods, psql at a prompt,
-- an n8n Postgres node, another service that was handed the credential.
-- backend/scripts/check-destructive-guard-coverage.ts is the SECOND layer: it
-- parses the `protected_tables` array BELOW off disk and requires every
-- `pgTable(...)` in src/db/schema.ts to be either protected here or exempted
-- here, and it ratchets fr's own unqualified `.delete(table)` call sites.
--
-- ⭐ WHY BOTH LAYERS, AND WHY NEITHER ALONE IS ENOUGH.
-- The threat is *any* client holding the owner role. A static scan of fr's
-- source CANNOT SEE A STATEMENT TYPED AT A PROMPT, so a source-only guard
-- would have missed the 2026-09-17 `pipeline_events.events` incident (67,143
-- rows) entirely — nothing in that estate's source ever contained the
-- statement. Conversely a runtime-only guard cannot see a table added to
-- schema.ts next month with no trigger attached to it, and it cannot be
-- exercised at all in a DB-less CI job. The estate already has the worked
-- example: four stacked guards on the billing ledger each caught a DIFFERENT
-- real error. This is that shape, at two layers.
--
-- ── THE ESCAPE HATCH IS `SET LOCAL`, NEVER A SESSION-LEVEL `SET` ──────────
-- ⛔ Arm it ONLY inside a transaction:
--      BEGIN;
--      SET LOCAL fr.allow_destructive = 'on';
--      TRUNCATE <table>;
--      COMMIT;
-- A session-level `SET fr.allow_destructive = 'on'` is FORBIDDEN. fr reaches
-- postgres through PgBouncer in TRANSACTION pooling: a session GUC outlives
-- your transaction on that server backend and is handed to the NEXT client,
-- and the backend only recycles at `server_lifetime` (3600s). That exact
-- mistake — an auditor's "safe" read-only SET — cost this estate 15 procedure
-- writes and ~300 inserts on 2026-09-22. `SET LOCAL` is reverted by the
-- transaction boundary, so it cannot leak through the pooler.
--
-- ── TRIGGER SHAPES ────────────────────────────────────────────────────────
-- Per protected table, two statement-level triggers, both `ENABLE ALWAYS` so
-- they also fire on a replica / during a logical-replication apply (the
-- default `ENABLE` would be skipped there, which is precisely where an
-- unattended wipe is least likely to be noticed):
--   * `fr_guard_truncate_<t>`    BEFORE TRUNCATE ... FOR EACH STATEMENT
--        -> fr_refuse_truncate(). Unconditional: there is no such thing as a
--           routine TRUNCATE of these tables.
--   * `fr_guard_bulk_delete_<t>` AFTER DELETE ... REFERENCING OLD TABLE AS
--        fr_deleted_rows FOR EACH STATEMENT -> fr_refuse_bulk_delete(). The
--        transition table is how a STATEMENT trigger learns how many rows the
--        statement removed; a row-level trigger cannot know.
--
-- ── THE TWO DELETE THRESHOLDS, AND WHAT THEY DELIBERATELY DO NOT CATCH ────
-- fr_refuse_bulk_delete() refuses when EITHER
--   (a) the statement EMPTIED the table and removed at least EMPTIED_MIN (50)
--       rows — this is the shape of `DELETE FROM <t>;`, which always empties;
--   (b) the statement removed more than BULK_CAP (2000) rows — the
--       "removed nearly everything but left a row behind" variant, and a
--       backstop for a WHERE clause that turned out to match the world.
-- A single-row delete (<= 1 row) returns immediately without touching the
-- table, so the ordinary route path pays only the statement-trigger call.
--
-- ⚠️ KNOWINGLY NOT CAUGHT, stated so nobody reads this as total coverage:
--   * A DELETE that empties a table holding FEWER than 50 rows. EMPTIED_MIN
--     exists because fr's own scoped deletes legitimately remove every row of
--     a table in a small test fixture (`db.delete(documents).where(project_id
--     = …)` in src/routes/documents.ts:662 is the live example) and a guard
--     that reds the integration suite gets switched off. 50 was MEASURED, not
--     guessed: the largest per-table row count any integration fixture in
--     tests/integration/ builds is 30, and the smallest protected table the
--     issue reports in production holds thousands. The TRUNCATE form is still
--     refused on those tables regardless of size.
--   * A DELETE of between 2 and 2000 rows that leaves the table non-empty.
--     That is indistinguishable from legitimate scoped work at the row level.
--   * ⚠️ A CASCADE fan-out is NOT exempt and IS the main false-positive risk.
--     MEASURED on a throwaway postgres:18: deleting one parent row whose
--     `ON DELETE CASCADE` removed 50 child rows and emptied the child table
--     WAS REFUSED on the child. A cascade cannot be told apart from a
--     client-issued statement — `pg_trigger_depth()` reads 1 in BOTH cases
--     (measured; the AFTER-STATEMENT trigger is queued to statement end), so
--     there is no discriminator to key an exemption on. If a legitimate delete
--     path hits this, arm the hatch with `SET LOCAL` in that transaction; do
--     not lower the thresholds.
--   * A DROP TABLE, a DELETE by a superuser-owned `ALTER TABLE … DISABLE
--     TRIGGER`, or `ALTER TABLE … DISABLE TRIGGER ALL`. A trigger cannot
--     defend against the role that may drop it.
--
-- ── PER-TABLE DECISION (the auditable part) ───────────────────────────────
-- PROTECTED: every table in src/db/schema.ts except the seven below. The
-- default is PROTECT, because per the 2026-09-28 ruling system assets live in
-- postgres and are recovered by RESTORE, never by re-seeding — so for almost
-- every table here the cost of a false refusal is one `SET LOCAL`, and the
-- cost of a missing refusal is an unrecoverable row set.
--
-- EXEMPT — 7 tables, each with a codified regeneration or prune path that
-- deletes in bulk BY DESIGN, so a guard on it would be a guard on normal
-- operation:
--   * analytics_rollups      — derived; recomputed by src/workers/analytics-rollup.ts
--   * analytics_rollup_meta  — the watermark for the above; derived with it
--   * action_idempotency     — dedupe keys, swept by src/workers/idempotency-sweep.ts
--                              and bulk-deleted by src/services/improvement-cards/create-lease.ts:282
--   * scheduled_trigger_runs — run history, pruned in bulk by
--                              src/workers/scheduled-trigger-run-prune.ts:156
--   * agent_sessions         — ephemeral agent/chat session state
--   * agent_runtime_sessions — ephemeral; ALSO the one banked unqualified
--                              `.delete(table)` in src/ (session-store.ts:270,
--                              `_deleteAllForTests`), which fr#1283's own rule-8
--                              comment flags. Exempting the table is not a
--                              blessing of that call site: the coverage guard's
--                              floor keeps it at exactly one and refuses a second.
--   * card_drafts            — pre-commit drafts, replaced wholesale on re-draft
--   (telegram_pending_answers was exempted here from 2026-06 to 2026-10-31; the table AND
--    its state machine are dropped by migration 223 — owner ruling 2026-10-31, every channel
--    runs the same flow and no channel keeps reply state. The entry is removed rather than
--    left stale: an exemption naming a table that no longer exists is one nobody re-reads.)
--
-- ⚠️ NOT IN scope AT ALL, because the universe this file partitions is
-- src/db/schema.ts: `_migrations` / `_migration_effects` (the runner's own
-- ledger — it DELETEs from them on a reapply), `router_dedupe`,
-- `card_phase_lease` (a lease; ephemeral by construction). `wip_slot` and
-- `card_version_stamps` ARE protected below although they are migration-only
-- tables, because both are append-only records with no regeneration path.
--
-- ── RUNNER CONTRACT ───────────────────────────────────────────────────────
-- This file creates FUNCTIONs and TRIGGERs, which `drizzle-kit push` does not
-- emit — so on CI's push-built database the runner would stamp it applied
-- WITHOUT RUNNING IT and the guard would exist in production and nowhere else.
-- It therefore carries a COLUMN_PROBES entry in src/db/migration-runner.ts
-- (`reapplyIfProbeFails: true`, probing for the triggers themselves), which is
-- what scripts/check-migration-dml-probed.ts requires of any migration at or
-- above its floor that creates a TRIGGER or a FUNCTION.
--
-- Idempotent on re-run: CREATE OR REPLACE for both functions, CREATE OR REPLACE
-- TRIGGER (postgres 14+; this fleet is on 18) for every trigger, and the loop
-- skips any listed table that is not present on this database. No BEGIN/COMMIT —
-- the runner wraps each file in a SAVEPOINT.

-- ---------------------------------------------------------------------------
-- 1. The refusals.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fr_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql AS $fr_truncate$
BEGIN
  IF coalesce(current_setting('fr.allow_destructive', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'TRUNCATE on %.% is refused by fr''s destructive-statement guard (fr#1283)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING
      ERRCODE = 'raise_exception',
      HINT = 'If this is deliberate, arm the hatch INSIDE one transaction: '
             'BEGIN; SET LOCAL fr.allow_destructive = ''on''; <statement>; COMMIT;  '
             'NEVER a session-level SET — fr reaches postgres through PgBouncer in '
             'transaction pooling, where a session GUC leaks to the next client. '
             'Authority: backend/migrations/142_destructive_statement_guard.sql';
END
$fr_truncate$;

CREATE OR REPLACE FUNCTION fr_refuse_bulk_delete() RETURNS trigger
LANGUAGE plpgsql AS $fr_bulk_delete$
DECLARE
  -- A DELETE that empties a table holding at least this many rows is the shape
  -- of `DELETE FROM <t>;`. Below it, fr's own scoped deletes legitimately empty
  -- small test fixtures — see the header. 50 is above the largest per-table
  -- fixture count in tests/integration/ (30, measured).
  EMPTIED_MIN constant bigint := 50;
  -- Removed more than this and left the table non-empty: still a wipe.
  BULK_CAP    constant bigint := 2000;
  removed  bigint;
  emptied  boolean;
BEGIN
  IF coalesce(current_setting('fr.allow_destructive', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO removed FROM fr_deleted_rows;

  -- Fast path: a 0- or 1-row delete is the ordinary route shape and must not
  -- pay for a probe of the table.
  IF removed <= 1 THEN
    RETURN NULL;
  END IF;

  -- `NOT EXISTS ... LIMIT 1` rather than count(*): "is it empty now" is O(1)
  -- against the first live tuple, where count(*) is a full scan on every
  -- multi-row delete.
  EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)',
                 TG_TABLE_SCHEMA, TG_TABLE_NAME)
     INTO emptied;

  IF (emptied AND removed >= EMPTIED_MIN) OR removed > BULK_CAP THEN
    RAISE EXCEPTION
      'bulk DELETE on %.% is refused by fr''s destructive-statement guard '
      '(fr#1283): % row(s) removed, table now %',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, removed,
      CASE WHEN emptied THEN 'EMPTY' ELSE 'non-empty' END
      USING
        ERRCODE = 'raise_exception',
        HINT = 'If this is deliberate, arm the hatch INSIDE one transaction: '
               'BEGIN; SET LOCAL fr.allow_destructive = ''on''; <statement>; COMMIT;  '
               'NEVER a session-level SET — fr reaches postgres through PgBouncer in '
               'transaction pooling, where a session GUC leaks to the next client. '
               'Authority: backend/migrations/142_destructive_statement_guard.sql';
  END IF;

  RETURN NULL;
END
$fr_bulk_delete$;

COMMENT ON FUNCTION fr_refuse_truncate() IS
  'fr#1283 runtime guard: refuses TRUNCATE on a protected table unless the '
  'transaction has SET LOCAL fr.allow_destructive = ''on''. Attached by '
  'migrations/142_destructive_statement_guard.sql; coverage ratcheted by '
  'backend/scripts/check-destructive-guard-coverage.ts.';

COMMENT ON FUNCTION fr_refuse_bulk_delete() IS
  'fr#1283 runtime guard: refuses a DELETE that empties a protected table (>= 50 '
  'rows) or removes more than 2000 rows, unless the transaction has SET LOCAL '
  'fr.allow_destructive = ''on''. Reads the AFTER-DELETE transition table '
  'fr_deleted_rows. Attached by migrations/142_destructive_statement_guard.sql.';

-- ---------------------------------------------------------------------------
-- 2. Attach them. ONE emitter for every table, so no two protected tables can
--    drift apart in trigger shape or in enable state.
--
--    ⭐ `protected_tables` below is THE machine-readable protect list —
--    backend/scripts/check-destructive-guard-coverage.ts parses this array off
--    disk and cross-checks it against `pgTable(...)` in src/db/schema.ts. Do
--    not restate it anywhere else; a second copy is a copy that agrees with a
--    list nobody reads.
-- ---------------------------------------------------------------------------

DO $fr_attach$
DECLARE
  protected_tables text[] := ARRAY[
    'andon_state',
    'andon_state_history',
    'approval_callback_urls',
    'capability_audit',
    'agent_members',
    'agent_skill_pins',
    'approval_decisions',
    'approvals',
    'asset_assignments',
    'asset_bindings',
    'asset_stream_membership',
    'budget_alert_receipts',
    'budget_topups',
    'campaign_governance_controls',
    'campaign_jobs',
    'canary_rollback_events',
    'card_bridge_links',
    'card_contracts',
    'card_seeker_links',
    'card_version_stamps',
    'channels',
    'coding_analysis_runs',
    'comments',
    'contract_dependencies',
    'conveyor_flow_runs',
    'decompositions',
    'department_members',
    'departments',
    'documents',
    'engagement_deliveries',
    'execution_signoff_blocks',
    'family_bundles',
    'family_decisions',
    'finding_suppression_events',
    'finding_suppressions',
    'github_app_installations',
    'inapp_messages',
    'interface_validations',
    'kaizen_candidates',
    'kaizen_log',
    'katas',
    'member_knowledge_areas',
    'n8n_execution_mapping',
    'notification_log',
    'notification_prefs',
    'notifications',
    'priority_change_events',
    'project_deliverables',
    'project_metrics',
    'project_milestones',
    'project_outlines',
    'project_reports',
    'project_asset_copy_intents',
    'project_conveyor_failures',
    'project_conveyor_start_attempts',
    'project_repositories',
    'project_request_repositories',
    'project_requests',
    'project_stakeholders',
    'projects',
    'provisioning_audit',
    'repositories',
    'required_approvers',
    'scheduled_reports',
    'scheduled_triggers',
    'signup_approvals',
    'streams',
    'suggested_schedules',
    'super_admin_tenant_actions',
    'telegram_forum_topics',
    'tenant_improvement_projects',
    'user_channel_prefs',
    'user_roles',
    'user_secrets',
    'wip_slot',
    'workspaces'
  ];
  -- The stated exemptions. Load-bearing, not decoration: the disjointness
  -- assertion below reads it, and the NOTICE names every public relation this
  -- file classified as neither.
  exempt_tables text[] := ARRAY[
    'action_idempotency',
    'agent_runtime_sessions',
    'agent_sessions',
    'analytics_rollup_meta',
    'analytics_rollups',
    'card_drafts',
    'scheduled_trigger_runs'
  ];
  overlap_tables text[];
  t text;
  unclassified text;
BEGIN
  SELECT array_agg(x) INTO overlap_tables
    FROM unnest(protected_tables) AS x
   WHERE x = ANY (exempt_tables);
  IF overlap_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 142: table(s) % appear in BOTH protected_tables and exempt_tables; '
      'the partition must be disjoint or the coverage guard is meaningless', overlap_tables;
  END IF;

  FOREACH t IN ARRAY protected_tables LOOP
    -- A table this database has not got yet (an older fr, or a push-built CI
    -- schema missing a migration-only table) is skipped, not fatal. The
    -- COLUMN_PROBES entry re-runs this file, so it is attached on the next boot
    -- after the table appears.
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'migration 142: % is absent on this database; no guard attached', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE OR REPLACE TRIGGER fr_guard_truncate_%s BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate()', t, t);
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ALWAYS TRIGGER fr_guard_truncate_%s', t, t);

    EXECUTE format(
      'CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_%s AFTER DELETE ON public.%I '
      'REFERENCING OLD TABLE AS fr_deleted_rows '
      'FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete()', t, t);
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_%s', t, t);
  END LOOP;

  -- Cross-check from the DATABASE side, which is a different universe from
  -- schema.ts: any ordinary public table this file classified as neither.
  -- A NOTICE, not an exception — the runner's own ledger tables and any raw-SQL
  -- table legitimately live here, and a migration that refuses to apply because
  -- a new table exists would be a worse failure than an unguarded one.
  FOR unclassified IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT (c.relname = ANY (protected_tables))
       AND NOT (c.relname = ANY (exempt_tables))
     ORDER BY c.relname
  LOOP
    RAISE NOTICE 'migration 142: public.% is neither protected nor exempt', unclassified;
  END LOOP;
END
$fr_attach$;
