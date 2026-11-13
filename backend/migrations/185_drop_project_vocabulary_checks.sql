-- Migration: 185_drop_project_vocabulary_checks
-- Date: 2026-10-13
-- Refs: design "fr consumes RM vocabulary" (~/.claude/plans/fr-consumes-rm-vocabulary-design.md),
--       APPROVED by George 2026-10-12.
--
-- fr no longer owns a project-phase or project-type vocabulary. A project's
-- type is one of its TENANT's requirements_management project types, and its
-- phases are the ordered phases of that type (backend/src/services/catalogue/
-- tenant-catalogue.ts). The vocabularies are per tenant and live in RM, so a
-- global CHECK over one fixed list is wrong by construction: it would refuse
-- every RM name fr never knew (e.g. the v3 kinds `bug_hunt_fix`, `feature_new`)
-- with a 23514 / 500. App-level validation against the tenant catalogue
-- replaces them (create door: 422 `project_type_unknown`; PATCH /phase: 422
-- `invalid_phase`).
--
-- This file DROPS, forward-only:
--   * projects_project_phase_check (migration 165, fr#1475)
--   * projects_project_type_check  (migration 166, fr#1476)
-- db/schema.ts no longer declares either, so `drizzle-kit push` never builds them.
-- The priority and member-knowledge-area CHECKs are NOT touched here (part 2).
--
-- Numbered 185 deliberately: 176-184 are reserved by another branch. The runner
-- orders by the parsed number and applies any unstamped file, so a later 176-184
-- applies cleanly after this one; check-migration-numbers checks uniqueness only
-- (gaps are out of its scope by design).
--
-- RUNNER CONTRACT: pure DDL, no DML. Idempotent (DROP CONSTRAINT IF EXISTS) —
-- safe under `reapplyIfProbeFails`; its probe (src/db/migration-runner.ts)
-- asserts ABSENCE of both. 165's and 166's presence probes were REMOVED with
-- this file: kept, they would read FALSE after it on every boot and re-create
-- the constraints this file drops. No BEGIN/COMMIT — the runner wraps each file
-- in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_phase_check;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check;
