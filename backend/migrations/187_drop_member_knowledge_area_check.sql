-- Migration: 187_drop_member_knowledge_area_check
-- Date: 2026-10-13
-- Refs: design "fr consumes RM vocabulary" (~/.claude/plans/fr-consumes-rm-vocabulary-design.md),
--       George's decision Q1 = (a), 2026-10-12.
--
-- Knowledge areas were fr's 15 card_groups, a global list pinned by
-- member_knowledge_areas_area_check (migration 135). Q1 = (a) replaced the card
-- groups with the TENANT's requirements_management capabilities, so the area
-- vocabulary is now per tenant and lives in RM: a global CHECK over one fixed
-- list would refuse every capability fr never knew (e.g. the v3
-- `requirements_management`, `bdd_tdd`) with a 23514 / 500. App-level validation
-- against the tenant's capabilities replaces it (PUT knowledge-areas: 422 with
-- the tenant's own list). Existing rows are kept as written.
--
-- This file DROPS, forward-only: member_knowledge_areas_area_check.
-- db/schema.ts no longer declares it, so `drizzle-kit push` never builds it.
--
-- RUNNER CONTRACT: pure DDL, no DML. Idempotent (DROP CONSTRAINT IF EXISTS) —
-- safe under `reapplyIfProbeFails`; its probe (src/db/migration-runner.ts)
-- asserts ABSENCE. No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

ALTER TABLE member_knowledge_areas DROP CONSTRAINT IF EXISTS member_knowledge_areas_area_check;
