-- Migration: 209_provisioning_audit_resend_action
-- Date: 2026-10-24
--
-- fr#1634 (realm per app): the super_admin "resend set-password email" recovery action
-- (src/routes/admin/super-admin-resend.ts) is audited under its OWN action kind,
-- 'resend_set_password_email', rather than riding 'provision_user'. Widens 056's action CHECK.
--
-- ⛔ COMPARES THE DEFINITION, NOT THE NAME (the 113 / 119 / 203 / 207 rule): the DO block drops
-- the CHECK only when its definition lacks 'resend_set_password_email', then (re)adds it. A
-- push-built DB (drizzle declares no CHECK here) simply gains it.
--
-- RUNNER CONTRACT: pure DDL, no DML; the enum is mirrored in src/db/schema.ts. Idempotent — safe
-- under `reapplyIfProbeFails`. Widening a CHECK accepts every row the old one accepted, so the
-- re-add's validation scan cannot fail. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'provisioning_audit'
     AND c.conname = 'provisioning_audit_action_check';

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%''resend_set_password_email''%' THEN
    ALTER TABLE provisioning_audit
      DROP CONSTRAINT provisioning_audit_action_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE provisioning_audit
      ADD CONSTRAINT provisioning_audit_action_check
      CHECK (action IN ('provision_user', 'revoke_user', 'reissue_token', 'resend_set_password_email'));
  END IF;
END
$$;
