-- backend/migrations/033_relax_projects_dept_id_fk.sql
-- Foundation Plan 2 deferred — Item 2 follow-up.
--
-- Migration 032 backfilled `projects.dept_id` from the workspace's default
-- department and tightened it to NOT NULL with the existing FK
-- `projects_dept_id_fkey REFERENCES departments(id)` (no ON DELETE clause
-- = NO ACTION). That combination is wrong twice over:
--
-- 1. **Production semantics:** a dept-admin should be able to archive /
--    delete a department; projects associated with it should orphan to
--    NULL, not block the delete. Treating dept_id as a soft membership
--    rather than a hard parent matches how Spec 1 §6.1 frames the
--    Workspace → Department → Project hierarchy (membership, not parentage).
--
-- 2. **Test cleanup:** every test that does
--      `DELETE FROM workspaces WHERE id = ${test_id}`
--    relies on the workspaces → departments cascade. With the NO ACTION
--    FK from projects, ANY project pointing at a test-created department
--    blocks the cascade with a FK-violation error. Reproduced locally
--    2026-04-29 across 11 admin/dept-* test files (~41 fails).
--
-- Fix: relax `projects.dept_id` to nullable + change the FK to
-- ON DELETE SET NULL. The 032 backfill semantics (every project in the
-- only workspace's default dept) are preserved for current rows; new
-- projects without a dept can land as NULL until reassignment.

-- Drop NOT NULL — projects.dept_id becomes "membership when known"
-- rather than "membership required".
ALTER TABLE projects ALTER COLUMN dept_id DROP NOT NULL;

-- Replace the FK with one that orphans on dept delete instead of blocking.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_dept_id_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_dept_id_fkey
  FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE SET NULL;
