-- backend/migrations/026_workspaces_and_departments.sql
-- Foundation Plan 2 — Task 1
--
-- Adds the `workspaces` + `departments` org-hierarchy tables and a nullable
-- `dept_id` FK on existing `projects`. The workspace id is intentionally the
-- same UUID as the existing tenant_id used elsewhere (see user_roles); the
-- backfill in migration 029 seeds one workspaces row per distinct tenant.
--
-- `departments_one_default_per_workspace` is a partial unique that enforces
-- "exactly one default department per workspace" — the per-workspace default
-- is what the lazy effective-set helpers fall back to when no explicit
-- assignment is found.
BEGIN;

CREATE TABLE IF NOT EXISTS workspaces (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  is_default      boolean NOT NULL DEFAULT false,
  default_landing boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz NULL,
  UNIQUE (workspace_id, name)
);

-- Exactly one default department per workspace (partial unique).
CREATE UNIQUE INDEX IF NOT EXISTS departments_one_default_per_workspace
  ON departments (workspace_id) WHERE is_default = true;

-- Add dept_id FK to projects if the column doesn't already exist.
-- Belt-and-braces: the outer DO guard avoids the index re-create when the
-- column predates this migration; the inner IF NOT EXISTS makes the column
-- ADD itself a no-op so a partially-applied state can't trip duplicate-column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='projects' AND column_name='dept_id'
  ) THEN
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS dept_id uuid REFERENCES departments(id);
    CREATE INDEX IF NOT EXISTS projects_dept_id_idx ON projects(dept_id);
  END IF;
END $$;

COMMIT;
