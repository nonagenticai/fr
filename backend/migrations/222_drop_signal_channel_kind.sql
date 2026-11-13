-- Migration: 222_drop_signal_channel_kind
-- Date: 2026-10-31
--
-- REMOVE Signal as a channel (George 2026-10-31: "we do not even use Signal because it
-- automatically logs out after a while… so just remove Signal completely from fr"). The
-- code, tests, config, frontend and served OpenAPI document are deleted in the same
-- change; this file is the schema half.
--
--   * `channel_kind` loses the 'signal' label. `channels.kind` is the only column typed
--     with it (migration 034); `user_channel_prefs.channel`, `engagement_deliveries.channel`
--     and `streams.notification_channels` are TEXT/JSONB with no constraint, so existing
--     historical rows there are left ALONE (no DML — see the runner contract below).
--
-- ⛔ FAILS CLOSED. Postgres cannot remove an enum label, so the type must be recreated.
-- That rewrite would abort on any surviving `kind = 'signal'` row; the first DO block
-- instead refuses the migration with a named count, so a real Signal channel row is never
-- silently lost. If it fires, decide what to do with those rows FIRST (archive the data,
-- or re-point the row with a deliberate, reviewed statement in the PR that does it) and
-- only then re-run. Do not add a DML rewrite here to make it pass.
--
-- IDEMPOTENT. The second DO block acts only when the live type still carries the 'signal'
-- label. A replay after a successful run is a no-op, and a `drizzle-kit push`-built CI
-- database — which already has the new five-label type from src/db/schema.ts — passes
-- straight through. A `channel_kind_old` left behind by an interrupted earlier attempt is
-- dropped first, so the rename cannot collide with itself.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts. No BEGIN/COMMIT (the
-- runner wraps each file in a SAVEPOINT inside an outer transaction). `lock_timeout` keeps
-- the type rewrite from queueing behind a long transaction indefinitely.

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  signal_rows bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'channel_kind'
  ) THEN
    SELECT count(*) INTO signal_rows FROM channels WHERE kind::text = 'signal';
    IF signal_rows > 0 THEN
      RAISE EXCEPTION
        'migration 222: % channels row(s) still have kind = ''signal''. The type rewrite would fail; refusing to drop real Signal registry rows. Resolve those rows in a reviewed change before applying this migration.',
        signal_rows;
    END IF;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typname = 'channel_kind'
       AND e.enumlabel = 'signal'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = 'channel_kind_old'
    ) THEN
      DROP TYPE channel_kind_old;
    END IF;

    ALTER TYPE channel_kind RENAME TO channel_kind_old;
    CREATE TYPE channel_kind AS ENUM ('teams', 'email', 'web', 'inapp', 'voice');
    ALTER TABLE channels ALTER COLUMN kind TYPE channel_kind USING kind::text::channel_kind;
    DROP TYPE channel_kind_old;
  END IF;
END
$$;
