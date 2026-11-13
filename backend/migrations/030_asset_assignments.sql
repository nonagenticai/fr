-- backend/migrations/028_asset_assignments.sql
-- Foundation Plan 2 — Task 4
--
-- The unified scope-assignment table for the Library effective-set logic
-- (Spec 1 §6.2). One row per (asset, scope) edge. fr-backend's existing
-- assets aggregator joins against this table to compute the effective set
-- per (project, asset_type) without modifying upstream services.
--
-- Two partial unique indexes are needed because Postgres treats NULLs as
-- distinct: workspace-scope rows have target_id = NULL and need a separate
-- uniqueness constraint from department/project rows.
--
-- The `link_kind = 'override'` row also requires `overrides_id` (the
-- workspace-default `owns` row that's being overridden) — enforced via
-- CHECK so the service layer can rely on the invariant.
--
-- Channels can only be scoped at workspace or department level (per
-- Spec 1 §10) — never per-project.
BEGIN;

CREATE TYPE asset_type AS ENUM (
  'requirement','principle','decision','procedure','kag_document',
  'workflow','trigger','artifact','channel'
);

CREATE TYPE scope_level AS ENUM ('workspace','department','project');

CREATE TYPE link_kind AS ENUM ('owns','override','block');

CREATE TABLE IF NOT EXISTS asset_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_type    asset_type NOT NULL,
  asset_id      uuid NOT NULL,
  scope_level   scope_level NOT NULL,
  target_id     uuid NULL,             -- null when scope_level='workspace'
  link_kind     link_kind NOT NULL,
  overrides_id  uuid NULL,             -- only when link_kind='override'
  effective_at  timestamptz NOT NULL DEFAULT now(),
  assigned_by   text NOT NULL,
  CHECK (asset_type <> 'channel' OR scope_level IN ('workspace','department')),
  CHECK ((link_kind = 'override') = (overrides_id IS NOT NULL))
);

-- Two partial uniques because Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_uq_with_target
  ON asset_assignments (asset_type, asset_id, scope_level, target_id)
  WHERE target_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_uq_workspace
  ON asset_assignments (asset_type, asset_id, scope_level)
  WHERE target_id IS NULL;

CREATE INDEX IF NOT EXISTS asset_assignments_lookup
  ON asset_assignments (workspace_id, asset_type, scope_level, target_id);

COMMIT;
