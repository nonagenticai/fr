-- backend/migrations/132_finding_suppression_events.sql
--
-- FINDING SUPPRESSION: category + an append-only decision trail.
--
-- Migration 130 gave the ledger a way IN (PUT /api/findings/suppressions) and
-- no way OUT except hand-written SQL, and it let any caller who can see the
-- project suppress any finding — security findings included. This file adds:
--
--   (1) finding_suppressions.category — optional, caller-declared finding
--       category (e.g. 'security'). The PUT route requires elevated rights
--       (project owner or super_admin) when the category is a security one.
--       The fingerprint itself (`<16 hex>.<ordinal>`) carries no tool/category,
--       so the category has to be declared; it cannot be derived.
--   (2) finding_suppression_events — one row per state change: 'suppress'
--       when a PUT actually created the ledger row, 'unsuppress' when
--       DELETE /api/findings/suppressions removed it. Each event is written in
--       the SAME statement as the ledger change (a data-modifying CTE), so a
--       ledger change without its event cannot exist.
--
-- ⛔ project_id carries NO foreign key, on purpose. finding_suppressions rows
-- cascade away with their project; the TRAIL must outlive both, or deleting a
-- project erases who suppressed/unsuppressed what. tenant_id is the ACTIVE
-- tenant of the acting caller (audit only), no FK, like every tenant column in
-- fr.
--
-- Idempotent and DDL-only (ADD COLUMN IF NOT EXISTS / CREATE … IF NOT EXISTS /
-- COMMENT): CI builds the same shape from schema.ts via `drizzle-kit push`, so
-- scripts/check-migration-dml-probed.ts needs no probe for it.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

ALTER TABLE finding_suppressions ADD COLUMN IF NOT EXISTS category text;

CREATE TABLE IF NOT EXISTS finding_suppression_events (
  id          bigserial   PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  project_id  uuid        NOT NULL,
  fingerprint text        NOT NULL,
  action      text        NOT NULL,
  reason      text        NOT NULL,
  category    text,
  actor       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Named explicitly so schema.ts (drizzle-kit push, CI) and this file (prod)
  -- emit the SAME constraint name.
  CONSTRAINT finding_suppression_events_action_check
    CHECK (action IN ('suppress', 'unsuppress'))
);

CREATE INDEX IF NOT EXISTS finding_suppression_events_project_fp_idx
  ON finding_suppression_events (project_id, fingerprint, created_at);

COMMENT ON TABLE finding_suppression_events IS
  'Append-only trail of finding suppression decisions: suppress (a PUT that created the '
  'ledger row) and unsuppress (a DELETE that removed it). Written in the same statement as '
  'the ledger change. No FK on project_id: the trail outlives the project.';
