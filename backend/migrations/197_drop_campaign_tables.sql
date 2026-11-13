-- Migration: 197_drop_campaign_tables
-- Date: 2026-10-18
--
-- Drop the two campaign tables (George, 2026-10-18). Their only readers and
-- writers were the bulk fan-out (POST /api/projects/bulk, deleted in fr-agui
-- P4d-2a) and the campaign kill-switch routes (deleted in P4d-2d), so both
-- tables have had no code touching them since.
--
-- Measured on prod before this change (2026-10-18): campaign_jobs 0 rows;
-- campaign_governance_controls 1 row, the default singleton (bulk_disabled =
-- false, never set). No foreign key or view references either table.
--
-- Pure DDL: schema.ts no longer declares the tables, so `drizzle-kit push`
-- reproduces the result on a fresh database and nothing here needs a probe.
-- ⚠️ 076's migration-runner probe (tableExists('campaign_governance_controls'))
-- is REMOVED in the same change: left in place it would read FALSE after this
-- file and the post-run integrity check would fail every boot.
--
-- The andon cord (/api/andon; tables andon_state, andon_state_history) is a
-- separate mechanism and is not touched.

DROP TABLE IF EXISTS campaign_jobs;
DROP TABLE IF EXISTS campaign_governance_controls;
