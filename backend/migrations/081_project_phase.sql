-- Migration: 081_project_phase
-- Date: 2026-06-18
-- Plan ref: ~/.claude/plans/fr-reproduced-bugs-1-ticklish-papert.md (work-stream A)
--
-- The "Copilot-led" redesign surfaces a MACRO phase rail on the project cockpit:
-- where the project is across the AA lifecycle spine
--   request → preliminary_analysis → contract → deep_analysis → epic_design →
--   enabler_architecture → enabler_development → feature_design → feature_development
-- (handoff §2). Until now projects carried only `status`
-- (submitted/active/archived/failed) — a coarse operational state, NOT the
-- lifecycle phase. This migration adds the phase as ground-truth so the rail is
-- real, not derived: n8n stamps it forward on gate approval (PATCH
-- /api/projects/:id/phase), starting with the contract gate.
--
-- `continuous` is the phase value for continuous_flow (kaizen / meta) boards,
-- which loop the card mantra indefinitely rather than walking the spine.
--
-- Modeled as plain TEXT with a documented default (mirrors `status` / `shape`'s
-- text-with-allowed-values style — no Postgres ENUM, so adding phases later is a
-- code change, not a migration). Existing rows backfill to `request`; a project
-- that already has downstream work keeps its coarse `status` and simply starts
-- the rail at `request` until n8n advances it.
--
-- Pre-prod, forward-only.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_phase            TEXT        NOT NULL DEFAULT 'request',
  ADD COLUMN IF NOT EXISTS project_phase_updated_at TIMESTAMPTZ;

-- continuous_flow boards never walk the spine — start them on the continuous
-- phase so the rail renders its continuous-mode band from the first load.
UPDATE projects
   SET project_phase = 'continuous'
 WHERE shape = 'continuous_flow'
   AND project_phase = 'request';

COMMIT;
