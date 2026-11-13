-- Migration: 035_drop_improvements_table
-- Date: 2026-04-29
-- Slice: 2026-04-27-continuous-improvement-design (Spec 3 §6.0)
--
-- The per-project `improvements` table and its `/api/improvements` routes
-- were a separate sketch that the system-level improvement-stream model
-- supersedes (Spec 3 §6.0 — clarified by user 2026-04-29). Improvements
-- are NOT per-project; they belong to two internal/service tenants and
-- live as kanban cards on Planka boards owned by those tenants.
--
-- Drop the table here; the matching code (routes, schema, OpenAPI,
-- frontend client/types, tests) is removed in the same commit.

BEGIN;

DROP TABLE IF EXISTS improvements CASCADE;

COMMIT;
