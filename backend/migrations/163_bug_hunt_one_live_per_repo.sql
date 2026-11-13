-- Migration: 163_bug_hunt_one_live_per_repo
-- Date: 2026-10-06
--
-- G1 "find bugs" (design: ~/.claude/plans/program/20-designs/
-- G1-FR-FIND-BUGS-DESIGN-2026-10-06.md §1, build item B3).
--
-- At most ONE live (non-archived) `bug_hunt` project per (tenant, repository_url).
-- A second create is REFUSED (409 bug_hunt_project_exists), never superseded:
-- a hunt in flight is run evidence, so auto-archiving it would destroy a run
-- (deliberately unlike cve_sweep's supersede).
--
-- routes/projects.ts assertNoLiveBugHuntProject is a CHECK-THEN-INSERT, which two
-- simultaneous creates can both pass. This partial unique index makes the loser a
-- unique violation (23505 on this index name), which createProjectCore maps to the
-- same 409. Tenant is matched the way supersedePriorCveSweepProjects matches it:
-- project_data->>'keycloak_tenant_id'.
--
-- `bug_hunt` is a NEW project_data key (2026-10-06), so no existing row can carry
-- it and the index builds without any DML. Also declared in src/db/schema.ts so
-- `drizzle-kit push` (the CI bootstrap) lands the same index; probed in
-- migration-runner.ts.
--
-- Pure DDL, IF NOT EXISTS; no DML. Safe to re-run.
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

-- Bounded wait for the table lock (same pattern as 157): the build takes a SHARE
-- lock on projects; fail fast rather than queue every project write behind us.
-- SET LOCAL only — never outlives the runner's transaction; reset below.
SET LOCAL lock_timeout = '10s';
CREATE UNIQUE INDEX IF NOT EXISTS projects_one_live_bug_hunt_per_repo_idx
  ON projects ((project_data->>'keycloak_tenant_id'), repository_url)
  WHERE project_type = 'it'
    AND status <> 'archived'
    AND project_data->>'bug_hunt' = 'true';
SET LOCAL lock_timeout TO DEFAULT;
