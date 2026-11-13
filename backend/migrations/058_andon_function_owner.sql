-- Spec ref: 2026-05-05 super-admin follow-ups, T4 — make 053's
-- `default_engage_andon_on_streams()` ownership stable.
--
-- 053 issued a `CREATE OR REPLACE FUNCTION` against this trigger
-- function. CREATE OR REPLACE only works for the function's current
-- owner, so if a future migration (or a manual fix) tries to redefine
-- the trigger from a non-owning role, it errors out with
--     ERROR: must be owner of function default_engage_andon_on_streams
-- This migration normalises ownership to the role that runs migrations
-- (`fr_user` in production, equivalently the migration role in CI/dev),
-- so subsequent CREATE OR REPLACE invocations succeed regardless of
-- which environment created the function originally.
--
-- The DO block is a no-op when ownership already matches, which is
-- the steady-state condition in prod today (verified 2026-05-05:
-- `pg_get_userbyid(proowner) = 'fr_user'`).

BEGIN;

DO $$
DECLARE
    target_owner text := current_user;
    current_owner text;
BEGIN
    -- Skip silently if 053 hasn't been applied yet (function doesn't
    -- exist). The runner discovers migrations in numeric order so this
    -- branch shouldn't fire under normal operation.
    SELECT pg_get_userbyid(p.proowner)
      INTO current_owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'default_engage_andon_on_streams';

    IF current_owner IS NULL THEN
        RAISE NOTICE
          '054: default_engage_andon_on_streams() not present, skipping owner fix';
        RETURN;
    END IF;

    IF current_owner <> target_owner THEN
        EXECUTE format(
          'ALTER FUNCTION public.default_engage_andon_on_streams() OWNER TO %I',
          target_owner
        );
        RAISE NOTICE
          '054: re-owned default_engage_andon_on_streams() from % to %',
          current_owner, target_owner;
    END IF;
END $$;

COMMIT;
