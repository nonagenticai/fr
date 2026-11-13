-- Migration: 062_super_admin_workspaces_namespace_realign
-- Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md
--
-- Re-aligns fr's tenant UUIDs onto the canonical `0195f48b-d000-7000-8000-*`
-- namespace (the one AA_IMPLEMENTATION/SPEC.md Plan 4 seeded system assets
-- under and the one the super-admin's Keycloak tenant_id claim already uses).
-- Also inserts the new system workspace row, renames the super-admin's
-- execution workspace, and grants the super-admin a workspace-admin role in
-- their renamed execution workspace.
--
-- Mapping:
--   00000000-0000-4000-8000-000000000001  (__system_workflow__)
--     →  0195f48b-d000-7000-8000-000000000002  (workflow-improvement)
--   00000000-0000-4000-8000-000000000002  (__system_prompt__)
--     →  0195f48b-d000-7000-8000-000000000004  (prompt-improvement)
--   0195f48b-d000-7000-8000-000000000001  (system)
--     →  INSERT (was never a row in fr's workspaces; only existed upstream)
--   0195f48b-d000-7000-8000-000000000003  (george-dev → nonagentic-exec)
--     →  rename only; UUID stays
--
-- Pre-migration audit (from 2026-05-15 discovery, see plan §Discovery):
--   streams                  : 4+1 rows on legacy internals
--   tenant_improvement_projects : 3+1 rows
--   approvals                : 5 rows (combined)
--   required_approvers       : 2 rows
--   user_roles               : 2 rows (workspace-admins for 2 n8n service users)
--   FK-bound tables (departments, asset_assignments, channels) : 0 rows under
--     legacy internals → no FK violation risk during DELETE.
--
-- Idempotency: every statement is safe to re-run.
--   - INSERT … ON CONFLICT DO NOTHING for new workspace rows + user_roles row.
--   - UPDATE … WHERE tenant_id = old returns 0 rows on re-run.
--   - DELETE … WHERE id = old returns 0 rows on re-run.
--   - Workspace renames are absolute (SET name = '…' WHERE id = …).
--
-- Out of scope (separate session, see plan):
--   - Upstream req_mgmt / proc_mgmt re-key (n8n-dev string tenant, 019de842
--     procedure system tenant). The new asset-console UI will see those rows
--     under the old upstream UUIDs until that follow-up lands.

BEGIN;

-- 1. Drop the kind/tenant CHECK constraint on streams. Migration 060
--    pinned workflow→00…001 and prompt→00…002; we need to rebuild it
--    around the new UUIDs after the data has moved (step 7 below).
ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_kind_tenant_check;

-- 2. Insert the three new workspace rows (system, workflow-improvement,
--    prompt-improvement). ON CONFLICT preserves rows on re-run.
INSERT INTO workspaces (id, name, created_at)
VALUES
  ('0195f48b-d000-7000-8000-000000000001', 'system',               NOW()),
  ('0195f48b-d000-7000-8000-000000000002', 'workflow-improvement', NOW()),
  ('0195f48b-d000-7000-8000-000000000004', 'prompt-improvement',   NOW())
ON CONFLICT (id) DO NOTHING;

-- 3. Update child rows in semantic-tenant tables from legacy → new UUIDs.
--    Order doesn't matter for these (no FK to workspaces.id on these cols),
--    but grouped by table for review.

UPDATE streams
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE streams
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE tenant_improvement_projects
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE tenant_improvement_projects
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE approvals
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE approvals
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE required_approvers
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE required_approvers
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE user_roles
   SET tenant_id   = '0195f48b-d000-7000-8000-000000000002',
       tenant_name = 'workflow-improvement'
 WHERE tenant_id   = '00000000-0000-4000-8000-000000000001';
UPDATE user_roles
   SET tenant_id   = '0195f48b-d000-7000-8000-000000000004',
       tenant_name = 'prompt-improvement'
 WHERE tenant_id   = '00000000-0000-4000-8000-000000000002';

UPDATE provisioning_audit
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE provisioning_audit
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

-- 3. Text-typed tenant_id tables. Discovery showed 0 rows on legacy UUIDs
--    today, but include for safety — if a future row lands before the
--    migration runs, it gets re-keyed too. UUIDs are bare strings here.

UPDATE kaizen_candidates
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE kaizen_candidates
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE analytics_rollups
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE analytics_rollups
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE scheduled_triggers
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE scheduled_triggers
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE scheduled_reports
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE scheduled_reports
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE scheduled_trigger_runs
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE scheduled_trigger_runs
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

UPDATE suggested_schedules
   SET tenant_id = '0195f48b-d000-7000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
UPDATE suggested_schedules
   SET tenant_id = '0195f48b-d000-7000-8000-000000000004'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

-- 5. Delete the legacy workspace rows. FK-bound child tables
--    (departments / asset_assignments / channels) have 0 rows on these
--    parents per pre-migration audit, so no CASCADE blast.
DELETE FROM workspaces
 WHERE id IN (
   '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002'
 );

-- 6. Rename the super-admin's execution workspace.
UPDATE workspaces
   SET name = 'nonagentic-exec'
 WHERE id = '0195f48b-d000-7000-8000-000000000003';

-- 7. Rebuild the streams kind→tenant CHECK constraint around the new UUIDs.
--    Mirrors migration 060 exactly except for the two literal UUIDs.
ALTER TABLE streams
  ADD CONSTRAINT streams_kind_tenant_check
  CHECK (
    (kind::text = 'workflow'
       AND tenant_id = '0195f48b-d000-7000-8000-000000000002'::uuid)
    OR
    (kind::text = 'prompt'
       AND tenant_id = '0195f48b-d000-7000-8000-000000000004'::uuid)
    OR (kind::text = 'principle')
    OR (kind::text = 'requirement')
    OR (kind::text = 'decision')
  );

-- 8. Grant the super-admin a workspace-admin role in their renamed exec
--    workspace. This makes the role explicit in the DB (today they ride only
--    on the SUPER_ADMIN_USER_IDS env allowlist).
INSERT INTO user_roles (
  id, user_id, tenant_id, tenant_name, role, granted_at, granted_by
)
VALUES (
  gen_random_uuid(),
  'e148e8af-3751-49bf-a0fa-56ab46d31ddc',
  '0195f48b-d000-7000-8000-000000000003',
  'nonagentic-exec',
  'workspace-admin',
  NOW(),
  'migration-062'
)
ON CONFLICT (user_id, tenant_id, role) DO NOTHING;

COMMIT;
