-- Migration: 173_project_delivered
-- Date: 2026-10-09
-- Refs: program/20-designs/HUNT-PROJECT-DELIVERED-TERMINAL-2026-10-09.md (agreed by L1).
--
-- A bug_hunt project ends DELIVERED once its hunt PR exists. `delivered` is a new
-- `projects.status` value, written ONLY by services/hunt-project-delivered.ts, in
-- the same transaction that records a PASSING `bhs_hunt_terminal` computed check
-- with outcome pr_opened_fanin / pr_opened. There is no HTTP lane that sets it.
--
-- 1. `projects.status` has NO CHECK constraint (plain text, documented vocabulary —
--    see db/schema.ts), so admitting 'delivered' needs no constraint change.
--    `projects_project_type_check` (166) is untouched: a delivered project is
--    `it`, which is inside the closed vocabulary already.
--
-- 2. `delivered_at` + `delivery_evidence` (`{computed_check_id, evidence_sha,
--    outcome, hunt_card_id, pr:{number, head_sha, url}}`). Written together or
--    not at all (named pair CHECK). They are NOT cleared by a later archive: an
--    archived project that was delivered keeps the record of its delivery.
--
-- 3. `delivered` is NOT live work (lib/project-live-status.ts
--    NON_LIVE_PROJECT_STATUSES). The one-live-bug_hunt-per-repo partial unique
--    index (163, widened by 164) ENUMERATES THE NON-LIVE statuses in its
--    predicate (`status NOT IN (...)`), so a delivered hunt would still occupy
--    its (tenant, repo) slot and block the next hunt. Recreate it with
--    'delivered' added. SAME index name, on purpose (164's reason): 163's probe
--    checks the name and 164's probe checks for 'pending' + 'cancelled', both of
--    which this definition still satisfies, so neither re-applies over it.
--    Excluding one more status can only SHRINK the indexed row set, so the
--    rebuild cannot fail on existing data.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts. Idempotent
-- (ADD COLUMN IF NOT EXISTS, pg_constraint-guarded ADD CONSTRAINT, DROP INDEX IF
-- EXISTS + CREATE) — safe under `reapplyIfProbeFails`. No BEGIN/COMMIT — the
-- runner wraps each file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS delivery_evidence jsonb NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_delivery_pair_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_delivery_pair_check
      CHECK ((delivered_at IS NULL) = (delivery_evidence IS NULL));
  END IF;
END$$;

DROP INDEX IF EXISTS projects_one_live_bug_hunt_per_repo_idx;
CREATE UNIQUE INDEX projects_one_live_bug_hunt_per_repo_idx
  ON projects ((project_data->>'keycloak_tenant_id'), repository_url)
  WHERE project_type = 'it'
    AND status NOT IN ('archived', 'pending', 'cancelled', 'delivered')
    AND project_data->>'bug_hunt' = 'true';

SET LOCAL lock_timeout TO DEFAULT;

COMMENT ON COLUMN projects.delivered_at IS
  'When a bug_hunt project became status=delivered (its hunt PR exists, proven by a '
  'passing bhs_hunt_terminal computed check). Written only by '
  'services/hunt-project-delivered.ts. Authority: backend/migrations/173_project_delivered.sql.';
COMMENT ON COLUMN projects.delivery_evidence IS
  '{computed_check_id, evidence_sha, outcome, hunt_card_id, pr:{number, head_sha, url}}. '
  'Paired with delivered_at (projects_delivery_pair_check).';
