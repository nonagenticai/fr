-- Migration: 103_tenant_id_text_to_uuid — the last 10 `tenant_id` columns become uuid
-- Date: 2026-08-28
--
-- WHY
-- ───
-- `kag_frontend` carried `tenant_id` in TWO different types. Twelve tables
-- (agent_sessions, approvals, budget_topups, documents,
-- execution_signoff_blocks, project_reports, project_requests,
-- provisioning_audit, required_approvers, streams,
-- tenant_improvement_projects, user_roles) already declare it `uuid`. Ten
-- still declared it `text`. A tenant id is a Keycloak realm id — it is a uuid
-- everywhere it is minted, and nowhere in this codebase is a non-uuid tenant a
-- legitimate value.
--
-- The cost of the `text` half is measured, not theoretical, and it is exactly
-- why `backend/scripts/check-tenant-field-misuse.ts` exists: `src/agui/actions/
-- kaizen.ts` wrote `ctx.tenantRoles?.[0] ?? 'default'` into
-- `kaizen_candidates.tenant_id`, so the string `platform_incident_commander`
-- was persisted as a tenant. Postgres had nothing to object to — the column
-- was `text`. Under `uuid` that INSERT throws on the first row. The source-line
-- guard stays (it also catches user-id-into-tenant-field, which IS uuid-shaped
-- and which no column type can detect), but the database now backstops the
-- whole class of "this string is not a tenant" at write time instead of
-- discovering it months later.
--
-- Three of the ten migrations that created these columns argue for `text` in a
-- header comment (075_campaign_jobs, 093_budget_alert_receipts,
-- 100_card_phase_lease — all phrased as "so a legacy non-uuid billing tenant
-- can be stored"). That hedge is retired here.
--
-- ⛔ CORRECTED 2026-08-28 (comment only — see the note at the end of this
-- block). This paragraph used to read: "measured live on `kag_frontend`
-- 2026-08-27, ALL TEN of these tables hold ZERO rows, so there is no legacy
-- non-uuid tenant to preserve. Nothing is being migrated away — the hedge never
-- had a row to protect."
--
-- Both halves were false, and the reason is that the measurement was taken
-- against the WRONG DATABASE. `kag_frontend` and `fr` both exist on
-- postgres.example.com; the deployed backend's DATABASE_URL points at **`fr`**.
-- Measured on `fr` on 2026-08-28, before remediation:
--
--     scheduled_trigger_runs   45781 rows   0 non-uuid
--     card_phase_lease             7 rows   0 non-uuid
--     kaizen_candidates            3 rows   1 non-uuid  ('default')
--     suggested_schedules          1 row    0 non-uuid
--     (the other six tables really were empty)
--
-- 45,792 rows, not zero. The consequence was not hypothetical: that ONE row
-- aborted this migration on every boot, the backend exited 1, and `fr` sat in
-- CrashLoopBackOff from 13:56Z, serving on a single surviving old replica until
-- the row was remediated (it now carries the tenant that owns it,
-- e148e8af-…, not a sentinel). A preflight run against a database the service
-- does not use certifies nothing.
--
-- ⚠️ NOTHING EXECUTABLE IN THIS FILE WAS TOUCHED BY THAT CORRECTION, AND NOTHING
-- MAY BE. This migration is recorded applied in `_migrations` on `fr`, and the
-- runner keys on filename, so it will never re-run there. Any behavioural edit
-- would leave the file permanently disagreeing with what actually ran, in the
-- one direction no environment can reconcile. Fixes go in a new numbered
-- migration; this comment is only allowed to change because a comment cannot.
--
-- The guard itself was right, and is why this was a clean abort and not data
-- loss: the header's own WHY names `ctx.tenantRoles?.[0] ?? 'default'` in
-- `src/agui/actions/kaizen.ts` as the source of exactly this value.
--
-- WHY NO BACKFILL AND NO DOWN MIGRATION
-- ─────────────────────────────────────
-- Zero rows in all ten tables, so `tenant_id::uuid` has nothing to convert.
-- This repo has no down/rollback convention — `backend/migrations/` is
-- forward-only, numbered, one-way, and no migration in the tree ships a
-- reverse. Rollback is a new forward-numbered migration.
--
-- Verified live before writing this file: `kag_frontend` has ZERO RLS policies
-- and ZERO PL/pgSQL functions that reference `tenant_id`, and no view depends
-- on any of these columns (`grep -rl 'CREATE.*VIEW' backend/migrations/`
-- returns nothing). So there is nothing to drop and recreate around the ALTER.
-- Indexes and the `card_phase_lease` PRIMARY KEY (tenant_id, card_id) are
-- rebuilt automatically by `ALTER COLUMN ... TYPE`.
--
-- THE FAIL-LOUD GUARD
-- ───────────────────
-- The tables are empty TODAY. This migration ships and deploys later, and a
-- row written in between must not be silently destroyed. So each table is
-- checked BEFORE its ALTER: any non-NULL `tenant_id` that is not uuid-shaped
-- raises an exception naming the table and the offending count, which aborts
-- the file, rolls back the runner's savepoint AND its outer transaction, and
-- leaves the schema untouched for an operator. A bare `USING tenant_id::uuid`
-- would also fail — but with `invalid input syntax for type uuid` and no
-- indication of which of the ten tables produced it.
--
-- IDEMPOTENT / DRIFT-TOLERANT BY DESIGN
-- ─────────────────────────────────────
-- Each table is skipped unless `information_schema` currently reports its
-- `tenant_id` as `text`. This is load-bearing, not decoration: CI bootstraps a
-- fresh database with `drizzle-kit push` FROM `src/db/schema.ts` and only then
-- runs the migration runner (see backend/scripts/ci-test.sh "Bootstrap
-- schema + seed + migrations"). Because `schema.ts` is updated to `uuid()` in
-- this same commit, on a fresh CI database these columns are ALREADY uuid when
-- 103 is reached — the per-table skip makes that a clean no-op instead of an
-- error. On prod (columns still `text`) every branch fires.
--
-- `card_phase_lease` is intentionally absent from `schema.ts` — it is raw-SQL
-- only, like `router_dedupe` (see the 100/082 probe comments in
-- src/db/migration-runner.ts). It is included here because it exists in the
-- database; the drizzle side has nothing to keep in sync.
--
-- A matching probe is registered in src/db/migration-runner.ts COLUMN_PROBES
-- so a `_migrations` backfill against a database whose columns are still
-- `text` leaves this file PENDING and self-heals, instead of stamping it
-- applied over an unconverted schema.

BEGIN;

DO $$
DECLARE
  -- The ten tables whose `tenant_id` is still `text`. The twelve listed in the
  -- header are already `uuid` and are deliberately NOT named here; the
  -- data_type guard below would skip them anyway.
  target_tables CONSTANT text[] := ARRAY[
    'analytics_rollups',
    'budget_alert_receipts',
    'campaign_jobs',
    'card_phase_lease',
    'kaizen_candidates',
    'notifications',
    'scheduled_reports',
    'scheduled_trigger_runs',
    'scheduled_triggers',
    'suggested_schedules'
  ];
  tbl              text;
  current_type     text;
  bad_rows         bigint;
  bad_sample       text;
  converted        int := 0;
  skipped_already  int := 0;
BEGIN
  FOREACH tbl IN ARRAY target_tables LOOP
    SELECT c.data_type
      INTO current_type
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name   = tbl
       AND c.column_name  = 'tenant_id';

    IF current_type IS NULL THEN
      -- The table (or the column) does not exist in this database at all.
      -- Not an error: every one of these tables is created by an earlier
      -- numbered migration, so the only way to land here is a deliberately
      -- partial schema. Nothing to convert; say so and move on.
      RAISE NOTICE 'Migration 103: %.tenant_id not present — nothing to convert.', tbl;
      CONTINUE;
    END IF;

    IF current_type = 'uuid' THEN
      skipped_already := skipped_already + 1;
      CONTINUE;
    END IF;

    IF current_type <> 'text' THEN
      RAISE EXCEPTION
        'Migration 103: %.tenant_id has unexpected type "%" (expected text or uuid). Refusing to convert — an operator must reconcile this column manually.',
        tbl, current_type;
    END IF;

    -- FAIL-LOUD GUARD. The tables were empty when this migration was written;
    -- anything written between then and deploy must abort the migration, never
    -- be dropped. Canonical 8-4-4-4-12 hex form — the same regex migration 080
    -- uses to guard its `keycloak_tenant_id` cast.
    EXECUTE format(
      'SELECT count(*), min(tenant_id) FROM public.%I
        WHERE tenant_id IS NOT NULL
          AND tenant_id !~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''',
      tbl
    ) INTO bad_rows, bad_sample;

    IF bad_rows > 0 THEN
      RAISE EXCEPTION
        'Migration 103 ABORTED: %.tenant_id holds % row(s) whose value is not a uuid (e.g. %). Converting would destroy them. Remediate those rows, then re-run. Nothing has been altered.',
        tbl, bad_rows, quote_literal(bad_sample);
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid',
      tbl
    );
    converted := converted + 1;
    RAISE NOTICE 'Migration 103: converted %.tenant_id text -> uuid.', tbl;
  END LOOP;

  RAISE NOTICE 'Migration 103: % column(s) converted, % already uuid.',
    converted, skipped_already;
END$$;

COMMENT ON COLUMN analytics_rollups.tenant_id IS
  'Keycloak tenant (workspace) id. uuid since migration 103 — was text, which let a non-tenant string be stored silently.';
COMMENT ON COLUMN budget_alert_receipts.tenant_id IS
  'Keycloak tenant (workspace) id. uuid since migration 103; the 093 header''s "legacy non-uuid billing tenant" hedge is retired (table was empty).';
-- campaign_jobs was DROPPED by migration 197 and is no longer in schema.ts, so a fresh database
-- (drizzle-kit push, then this file left pending by the backfill) has no such table. Comment it
-- only where it exists; prod applied this file long before 197.
DO $campaign_comment$
BEGIN
  IF to_regclass('public.campaign_jobs') IS NOT NULL THEN
    COMMENT ON COLUMN campaign_jobs.tenant_id IS
      'Keycloak tenant (workspace) id. uuid since migration 103; the 075 header''s deliberate-text note is superseded (table was empty).';
  END IF;
END$campaign_comment$;
COMMENT ON COLUMN card_phase_lease.tenant_id IS
  'Keycloak tenant (workspace) id, first half of the (tenant_id, card_id) lease key. uuid since migration 103. Raw-SQL table — not in src/db/schema.ts.';
-- kaizen_candidates was dropped by migration 230 (2026-11-03) and left schema.ts, so a fresh
-- push-built database has no such table either. Same guard as campaign_jobs above.
DO $kaizen_comment$
BEGIN
  IF to_regclass('public.kaizen_candidates') IS NOT NULL THEN
    COMMENT ON COLUMN kaizen_candidates.tenant_id IS
      'Keycloak tenant (workspace) id. uuid since migration 103 — this is the exact column that stored the role name "platform_incident_commander" as a tenant while it was text.';
  END IF;
END$kaizen_comment$;
COMMENT ON COLUMN notifications.tenant_id IS
  'Keycloak tenant (workspace) id. uuid since migration 103.';
-- scheduled_reports was dropped by migration 233 (2026-11-04) and left schema.ts. Same guard.
DO $scheduled_reports_comment$
BEGIN
  IF to_regclass('public.scheduled_reports') IS NOT NULL THEN
    COMMENT ON COLUMN scheduled_reports.tenant_id IS
      'Keycloak tenant (workspace) id. uuid since migration 103.';
  END IF;
END$scheduled_reports_comment$;
COMMENT ON COLUMN scheduled_trigger_runs.tenant_id IS
  'Keycloak tenant (workspace) id. uuid since migration 103.';
COMMENT ON COLUMN scheduled_triggers.tenant_id IS
  'Keycloak tenant (workspace) id. uuid since migration 103.';
COMMENT ON COLUMN suggested_schedules.tenant_id IS
  'Keycloak tenant (workspace) id. uuid since migration 103.';

COMMIT;
