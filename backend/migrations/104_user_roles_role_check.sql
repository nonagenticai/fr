-- backend/migrations/104_user_roles_role_check.sql
--
-- `user_roles.role` WAS AN UNCONSTRAINED text COLUMN.
--
-- No CHECK, no enum, no foreign key. Any string at all was a legal role, and
-- the only thing standing between a typo and a permanently-wrong grant was the
-- application code that happened to write it.
--
-- MEASURED ON PROD before this migration:
--
--   workspace-admin ....... 12
--   workspace-member ......  1
--   admin .................  1   <- not a role this product issues
--   ---------------------------
--   total ................. 14
--
-- That `admin` row is an AUTH_BYPASS seed artifact, and it is self-describing:
--
--   id          1079dffa-08dc-4169-931f-d043d06dadf7
--   user_id     00000000-0000-0000-0000-000000000000   (the nil UUID)
--   tenant_id   aa110000-0000-7aa1-8aa1-000000000001   ("AA Trilogy Demo")
--   role        admin
--   granted_at  2026-05-18T13:34:27.042342+00:00
--   granted_by  seed-demo-trilogy
--
-- It grants a role that does not exist to a user that does not exist. It was
-- also load-bearing in the worst way: `admin` is read as a LEGACY ALIAS for
-- workspace-admin (services/user-roles.ts), so this single seed row is why the
-- claim-only gates fixed alongside this migration looked plausible — there was
-- exactly one row in the entire table that made `role = 'admin'` seem real.
--
-- ORDER MATTERS. The delete must precede the constraint or the ADD CONSTRAINT
-- aborts on this very row and the migration fails halfway.
--
-- Deliberately NOT a postgres enum: adding a value to an enum is a schema
-- migration, and roles are product vocabulary that will grow. A CHECK is
-- alterable in one statement and reads identically in \d output.

-- ── 1. Remove the seed artifact ────────────────────────────────────────────
-- Scoped to the nil UUID, not to `role = 'admin'`: if a REAL user ever carried
-- the legacy alias, deleting it here would silently revoke a live grant. This
-- targets the row that cannot correspond to a person.
DELETE FROM user_roles
WHERE user_id = '00000000-0000-0000-0000-000000000000';

-- ── 2. Fail loudly if anything else is illegal ─────────────────────────────
-- Without this the ADD CONSTRAINT below would do the same job with a far worse
-- message. Naming the offending values is the difference between a two-minute
-- fix and an archaeology session.
DO $$
DECLARE
  bad_roles text;
BEGIN
  SELECT string_agg(DISTINCT role, ', ')
    INTO bad_roles
    FROM user_roles
   WHERE role NOT IN ('workspace-admin', 'workspace-member');

  IF bad_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'user_roles holds role value(s) outside the permitted set: %. '
      'Resolve these rows before adding the constraint — do NOT widen the '
      'constraint to accommodate them without deciding what they mean.',
      bad_roles;
  END IF;
END $$;

-- ── 3. Constrain the column ────────────────────────────────────────────────
-- Guarded so the migration is re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_roles'::regclass
       AND conname  = 'user_roles_role_check'
  ) THEN
    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_role_check
      CHECK (role IN ('workspace-admin', 'workspace-member'));
  END IF;
END $$;
