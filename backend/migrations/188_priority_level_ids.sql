-- Migration: 188_priority_level_ids
-- Date: 2026-10-13
-- Refs: design "fr consumes RM vocabulary" (~/.claude/plans/fr-consumes-rm-vocabulary-design.md),
--       George's decision Q3 = (b), 2026-10-12: STORE THE RM priority-level id.
--
-- A priority is one of the TENANT's requirements_management priority levels,
-- and fr stores the level's id. P0..P3 is stored in exactly ONE fr table,
-- `priority_change_events` (from_priority / to_priority, migration 160); the
-- other two homes are JSON, not columns: `projects.project_data.priority`
-- (gets a sibling `priority_level_id` key — no DDL) and Planka's
-- `Metadata.priority` (outside fr's database).
--
-- This file, forward-only:
--   * ADDs priority_change_events.from_priority_level_id / to_priority_level_id
--     (uuid, NULL = unset or not yet backfilled; no FK — the level lives in RM);
--   * DROPs priority_change_events_to_check (to_priority IN ('P0'..'P3')): a
--     tenant's level names are its own, so a global vocabulary CHECK would
--     refuse them with 23514.
-- The legacy text columns STAY for the backfill window only. The ids cannot be
-- backfilled in SQL (they are per tenant, in RM): scripts/backfill-priority-
-- level-ids.ts does it. FOLLOW-UP migration: drop from_priority / to_priority
-- (and project_data.priority) once that job measures 100% for every tenant.
--
-- RUNNER CONTRACT: pure DDL, no DML. Idempotent (IF NOT EXISTS / IF EXISTS) —
-- safe under `reapplyIfProbeFails`. No BEGIN/COMMIT (the runner wraps each
-- file in a SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE priority_change_events ADD COLUMN IF NOT EXISTS from_priority_level_id uuid;
ALTER TABLE priority_change_events ADD COLUMN IF NOT EXISTS to_priority_level_id uuid;
ALTER TABLE priority_change_events DROP CONSTRAINT IF EXISTS priority_change_events_to_check;
