-- Migration: 217_project_delivered_comments
-- Date: 2026-10-30
--
-- `delivered` has a writer again: services/project-delivered.ts stamps it once RM
-- reports the project `closed`. 173's column comments still named the removed
-- bug-hunt writer as the only one. Comment-only DDL; idempotent.

COMMENT ON COLUMN projects.delivered_at IS
  'When the project became status=delivered: RM closed it (services/project-delivered.ts); '
  'older rows: a bug_hunt whose hunt PR existed. Authority: backend/migrations/173_project_delivered.sql.';
COMMENT ON COLUMN projects.delivery_evidence IS
  '{source:rm_project_closed, rm_pm_project_id, phase}; older bug_hunt rows: '
  '{computed_check_id, evidence_sha, outcome, hunt_card_id, pr:{number, head_sha, url}}. '
  'Paired with delivered_at (projects_delivery_pair_check).';
