-- backend/migrations/133_repositories_name_required.sql
--
-- repositories.name BECOMES REQUIRED AND NON-BLANK.
--
-- WHY. `repositories.name` and `project_request_repositories.name` were the only
-- two nullable name columns left in fr's schema; every other fr-owned name column
-- is already NOT NULL. Three of the four insert paths into `repositories` wrote
-- `name: body.name ?? null` (routes/project-repositories.ts,
-- routes/projects.ts ×1 for `repo.additional`), so a blank name was reachable from
-- the API. The operator's instruction was to make a blank name impossible by
-- construction, on the ground that ⭐ a repository name can ALWAYS be resolved
-- from the repository url. Forward enforcement is therefore in two halves:
--
--   · APPLICATION — `src/lib/repository-name.ts :: resolveRepositoryName()` is
--     the single writer-side resolver: a caller-supplied name (trimmed) wins,
--     otherwise the url's `owner/repo` is derived, otherwise the request is
--     refused with a 400 naming the field. It never invents a placeholder,
--     because a made-up name is worse than a refusal — it looks like data.
--   · THIS FILE — the hard constraint. The helper can be forgotten by a fifth
--     insert path added later; `NOT NULL` + a named CHECK cannot be.
--
-- ⛔ THERE IS NO BACKFILL DML IN THIS FILE, AND THAT IS DELIBERATE — NOT AN
-- OVERSIGHT. Measured on the prod `fr` database (worker4, `postgres.example.com:5432`)
-- on 2026-09-25, BEFORE writing this migration:
--
--     repositories                     43 rows, 0 NULL name, 0 blank name
--     project_request_repositories      0 rows
--
-- The denominator is the point: 43 is the WHOLE table, not a sample, so there is
-- nothing for an UPDATE to touch. A future reader must not read the absence of a
-- backfill as a forgotten step and add one; if this ALTER fails on a NULL, that
-- means rows appeared AFTER 2026-09-25 through a path the helper does not cover,
-- and the correct response is to find that path, not to paper over it with an
-- UPDATE that mints names for rows nobody has looked at.
--
-- ⛔ `project_request_repositories.name` IS LEFT NULLABLE, ON PURPOSE. It holds
-- 0 rows and it is a supplementary human label on a row already keyed by its url
-- — not the row's identity, and not a column any reader treats as required.
-- Constraining it would be scope creep with no measured defect behind it.
--
-- Mirrored in the Drizzle schema: `src/db/schema.ts` `repositories.name` becomes
-- `.notNull()` and the CHECK is spelled there by name, so the generated TYPE does
-- not claim `string | null` for a column that can no longer be null (drizzle-kit
-- push is what bootstraps the CI database, so a schema that lies produces a CI
-- database this file then fails against).

-- 1. NOT NULL. Idempotent: re-running against an already-NOT NULL column is a
--    no-op rather than an error, so the file is safe to replay by hand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'repositories'
       AND column_name = 'name'
       AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE repositories ALTER COLUMN name SET NOT NULL;
  END IF;
END $$;

-- 2. Non-blank. NOT NULL alone still admits '' and '   ', which are the values a
--    form actually produces; `btrim(name) <> ''` is the half that makes "blank"
--    impossible rather than merely "absent". Named so schema.ts can spell the
--    same identifier (an unnamed CHECK gets an auto-generated name that
--    drizzle-kit push would not reproduce).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'repositories_name_not_blank'
       AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_name_not_blank CHECK (btrim(name) <> '');
  END IF;
END $$;
