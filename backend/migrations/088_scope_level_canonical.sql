-- Canonicalise projects.scope_level.
--
-- POST /api/projects took `scope_level: z.string().optional()`, so three
-- incompatible vocabularies reached the column while the CONSUMER
-- (POST /api/cards/improvement) hard-validates a code-granularity enum. Result:
-- every approval card the AA intake orchestrator minted came back
-- `400 validation_failed` and the workflow reported success anyway.
--
-- Measured on prod before this migration (2026-07-14):
--   single_repo  208   <- AA drive scripts        (invalid -> card mint 400s)
--   <null>        55   <- n8n falls back to 'module' (worked by accident)
--   small          6   <- fr UI t-shirt select    (invalid -> card mint 400s)
--   repo           5   <- smoke scripts           (valid)
--   module         1   <- smoke scripts           (valid)
--
-- i.e. 214/275 projects (~78%) could never mint an approval card.
--
-- The door is now validated (types/scope-level.ts ScopeLevelSchema), so no new
-- row can carry a phantom value. This backfills the historical ones onto the
-- canonical vocabulary using LEGACY_SCOPE_LEVEL_ALIASES. 'single_repo' -> 'repo'
-- is an exact synonym; the t-shirt sizes have no true granularity meaning, so
-- they are mapped to their closest reading and are documented as lossy.

UPDATE projects SET scope_level = 'repo'       WHERE scope_level = 'single_repo';
UPDATE projects SET scope_level = 'module'     WHERE scope_level = 'small';
UPDATE projects SET scope_level = 'app'        WHERE scope_level = 'medium';
UPDATE projects SET scope_level = 'repo'       WHERE scope_level = 'large';
UPDATE projects SET scope_level = 'multi_repo' WHERE scope_level = 'enterprise';

-- Anything else non-null and off-vocabulary is a value we have never seen; null it
-- rather than guess. NULL is safe: the n8n approval-item builder defaults to 'module'.
UPDATE projects
   SET scope_level = NULL
 WHERE scope_level IS NOT NULL
   AND scope_level NOT IN (
     'multi_repo','repo','app','module','component','file','class','function'
   );

-- Enforce it in the schema so the column can never drift again, even if a future
-- code path bypasses the zod door.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_scope_level_canonical;
ALTER TABLE projects ADD CONSTRAINT projects_scope_level_canonical
  CHECK (
    scope_level IS NULL OR scope_level IN (
      'multi_repo','repo','app','module','component','file','class','function'
    )
  );
