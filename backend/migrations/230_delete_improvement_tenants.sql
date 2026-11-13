-- Migration: 230_delete_improvement_tenants
-- Date: 2026-11-03
--
-- kata-super-admin §7 (George 2026-11-03, Q2: "everything on this list goes, including the
-- data"): the v3 improvement loop is deleted and the kata replaces it. This removes its DATA:
--
--   1. DROP the three v3 tables nothing reads any more:
--        kaizen_candidates (033), kaizen_log (043/144), canary_rollback_events (031/096).
--      ⚠️ tenant_improvement_projects (041) is NOT dropped (the design lists it): the asset-
--      stream provisioner behind POST /api/cards/improvement — kept because agent.create_asset /
--      agent.update_asset still mint through it — records its umbrella projects there. Only the
--      three tenants' rows are deleted (step 2).
--      Plain DROP, no CASCADE: nothing references them (the only FK touching them is
--      kaizen_log -> streams, ON DELETE RESTRICT, which is why kaizen_log goes BEFORE the
--      stream rows below). If anything ever comes to depend on one of them, this fails
--      loudly instead of silently dropping the dependant.
--   2. DELETE every row of the three improvement tenants
--        workflow-improvement  0195f48b-d000-7000-8000-000000000002
--        prompt-improvement    0195f48b-d000-7000-8000-000000000004
--        procedure-improvement 0195f48b-d000-7000-8000-000000000005
--      from every fr table keyed by tenant_id / workspace_id (enumerated from the live
--      schema, 2026-11-03), then their `workspaces` rows LAST (asset_assignments, channels
--      and departments also cascade from workspaces; deleting them explicitly first keeps
--      the order independent of those FKs).
--   3. Rewrite `streams_kind_tenant_check` (066's form pinned kind workflow / prompt /
--      procedure to the three deleted tenants). The streams table is KEPT (contract
--      amendment 1); the only kinds any tenant can still hold are the asset kinds.
--
-- MEASURED ON PRODUCTION 2026-11-03 (contract "Measured facts"), before writing this:
--   workspaces 3, user_roles 2, budget_alert_receipts 1, notifications 1,
--   asset_assignments.workspace_id 1515 (…0005: 1119, …0002: 396); every other tenant_id
--   table 0. kaizen_candidates, kaizen_log, streams, asset_stream_membership,
--   tenant_improvement_projects, canary_rollback_events: 0 rows.
--
-- ⛔ DELIBERATELY NOT DELETED: the four APPEND-ONLY ledgers (super_admin_tenant_actions,
-- card_plan_pins, card_plan_events, card_executed_activities). Their triggers refuse
-- UPDATE/DELETE because they record who did what at the time; a deleted tenant's history
-- stays history. (Production holds 0 rows of these tenants in each.)
--
-- Migration 142's bulk-delete guard: asset_assignments loses ~1515 rows, which can EMPTY it
-- (>= 50) on a database where these tenants held all of them. The hatch is armed with SET
-- LOCAL (transaction-scoped, never a session SET — PgBouncer transaction pooling) and
-- DISARMED again at the end of this file, because the runner applies later files in the
-- same outer transaction.
--
-- Idempotent: DROP ... IF EXISTS, DELETE of rows that are gone deletes nothing, the CHECK is
-- dropped IF EXISTS and re-added. Probed (COLUMN_PROBES '230_delete_improvement_tenants.sql',
-- reapplyIfProbeFails) on its SCHEMA half only: none of the three tables exists and the CHECK
-- no longer names 'workflow'.
--
-- The DATA half (step 2) is NOT PROBED, DELIBERATELY. It is one-shot by the ledger: a database
-- with a `_migrations` ledger (production) runs this file once, as any pending migration, and
-- never again. A row-absence witness ("no workspaces row for the three ids") is FALSE in steady
-- state: the `platform-core` licence row in the licences service carries tenant …0002, and fr
-- lazily recreates that tenant's `workspaces` row on first sight
-- (routes/assets/_lib/effective-query.ts ensureWorkspace), so with reapplyIfProbeFails the
-- 43-table DELETE re-ran on EVERY later boot and wiped the rows fr had just re-derived. On a
-- push-built, empty-ledger database (CI) the file is stamped; ci-seed creates no rows for
-- these tenants, so nothing is lost. Proven by
-- tests/integration/migrations/230-delete-improvement-tenants.integration.test.ts.
--
-- RUNNER CONTRACT: no BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside its
-- outer transaction.

SET LOCAL lock_timeout = '10s';
SET LOCAL fr.allow_destructive = 'on';

DROP TABLE IF EXISTS kaizen_candidates;
DROP TABLE IF EXISTS kaizen_log;
DROP TABLE IF EXISTS canary_rollback_events;

DO $fr_230$
DECLARE
  ids constant text[] := ARRAY[
    '0195f48b-d000-7000-8000-000000000002',
    '0195f48b-d000-7000-8000-000000000004',
    '0195f48b-d000-7000-8000-000000000005'
  ];
  -- (table, column). Every public table with a tenant_id / workspace_id column on
  -- 2026-11-03, minus the four append-only ledgers above and the three dropped tables.
  targets constant text[][] := ARRAY[
    ['agent_members', 'tenant_id'],
    ['agent_sessions', 'tenant_id'],
    ['agent_skill_pins', 'tenant_id'],
    ['analytics_rollups', 'tenant_id'],
    ['approval_callback_urls', 'tenant_id'],
    ['approvals', 'tenant_id'],
    ['asset_assignments', 'workspace_id'],
    ['budget_alert_receipts', 'tenant_id'],
    ['budget_topups', 'tenant_id'],
    ['capability_audit', 'tenant_id'],
    ['card_asset_binding', 'tenant_id'],
    ['card_contracts', 'tenant_id'],
    ['card_phase_lease', 'tenant_id'],
    ['card_phase_lease_waiter', 'tenant_id'],
    ['channels', 'workspace_id'],
    ['conveyor_flow_runs', 'tenant_id'],
    ['decompositions', 'tenant_id'],
    ['documents', 'tenant_id'],
    ['execution_signoff_blocks', 'tenant_id'],
    ['finding_suppression_events', 'tenant_id'],
    ['github_app_installations', 'tenant_id'],
    ['member_knowledge_areas', 'tenant_id'],
    ['n8n_execution_mapping', 'tenant_id'],
    ['notifications', 'tenant_id'],
    ['priority_change_events', 'tenant_id'],
    ['project_asset_copy_intents', 'workspace_id'],
    ['project_conveyor_failures', 'tenant_id'],
    ['project_conveyor_start_attempts', 'tenant_id'],
    ['project_reports', 'tenant_id'],
    ['project_requests', 'tenant_id'],
    ['provisioning_audit', 'tenant_id'],
    ['required_approvers', 'tenant_id'],
    ['scheduled_reports', 'tenant_id'],
    ['scheduled_trigger_runs', 'tenant_id'],
    ['scheduled_triggers', 'tenant_id'],
    ['signup_approvals', 'tenant_id'],
    ['streams', 'tenant_id'],
    ['suggested_schedules', 'tenant_id'],
    ['tenant_improvement_projects', 'tenant_id'],
    ['user_channel_prefs', 'tenant_id'],
    ['user_roles', 'tenant_id'],
    ['wip_slot', 'tenant_id'],
    ['departments', 'workspace_id']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(targets, 1) LOOP
    -- A table this database has not got (a push-built CI schema missing a raw-SQL-only
    -- table) holds no rows to delete.
    IF to_regclass(format('public.%I', targets[i][1])) IS NULL THEN
      CONTINUE;
    END IF;
    -- `::text` so the text-typed tenant columns (n8n_execution_mapping,
    -- user_channel_prefs) and the uuid ones share one predicate.
    EXECUTE format('DELETE FROM public.%I WHERE %I::text = ANY ($1)', targets[i][1], targets[i][2])
      USING ids;
  END LOOP;

  DELETE FROM workspaces WHERE id::text = ANY (ids);
END
$fr_230$;

ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_kind_tenant_check;

ALTER TABLE streams
  ADD CONSTRAINT streams_kind_tenant_check
  CHECK (
    (kind::text = 'principle')
    OR (kind::text = 'requirement')
    OR (kind::text = 'decision')
  );

SET LOCAL fr.allow_destructive = 'off';
