-- backend/migrations/029_backfill_workspaces_default_dept.sql
-- Foundation Plan 2 — Task 6
--
-- Idempotent backfill: every existing tenant_id seen in user_roles becomes
-- a workspaces row, gets a default department, and every (user_id, tenant_id)
-- pair becomes a dept-member of that default department. Re-running this
-- migration is a no-op via ON CONFLICT DO NOTHING.
--
-- Verified against fr's live schema 2026-04-28:
--   * `channels` table does NOT exist in fr — channel scoping rows will be
--     written by the channel registry CRUD path when Task 11 lands.
--   * `projects.tenant_id` does NOT exist — projects today are scoped via
--     `owner_id` only. Backfilling `projects.dept_id` and tightening it to
--     NOT NULL therefore cannot run here; that hardening will land when
--     projects get a workspace association in a follow-up slice.
BEGIN;

-- IMPORTANT: `user_roles.tenant_id` is declared **uuid** in prod
-- (migrations 023 and 024 left it uuid; only `tenant_name` was added as
-- TEXT). Verified live 2026-04-29 against fr's prod DB:
--
--    tenant_id   | uuid    | not null
--    tenant_name | text    |
--
-- A previous attempt (61c4dd8) believed tenant_id was text and "fixed"
-- the COALESCE in the wrong direction, producing COALESCE(text, uuid)
-- which Postgres can't resolve. Smoke tests on a fresh DB missed it
-- because user_roles was empty (zero rows → SELECT DISTINCT yields
-- nothing → COALESCE never evaluates). Prod has rows; fr was hard down
-- on CrashLoopBackOff applying this migration.
--
-- The COALESCE here MUST cast tenant_id to text (not the other way
-- round) because the target `workspaces.name` column is text. The
-- INSERT into the uuid `id` column needs no cast — tenant_id is
-- already uuid.

-- 1. Workspaces: one per distinct tenant_id seen in user_roles.
INSERT INTO workspaces (id, name)
SELECT DISTINCT ur.tenant_id, COALESCE(ur.tenant_name, ur.tenant_id::text)
FROM user_roles ur
ON CONFLICT (id) DO NOTHING;

-- 2. Default department per workspace.
INSERT INTO departments (workspace_id, name, description, is_default)
SELECT id, 'default', 'Default department (auto-created)', true
FROM workspaces
ON CONFLICT (workspace_id, name) DO NOTHING;

-- 3. Every distinct (user_id, tenant_id) pair becomes a dept-member of the
--    workspace's default department, role 'dept-member'. Workspace-admins
--    keep their existing user_roles row; that's how admin gating already
--    works.
INSERT INTO department_members (dept_id, user_id, role)
SELECT d.id, ur.user_id, 'dept-member'
FROM user_roles ur
JOIN departments d ON d.workspace_id = ur.tenant_id AND d.is_default = true
ON CONFLICT (dept_id, user_id) DO NOTHING;

-- 4. Channel `owns` seed — RESOLVED 2026-05-03 in migration 049
--    (channels table didn't exist here; landed in 030, backfilled in 049).

-- 5. Projects → default-dept backfill — RESOLVED in migration 032.
-- 6. Tighten projects.dept_id NOT NULL — partially done in 032 (only when
--    no NULLs remain); 033 then relaxed the FK to ON DELETE SET NULL so
--    test-fixture department deletions don't cascade-delete real projects.

COMMIT;
