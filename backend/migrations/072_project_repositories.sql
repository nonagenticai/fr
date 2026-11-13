-- Migration: 072_project_repositories
-- Date: 2026-05-27
-- Plan ref: ~/.claude/plans/fr-phase-5-architecture-lucky-fog.md (PR 2/3)
-- Companion: req_man PR 1 — architecture_element_realisation_bindings (the
-- strategic-layer N-ary; req_man owns).
--
-- Multi-repo per project. Until now `projects.repository_url` was a single
-- `text NOT NULL` slot — fine for "one project, one repo" but the AA
-- pipeline and the architecture↔code-binding work both need a project to
-- consume 0..N provisioned repos (and to mint a brief that names them all).
--
-- New table `project_repositories` is the N:M join between `projects` and
-- the existing `repositories` table. Existing `projects.repository_url /
-- branch / container_name` columns STAY as a denormalised primary so every
-- existing reader (the AG-UI project-start brief at routes/projects.ts
-- :230–284, `integrations/coding/adapter.ts:81–127` repo_id resolver,
-- `integrations/coding/head-sha.ts:118–154` HEAD-sha resolver) keeps
-- working unchanged. The join row carries the operational truth; the
-- denormalised columns are a cache the primary-promote handler keeps in
-- sync.
--
-- `is_primary` is enforced unique-per-project via a partial unique index
-- (the only correct shape: drizzle-kit's plain `unique` would block every
-- non-primary row from existing). The (project_id, repo_id) PK gives
-- attach idempotency for free.
--
-- `repositories(user_id, url)` gets a deferred-by-history UNIQUE constraint
-- in the same migration so backfill + the create-or-attach path can lean
-- on ON CONFLICT instead of probing. The constraint is added with NOT
-- VALID first + a VALIDATE pass to skip the pre-existing-duplicates risk
-- (deduped in the same migration before the constraint lands).
--
-- Backfill: for each `projects` row carrying a non-null/non-empty
-- repository_url, upsert a `repositories` row owned by the project's
-- owner_id (matching `handleListRepositories`' user-scope) and INSERT
-- a `project_repositories` row with is_primary=true. Idempotent on
-- re-run via the new uniques. Pre-prod, forward-only.

BEGIN;

-- 1. Pre-dedup repositories on (user_id, url) — keep the lowest-id row,
--    re-point any project_repositories / coding_analysis_runs rows that
--    would have collided. Safe on a fresh CI DB where the table is empty.
WITH ranked AS (
  SELECT
    id,
    user_id,
    url,
    row_number() OVER (PARTITION BY user_id, url ORDER BY created_at, id) AS rn
  FROM repositories
),
dupes AS (
  SELECT id FROM ranked WHERE rn > 1
)
DELETE FROM repositories WHERE id IN (SELECT id FROM dupes);

-- 2. UNIQUE (user_id, url) — required for backfill + attach ON CONFLICT.
--    Idempotent via IF NOT EXISTS on the index, then promoted to a
--    constraint via the supporting index so attach can name it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_user_id_url_unique'
      AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_user_id_url_unique UNIQUE (user_id, url);
  END IF;
END$$;

-- 3. The join table.
CREATE TABLE IF NOT EXISTS project_repositories (
  project_id  uuid       NOT NULL REFERENCES projects(id)     ON DELETE CASCADE,
  repo_id     uuid       NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  is_primary  boolean    NOT NULL DEFAULT false,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, repo_id)
);

CREATE INDEX IF NOT EXISTS project_repositories_repo_id_idx
  ON project_repositories (repo_id);

-- 4. Partial unique index: at most one is_primary=true row per project.
--    Plain `UNIQUE (project_id) WHERE is_primary` is the only correct
--    shape — full uniqueness on project_id would block additional
--    repos entirely. Drizzle's `uniqueIndex().where(...)` emits this
--    same SQL but our schema declares it explicitly so a fresh CI DB
--    built via `drizzle-kit push` doesn't get a non-partial unique.
CREATE UNIQUE INDEX IF NOT EXISTS project_repositories_primary_unique
  ON project_repositories (project_id) WHERE is_primary;

-- 5. Backfill from projects.repository_url. Each project's owner_id maps
--    to repositories.user_id (the existing scope on /api/repositories).
--    `path` / `description` left null — the join row is the link; the
--    repository row only needs (user_id, url, branch, container_name)
--    to satisfy resolveRepo() in integrations/coding/adapter.ts.
-- DEDUP NOTE: two `projects` rows owned by the same user CAN share the
-- same `repository_url` (pre-2026-05-27 prod carries this). A naive
-- `INSERT ... SELECT FROM projects ... ON CONFLICT DO UPDATE` then trips
-- Postgres' "ON CONFLICT DO UPDATE command cannot affect row a second
-- time" because the same (user_id, url) pair appears multiple times in
-- one statement (the v1 of this migration hit this on first prod boot —
-- backend crashlooped on startup). Switch to DISTINCT ON + DO NOTHING and
-- do the container_name stamp via a follow-up UPDATE that is naturally
-- one-row-per-target.
INSERT INTO repositories (user_id, name, url, branch, container_name)
SELECT DISTINCT ON (p.owner_id, p.repository_url)
  p.owner_id,
  p.name,
  p.repository_url,
  COALESCE(p.branch, 'main'),
  p.container_name
FROM projects p
WHERE p.repository_url IS NOT NULL
  AND length(trim(p.repository_url)) > 0
ORDER BY p.owner_id, p.repository_url, p.created_at
ON CONFLICT (user_id, url) DO NOTHING;

-- Stamp container_name on previously-orphaned repositories rows whose
-- matching project carries one. COALESCE in the SET clause preserves a
-- manually-set value the operator may have stamped by hand. One-row-per-
-- target so the multi-source-row hazard above does not apply.
UPDATE repositories r
SET container_name = COALESCE(r.container_name, p.container_name),
    updated_at = now()
FROM projects p
WHERE r.user_id = p.owner_id
  AND r.url = p.repository_url
  AND r.container_name IS NULL
  AND p.container_name IS NOT NULL;

INSERT INTO project_repositories (project_id, repo_id, is_primary)
SELECT p.id, r.id, true
FROM projects p
JOIN repositories r ON r.user_id = p.owner_id AND r.url = p.repository_url
WHERE p.repository_url IS NOT NULL
  AND length(trim(p.repository_url)) > 0
ON CONFLICT (project_id, repo_id) DO NOTHING;

COMMIT;
