-- Migration: 067_asset_bindings
-- Date: 2026-05-19
-- Plan ref: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase A)
--
-- Cross-asset-type project bindings. Bindings are the authoritative
-- project-scope signal for automation: an asset is "in scope" for n8n
-- on project P iff a row exists in asset_bindings for (kind, id, P).
-- Empty-bindings rows are tenant-wide and OUT of scope for n8n on every
-- specific project.
--
-- One table covers all 9 kinds (requirement, principle, decision,
-- procedure, kag_document, workflow, trigger, channel, artifact) to
-- keep cross-cutting reads simple. `asset_id` is text (mirrors the
-- assignments table) so non-uuid upstream ids (procedure numeric ids,
-- channel slugs, n8n string ids) can join.
--
-- `bound_by_user_id` is text, free-form: holds a subject_id for human
-- binds and `workflow:<run_id>` for n8n auto-binds (Phase F).
--
-- Cascade-on-project-delete: when a project is deleted, its bindings
-- vanish but the underlying assets remain (origin still records where
-- they came from on the upstream service).
--
-- All DDL is idempotent. Pre-prod, forward-only.

BEGIN;

CREATE TABLE IF NOT EXISTS asset_bindings (
  asset_kind       asset_type   NOT NULL,
  asset_id         text         NOT NULL,
  project_id       uuid         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bound_at         timestamptz  NOT NULL DEFAULT now(),
  bound_by_user_id text         NOT NULL,
  PRIMARY KEY (asset_kind, asset_id, project_id)
);

CREATE INDEX IF NOT EXISTS asset_bindings_project_id_idx
  ON asset_bindings (project_id);

CREATE INDEX IF NOT EXISTS asset_bindings_asset_idx
  ON asset_bindings (asset_kind, asset_id);

COMMIT;
