-- backend/migrations/032_backfill_projects_dept_id.sql
-- Foundation Plan 2 deferred — Item 2.
--
-- Migration 029 commented out the `projects.dept_id` backfill because
-- `projects.tenant_id` doesn't exist (only `owner_id`), so projects had
-- no deterministic mapping to a workspace. fr is currently
-- single-workspace, so we can safely backfill every project to the only
-- workspace's default department. Multi-workspace deployments need a
-- different signal (e.g. project owner's tenant) — for those the guard
-- below makes this migration a no-op and skips the NOT NULL tightening,
-- so the migration is safe to ship before that ambiguity is resolved.
--
-- Deviation from spec: dropped the file-level BEGIN/COMMIT wrapper for
-- the same reason as 031 — see that file's header. The runner already
-- transactional-wraps the file via SAVEPOINT.

-- Single-workspace deployment: every project lands in the (only) workspace's default dept.
-- Multi-workspace: would require a different signal (e.g. project owner's tenant). Re-revisit.
UPDATE projects p
SET dept_id = d.id
FROM departments d, workspaces w
WHERE p.dept_id IS NULL
  AND d.workspace_id = w.id
  AND d.is_default = true
  AND (SELECT count(*) FROM workspaces) = 1;  -- guard: bail on multi-workspace

-- Tighten only when no nulls remain (otherwise the migration safely no-ops on
-- multi-workspace clusters where dept_id can't be inferred deterministically).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM projects WHERE dept_id IS NULL;
  IF n = 0 THEN
    ALTER TABLE projects ALTER COLUMN dept_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping NOT NULL: % projects still have NULL dept_id (multi-workspace deployment?)', n;
  END IF;
END $$;
