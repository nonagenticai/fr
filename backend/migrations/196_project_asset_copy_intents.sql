-- Migration: 196_project_asset_copy_intents
-- Date: 2026-10-16
--
-- fr-agui SPEC §13 P2 / OQ-16: the claim + journal that makes the
-- `project_assets.edit` copy-on-write idempotent and serialised.
--
-- The copy-on-write is five writes across two systems (create the copy
-- UPSTREAM, bind it, record the override, unbind the original — fr) and none of
-- them can share one transaction. Without a claim, a failure after the upstream
-- create left a copy no override recorded, so a retry created a SECOND copy;
-- and two members editing at once each created one (the override's unique
-- index is keyed on the COPY id, so it could not stop them).
--
-- One row per (project, kind, original) IN PROGRESS:
--   * claimed FIRST, before the upstream create — the primary key is the
--     mutual exclusion (a second editor finds a fresh claim and is answered
--     409 edit_in_progress, never a second copy);
--   * `copy_id` / `copy_ref` are journalled the moment the copy exists, so a
--     retry RESUMES with that copy instead of creating another;
--   * `copy_create_started_at` is set just before the upstream create and
--     cleared when its outcome is known. A retry that finds it still set (the
--     create's answer was lost: upstream may have committed a copy fr never
--     learned the id of) reports a POSSIBLE ORPHAN copy before creating again —
--     the upstream create has no idempotency key, so this window can be
--     detected but not closed from fr;
--   * the row is DELETED when the copy-on-write is complete (the override is
--     then the record); `claim_token` is cleared on a thrown failure so a retry
--     resumes at once, and a crashed holder's claim is taken over after the
--     lease (services/project-asset-copy-intents.ts) — no session state, no
--     advisory lock held across the route calls (pgbouncer pool 2+1, see
--     services/workspace-admin-revoke-lock.ts "WHY ONE CONNECTION").
--
-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime, fr#1283): PROTECTED, the
-- default. Its own deletes are single-row (completion), which the bulk-delete
-- trigger passes at once. Listed in 142's `protected_tables` AND attached at
-- the bottom of THIS file (as 160 / 191 / 194 do): in production 142 never
-- re-runs, so this attach is what guards the table.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (so a
-- push-built database satisfies the probe). Idempotent (IF NOT EXISTS) — safe
-- under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps each file in a
-- SAVEPOINT.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS project_asset_copy_intents (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_kind asset_type NOT NULL,
  original_id text NOT NULL,
  workspace_id uuid NOT NULL,
  copy_id text NULL,
  copy_ref text NULL,
  copy_changes_key text NULL,
  copy_create_started_at timestamptz NULL,
  claim_token uuid NULL,
  claimed_by text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_asset_copy_intents_pk PRIMARY KEY (project_id, asset_kind, original_id)
);

-- Attach migration 142's guard (functions fr_refuse_truncate /
-- fr_refuse_bulk_delete). Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_project_asset_copy_intents
  BEFORE TRUNCATE ON public.project_asset_copy_intents
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.project_asset_copy_intents
  ENABLE ALWAYS TRIGGER fr_guard_truncate_project_asset_copy_intents;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_project_asset_copy_intents
  AFTER DELETE ON public.project_asset_copy_intents
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.project_asset_copy_intents
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_project_asset_copy_intents;
