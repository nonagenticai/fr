-- Migration: 143_multi_repo_coordination
-- Date: 2026-09-30
--
-- MULTI-REPO COORDINATION: how a project's repos are worked (`projects.
-- coordination_mode`), and in WHAT ORDER they are listed (`project_repositories.
-- position`).
--
-- Two columns, one subject. A project that consumes 0..N repos (migration 072)
-- has never carried either fact: nothing says whether those repos move as ONE
-- unit of work or independently, and nothing gives them a stable order.
--
-- ── 1. `projects.coordination_mode` — WHY THE DEFAULT IS A BACKFILL ───────
-- `text NOT NULL DEFAULT 'coordinated'`, with a named CHECK admitting exactly
-- 'coordinated' and 'independent'.
--
-- ⭐ THE DEFAULT DELIBERATELY BACKFILLS EVERY EXISTING ROW IN THE ONE ALTER,
-- AND THAT IS NOT A SHORTCUT — it is the only value that preserves today's
-- behaviour. Single-repo behaviour as it exists right now IS one coordinated
-- unit of work: one project, one brief, one card stream, everything moving
-- together. So stamping every pre-existing project 'coordinated' asserts about
-- those rows exactly what was already true of them, and NO existing project
-- changes behaviour when this migration applies. The alternative shapes were
-- both worse and are rejected on the record:
--   * NULLABLE with no default — every reader then needs a
--     `?? 'coordinated'` fallback, i.e. the default written N times in
--     application code instead of once in the schema, and the estate has the
--     worked example of what that costs: a missing lookup key falls back to a
--     DEFAULT, so the failure is the WRONG value rather than nothing.
--   * DEFAULT 'independent' — that WOULD change existing behaviour, silently,
--     for every project already on the board.
-- ⚠️ Postgres 11+ adds a NOT NULL column with a non-volatile default as a
-- CATALOG-ONLY rewrite (the default is materialised on read), so this is not a
-- full-table rewrite and needs no batching. It is still an ACCESS EXCLUSIVE
-- lock for the duration of the catalog update.
--
-- ⛔ NO `pgEnum`, matching `projects.shape`, `projects.status` and
-- `projects.project_phase`: plain text plus a named CHECK, so adding a third
-- mode later is a code change rather than a DB-enum migration. The constraint
-- is NAMED so `src/db/schema.ts` can spell the same identifier — an unnamed
-- CHECK gets an auto-generated name that `drizzle-kit push` (which bootstraps
-- the CI database) would not reproduce, and CI would then accept a value prod
-- rejects. That exact divergence is what the comment above `projects`' existing
-- `check()` array in schema.ts records having been MEASURED.
--
-- ── 2. `project_repositories.position` — THE MEASURED DEFECT ──────────────
-- `integer NOT NULL DEFAULT 0`. This is NOT tidiness. It closes a live
-- non-determinism, and both halves were read off this tree:
--
--   * `backend/migrations/072_project_repositories.sql:77` declares
--         added_at  timestamptz NOT NULL DEFAULT now()
--   * `backend/src/routes/project-repositories.ts:95` orders the list with
--         .orderBy(desc(projectRepositories.is_primary),
--                  asc(projectRepositories.added_at))
--
-- ⭐ `now()` IS `transaction_timestamp()` — it is the START-OF-TRANSACTION
-- clock, not the wall clock, and it is documented as such. So EVERY row a
-- single project-create inserts carries a BYTE-IDENTICAL `added_at`. The
-- orderBy above therefore has NO TIEBREAK past `is_primary`, and the order of
-- the secondary repos is whatever the plan happens to emit — stable-looking in
-- testing, free to change after any VACUUM, index-only scan or plan flip.
--
-- ⚠️ The distinction is already known in this tree, which is the corroboration
-- rather than my assertion: `141_card_asset_binding.sql` deliberately writes
-- `claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()` — the per-call
-- clock — precisely because `now()` cannot discriminate rows inside one
-- transaction. 072 predates that reasoning; this file is the repair on the read
-- side of it.
--
-- ⛔ `added_at` IS NOT CHANGED, AND THE ORDER BY IS NOT CHANGED HERE. Migrating
-- `added_at` to `clock_timestamp()` would fix nothing for the rows that already
-- exist (their timestamps are already identical and unrecoverable), and the
-- route change belongs with the code that reads the new column, not with the
-- DDL. THIS FILE ONLY MAKES A DETERMINISTIC ORDER *AVAILABLE*; until a caller
-- orders by it, the non-determinism above is still live. Do not read this
-- migration as the fix on its own.
--
-- ── 3. BACKFILL — WHY `repo_id` AND NOT `added_at` ────────────────────────
-- Existing rows are ranked so ordering is stable from day one: the primary row
-- gets 0, the rest get a deterministic increasing value per project.
--
-- ⭐ THE RANK KEY IS `repo_id`, DELIBERATELY, AND FOR THE SAME REASON THE
-- COLUMN EXISTS: `added_at` CANNOT DISCRIMINATE. Ranking by the column that is
-- byte-identical across a project's rows would hand `row_number()` an
-- arbitrary tiebreak and bake TODAY's accidental plan order into a column whose
-- entire purpose is to be stable — a backfill that inherits the defect it is
-- repairing. `repo_id` is a uuid and part of the primary key
-- (`PRIMARY KEY (project_id, repo_id)`, 072), so it is NOT NULL and unique
-- within a project: it is the only stable total order available on this table.
-- `is_primary DESC` leads the ORDER BY so the primary row lands on 0, and it
-- cannot itself tie — `project_repositories_primary_unique` (072 §4) permits at
-- most one `is_primary` row per project. A project with no primary simply gets
-- its lowest `repo_id` at 0, still deterministically.
--
-- ⚠️ `repo_id` order is ARBITRARY, not meaningful — it is not insertion order
-- and does not claim to be. The guarantee is STABILITY, not intent. Whoever
-- wants intent-ordered repos must write positions explicitly; the backfill only
-- guarantees that two reads return the same order.
--
-- IDEMPOTENT: the UPDATE carries `IS DISTINCT FROM`, so a re-run matches ZERO
-- rows. `ADD COLUMN IF NOT EXISTS` and a `pg_constraint`-guarded CHECK make the
-- DDL replayable by hand. No row is deleted and no row is inserted.
--
-- ── RUNNER CONTRACT ──────────────────────────────────────────────────────
-- ⚠️ NOT PROBED, DELIBERATELY, matching 105, 106 and 107, and the reason is
-- STRUCTURAL rather than a preference. `src/db/migration-runner.ts` stamps a
-- migration applied-without-running when `_migrations` is empty and `projects`
-- already exists — CI's bootstrap state — unless a `COLUMN_PROBES` target is
-- MISSING. Both columns here ARE mirrored into `src/db/schema.ts`, so
-- `drizzle-kit push` creates them and any column-shaped probe would PASS on
-- CI; it could not force this file to run there even if one were added. A
-- column probe cannot express "the backfill has not happened".
--
-- ⚠️ RESIDUAL, NAMED NOT HIDDEN: on a push-built database the UPDATE is
-- therefore skipped, and every `project_repositories` row keeps `position` = 0
-- from the DEFAULT. ⛔ So NO test may assert DISTINCT positions on rows it did
-- not write positions for — that expectation is satisfied only by this
-- backfill, and this backfill does not run in CI. Tests must set `position`
-- explicitly. A fresh database has nothing to back-fill, which is why the skip
-- loses nothing operationally.
--
-- ⚠️ NOT MEASURED IN THIS UNIT, stated so nobody reads a number that was never
-- taken: this file quotes NO production row counts. `projects` and
-- `project_repositories` cardinality on `postgres.example.com:5432` was not probed
-- (no DB access in this unit of work). Nothing here depends on the count — the
-- ALTERs are catalog-only and the UPDATE is self-limiting — but if a reviewer
-- wants a lock-duration estimate, measure it; do not infer one from this file.
--
-- Mirrored in the Drizzle schema (`src/db/schema.ts`): `projects.
-- coordination_mode` + `projects_coordination_mode_check` in that table's
-- `check()` array, and `projectRepositories.position`. Required, not optional:
-- `drizzle-kit push` builds the CI database from that file, so a schema that
-- omits either column produces a CI database this migration's assumptions do
-- not hold on, and a generated TYPE that lies about the row shape.
--
-- Both tables are already in migration 142's `protected_tables` array, so the
-- destructive-statement guard covers them and this file changes nothing there.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

-- ---------------------------------------------------------------------------
-- 1. projects.coordination_mode
-- ---------------------------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS coordination_mode text NOT NULL DEFAULT 'coordinated';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_coordination_mode_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_coordination_mode_check
      CHECK (coordination_mode IN ('coordinated', 'independent'));
  END IF;
END$$;

COMMENT ON COLUMN projects.coordination_mode IS
  'How this project''s repos are worked: ''coordinated'' (one unit of work '
  'across every repo — the pre-existing behaviour, and the DEFAULT every row '
  'was backfilled with) or ''independent''. Vocabulary is a named CHECK, not a '
  'pgEnum, matching projects.shape. Authority: '
  'backend/migrations/143_multi_repo_coordination.sql.';

-- ---------------------------------------------------------------------------
-- 2. project_repositories.position
-- ---------------------------------------------------------------------------

ALTER TABLE project_repositories
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN project_repositories.position IS
  'Stable 0-based display order within a project; the primary repo is 0. Exists '
  'because added_at (072:77) defaults to now() = transaction_timestamp(), so '
  'every row of one project-create shares a byte-identical timestamp and the '
  'orderBy(desc(is_primary), asc(added_at)) at '
  'src/routes/project-repositories.ts:95 has no tiebreak. Authority: '
  'backend/migrations/143_multi_repo_coordination.sql.';

-- ---------------------------------------------------------------------------
-- 3. Backfill. Primary row -> 0, then increasing by repo_id (the only key on
--    this table that can discriminate rows of one project — see the header).
--    `IS DISTINCT FROM` makes the re-run a zero-row statement.
-- ---------------------------------------------------------------------------

UPDATE project_repositories pr
   SET position = ranked.pos
  FROM (
    SELECT project_id,
           repo_id,
           (row_number() OVER (
              PARTITION BY project_id
              ORDER BY is_primary DESC, repo_id ASC
            ) - 1)::integer AS pos
      FROM project_repositories
  ) AS ranked
 WHERE pr.project_id = ranked.project_id
   AND pr.repo_id    = ranked.repo_id
   AND pr.position IS DISTINCT FROM ranked.pos;
