-- Migration: 189_bug_hunt_index_covers_bug_hunt_fix
-- Date: 2026-10-13
--
-- RM's PM defaults replaced the fr project type `it` with `bug_hunt_fix`, so a new
-- bug hunt is a `bug_hunt_fix` project (services/hunt-project-delivered.ts
-- isBugHuntProject; lib/bug-hunt-project-types.ts BUG_HUNT_FLAG_PROJECT_TYPES).
-- 163/164/173's "one live hunt per (tenant, repo)" index keyed on project_type = 'it',
-- so it did not cover the RM-native hunt at all. Recreate it covering BOTH the RM
-- type and the LEGACY `it` (pre-RM hunt rows must keep their slot).
--
-- Predicate choice: `project_type IN ('it', 'bug_hunt_fix')` + the bug_hunt flag,
-- NOT the flag alone. The create guard (routes/projects.ts
-- assertNoLiveBugHuntProject) matches the same type list, and the index must equal
-- the guard or the 409 mapping disagrees with the check. It also builds safely on
-- any existing database: the only rows it adds over 173's index are bug_hunt_fix
-- rows carrying the flag, which create refused (bug_hunt_exec_only) until this
-- change — a flag-alone index would also cover any other type's stray flag and
-- could fail the build on rows nobody has inspected.
--
-- Liveness list unchanged from 173 (lib/project-live-status.ts
-- NON_LIVE_PROJECT_STATUSES). Also declared in src/db/schema.ts (push lands it);
-- probed in migration-runner.ts by PREDICATE ('bug_hunt_fix' in the indexdef).
--
-- Not CONCURRENTLY: the runner wraps every file in a transaction + SAVEPOINT, where
-- CREATE INDEX CONCURRENTLY is not allowed (same as 112/114/145). Pure DDL, DROP IF
-- EXISTS then CREATE — safe to re-run. No BEGIN/COMMIT.

-- Bounded wait for the table lock (157/163 pattern); SET LOCAL never outlives the
-- runner's transaction; reset below.
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS projects_one_live_bug_hunt_per_repo_idx;
CREATE UNIQUE INDEX projects_one_live_bug_hunt_per_repo_idx
  ON projects ((project_data->>'keycloak_tenant_id'), repository_url)
  WHERE project_type IN ('it', 'bug_hunt_fix')
    AND status NOT IN ('archived', 'pending', 'cancelled', 'delivered')
    AND project_data->>'bug_hunt' = 'true';
SET LOCAL lock_timeout TO DEFAULT;
