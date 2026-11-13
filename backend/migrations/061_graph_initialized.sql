-- Migration: 061_graph_initialized
-- Plan ref: ~/.claude/plans/i-was-testing-fr-lazy-reef.md (Bug 2 / Part A3)
--
-- `projects.repository_provisioned` conflated two distinct upstream states:
-- (1) the coding-containers container was created, and (2) the code graph
-- was initialized so the Architecture / Dependency / Quality tabs have
-- something to query. handleProvisionProject stamped repository_provisioned
-- = TRUE even when initializeGraph() failed (it only logged a
-- graph_init_warning), so the row claimed success while the architecture
-- tab 404s.
--
-- This adds a dedicated `graph_initialized` flag. handleProvisionProject now
-- sets it TRUE only when initializeGraph() actually succeeded (HTTP ok or
-- 409 already-exists); repository_provisioned keeps its narrower meaning
-- ("the container step succeeded"). Existing rows default to FALSE — they
-- must be re-provisioned (the coding-containers store was wiped in the
-- 2026-05 infra migration), so FALSE is the honest starting value.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS heals partial applies.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS graph_initialized BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
