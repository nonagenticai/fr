-- Migration: 190_project_repository_url_optional
-- Date: 2026-10-13
--
-- George 2026-10-13: "projects in the future will not always have a github repo,
-- so a repo url is NOT a mandatory field for projects!"
--
-- 1. `projects.repository_url` loses NOT NULL. A project with no repository stores
--    NULL (never '' — an empty string reads as "a repo whose url is blank"). Every
--    repo-dependent feature treats NULL as NOT APPLICABLE (routes/projects.ts,
--    project-request gates, card repository resolution); only a feature that is
--    meaningless without a repo (a bug hunt, a CVE sweep) refuses with a 422
--    `repository_required_for_<feature>`.
--
-- 2. The one (tenant, repository_url) unique index — 163/164/173/189's
--    `projects_one_live_bug_hunt_per_repo_idx` — gains `repository_url IS NOT NULL`.
--    Postgres already treats NULLs as distinct in a unique index, so this changes
--    no admission decision today; it states the rule ("no repo ⇒ the one-live-hunt
--    guard does not apply") in the index itself, matches the create guard
--    (assertNoLiveBugHuntProject skips a missing url), and stays correct if anyone
--    ever adds NULLS NOT DISTINCT. 189's predicate is otherwise unchanged.
--
-- No DML: existing rows all carry a value (the column was NOT NULL), and '' rows
-- written by older doors are left as they are — rewriting them is a data decision,
-- not a schema one.
--
-- Not CONCURRENTLY: the runner wraps every file in a transaction + SAVEPOINT
-- (same as 112/114/145/189). Idempotent: DROP NOT NULL on a nullable column is a
-- no-op, and the index is DROP IF EXISTS + CREATE. No BEGIN/COMMIT. Also declared
-- in src/db/schema.ts (push lands it); probed in migration-runner.ts (column
-- nullable AND the index predicate names `repository_url IS NOT NULL`).

-- Bounded wait for the table lock (157/163/189 pattern); SET LOCAL never outlives
-- the runner's transaction; reset below.
SET LOCAL lock_timeout = '10s';
ALTER TABLE projects ALTER COLUMN repository_url DROP NOT NULL;
DROP INDEX IF EXISTS projects_one_live_bug_hunt_per_repo_idx;
CREATE UNIQUE INDEX projects_one_live_bug_hunt_per_repo_idx
  ON projects ((project_data->>'keycloak_tenant_id'), repository_url)
  WHERE repository_url IS NOT NULL
    AND project_type IN ('it', 'bug_hunt_fix')
    AND status NOT IN ('archived', 'pending', 'cancelled', 'delivered')
    AND project_data->>'bug_hunt' = 'true';
SET LOCAL lock_timeout TO DEFAULT;
