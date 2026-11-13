-- Migration: 164_bug_hunt_index_excludes_pre_approval
-- Date: 2026-10-08
--
-- George 2026-10-08: every conveyor LLM call carries a projectId, so fr now
-- allocates a `projects` row at project-request SUBMIT with status `pending`
-- (promoted to `active` on approve; `cancelled` on reject/withdraw). Those rows
-- are not live work. Recreate 163's partial unique index so its "live" predicate
-- matches src/lib/project-live-status.ts NON_LIVE_PROJECT_STATUSES
-- ('archived','pending','cancelled') and src/db/schema.ts.
--
-- SAME index name, on purpose: 163's runner probe (reapplyIfProbeFails) checks
-- the name, so a rename would make 163 re-create the old predicate on every boot.
-- The pre-approval row never carries project_type/bug_hunt today, so the
-- predicate change is defensive — the index set it covers cannot grow.
--
-- Pure DDL; no DML. No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS projects_one_live_bug_hunt_per_repo_idx;
CREATE UNIQUE INDEX projects_one_live_bug_hunt_per_repo_idx
  ON projects ((project_data->>'keycloak_tenant_id'), repository_url)
  WHERE project_type = 'it'
    AND status NOT IN ('archived', 'pending', 'cancelled')
    AND project_data->>'bug_hunt' = 'true';
SET LOCAL lock_timeout TO DEFAULT;
