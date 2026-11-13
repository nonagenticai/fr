-- Migration: 075_campaign_jobs
-- Date: 2026-06-06
-- Plan ref: ~/.claude/plans/handoff-written-to-claude-plans-it-flow1-buzzing-harp.md
--           (Phase B — programmatic fr project fan-out)
--
-- Mass dependency-upgrade campaigns fan out N fr projects from a single
-- POST /api/projects/bulk call, one project (+ Planka board + n8n
-- development_chore pipeline) per target repo. `campaign_jobs` is the light,
-- board-free ledger that makes a fan-out:
--   * idempotent — the UNIQUE (tenant_id, campaign_id, target_repo_url,
--     target_package) key lets a re-run of the same campaign skip repos that
--     already produced a project, so re-driving never double-PRs;
--   * resumable / observable — per-item status + project_id + pr_url +
--     last_error are queryable without re-deriving state from N Planka boards.
--
-- Columns are intentionally `text` (not uuid) for tenant_id/campaign_id so the
-- ledger holds whatever ctxTenantId() resolves (uuid7 in prod, the bypass /
-- arbitrary tenant string in tests) and operator-chosen campaign labels.
-- project_id FKs `projects` ON DELETE SET NULL so deleting a project leaves an
-- auditable campaign row behind rather than cascading the history away.
--
-- Pre-prod, forward-only. Idempotent on re-run via IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_jobs (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text         NOT NULL,
  campaign_id     text         NOT NULL,
  target_repo_url text         NOT NULL,
  target_package  text         NOT NULL,
  project_id      uuid         REFERENCES projects(id) ON DELETE SET NULL,
  status          text         NOT NULL DEFAULT 'pending',
  pr_url          text,
  last_error      text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- Dedup key = the idempotency seam. ON CONFLICT DO NOTHING on insert means a
-- re-run of the same (tenant, campaign, repo, package) tuple is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_jobs_dedup
  ON campaign_jobs (tenant_id, campaign_id, target_repo_url, target_package);

-- List a campaign's progress.
CREATE INDEX IF NOT EXISTS campaign_jobs_campaign_idx
  ON campaign_jobs (tenant_id, campaign_id);

-- Resolve a campaign row from a project (and skip ON DELETE-orphaned rows).
CREATE INDEX IF NOT EXISTS campaign_jobs_project_idx
  ON campaign_jobs (project_id);

COMMIT;
