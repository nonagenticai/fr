-- Migration: 076_campaign_governance
-- Date: 2026-06-06
-- Plan ref: ~/.claude/plans/handoff-written-to-claude-plans-it-flow1-buzzing-harp.md
--           (Phase D1 — L3 governance for the bulk fan-out)
--
-- Two governance levers on top of the Phase-B campaign_jobs ledger:
--
--   1. `campaign_jobs.owner` — the GitHub owner/org each fan-out item targets,
--      derived from target_repo_url. The per-owner concurrency/volume CAP
--      counts non-failed rows per (tenant, campaign, owner); the supporting
--      index keeps that count cheap. Backfilled from the existing rows.
--
--   2. `campaign_governance_controls` — a single-row runtime KILL-SWITCH so an
--      operator can disable POST /api/projects/bulk WITHOUT a redeploy (the
--      boot-level PROJECTS_BULK_DISABLED env is the complementary hard off).
--      The CHECK(id=1) makes the table hold exactly one row.
--
-- Pre-prod, forward-only. Idempotent on re-run via IF NOT EXISTS guards.

BEGIN;

-- 1. owner column + cap-counting index.
ALTER TABLE campaign_jobs
  ADD COLUMN IF NOT EXISTS owner text;

-- Backfill owner from the existing target_repo_url (lowercased, .git stripped,
-- both https and scp-style forms). NULL when the URL isn't a github.com URL.
UPDATE campaign_jobs
SET owner = lower(regexp_replace(
      (regexp_match(target_repo_url, 'github\.com[:/]+([^/[:space:]]+)', 'i'))[1],
      '\.git$', '', 'i'))
WHERE owner IS NULL
  AND target_repo_url ~* 'github\.com[:/]+';

CREATE INDEX IF NOT EXISTS campaign_jobs_owner_idx
  ON campaign_jobs (tenant_id, owner, status);

-- 2. single-row runtime kill-switch control.
CREATE TABLE IF NOT EXISTS campaign_governance_controls (
  id              smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bulk_disabled   boolean      NOT NULL DEFAULT false,
  disabled_reason text,
  updated_by      text,
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- Seed the singleton row (enabled). ON CONFLICT keeps a re-run a no-op.
INSERT INTO campaign_governance_controls (id, bulk_disabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
