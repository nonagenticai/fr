-- Migration: 151_project_deliverables_repos
-- Date: 2026-10-01
--
-- PER-DELIVERABLE REPO ATTRIBUTION SURVIVES PROMOTE (fr#1332, C1-58 follow-up).
--
-- ncn#1939's outline worker attributes each outline deliverable to the
-- repositories it changes (`repos` on the `project_outlines.deliverables` jsonb,
-- OutlineDeliverableSchema in src/types/api.ts). Migration 127 had no column for
-- it, so `buildApprovedScopeRows` dropped it at promote and the C1-58 intake
-- minter (ncn `r.doing.mint.intake`) could not say which repository a minted
-- card works in. That minter is this column's READER (#1939's "no field without
-- a reader" rule): it reads `repos` off GET /api/projects/:id/deliverables and
-- names one per child on POST /api/decompositions/commit, which writes it into
-- the card's `repository_url` input.
--
-- ⚠️ NULLABLE, NO DEFAULT, AND NULL IS NOT `{}`. NULL = "not attributed" (the
-- outline omitted `repos`, or the row predates this migration). `{}` would be the
-- false claim "attributed to no repository" — the same absent-vs-empty rule the
-- outline schema keeps by giving `repos` no `.default([])`.
--
-- NO BACKFILL. Existing rows stay NULL, which is the truthful value for them;
-- the attribution of an already-promoted project is still recoverable from
-- `project_outlines` via source_outline_id + position. Pure DDL, IF NOT EXISTS,
-- so CI's drizzle-kit push (schema.ts declares the same column) and this file
-- agree, and re-running is a no-op.

ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS repos TEXT[];

COMMENT ON COLUMN project_deliverables.repos IS
  'Repositories this approved deliverable changes, verbatim from the outline (ncn#1939). NULL = not attributed. Read by the C1-58 intake minter via GET /api/projects/:id/deliverables (fr#1332).';
