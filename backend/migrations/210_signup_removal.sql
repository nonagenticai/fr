-- Migration: 210_signup_removal
-- Date: 2026-10-25
--
-- Early-access OFFBOARDING: a super_admin can REMOVE an approved early-access workspace end to end
-- (services/signup/removal.ts, POST /api/signup-approvals/:id/remove with confirm = the workspace
-- slug; Retry POST …/removal/retry; close by hand POST …/removal/resolve). Before this, removing the
-- 2026-10-25 test tenants had to be done by hand: deprovision-user removed the person's own licences
-- and login, but the conveyor bundle licences, the licences tenant, the fr workspace and the admin
-- grant all stayed live, and the signup row stayed `approved`.
--
--   * signup_approvals.status gains 'removed' (the row was approved and a super_admin removed it).
--   * signup_approvals.removal — the removal's record: {state: pending|blocked|failed|done|
--     resolved_manually, steps: {<step>: {status, at, code?, error?, detail?}}, attempts, lease, …}.
--     NULL until a super_admin removes the row. The reserved `tenant_slug` is released (NULL) only
--     once the removal is `done` / `resolved_manually`.
--   * provisioning_audit.action gains 'remove_signup' (start / retry / resolve) and
--     'remove_signup_step' (one row per removal step attempt).
--
-- ⛔ COMPARES THE DEFINITION, NOT THE NAME (the 113 / 119 / 203 / 207 / 209 rule): each DO block
-- drops its CHECK only when the definition lacks the new value, then (re)adds it. A push-built DB
-- already carries the widened CHECKs (schema.ts) and the DO blocks leave them alone.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts. Idempotent — safe under
-- `reapplyIfProbeFails`. Widening a CHECK accepts every row the old one accepted, so the re-add's
-- validation scan cannot fail. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS removal jsonb NULL;

CREATE INDEX IF NOT EXISTS signup_approvals_removal_state_idx
  ON signup_approvals ((removal->>'state')) WHERE removal IS NOT NULL;

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'signup_approvals'
     AND c.conname = 'signup_approvals_status_check';

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%''removed''%' THEN
    ALTER TABLE signup_approvals DROP CONSTRAINT signup_approvals_status_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE signup_approvals
      ADD CONSTRAINT signup_approvals_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'removed'));
  END IF;
END
$$;

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

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%''remove_signup_step''%' THEN
    ALTER TABLE provisioning_audit DROP CONSTRAINT provisioning_audit_action_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE provisioning_audit
      ADD CONSTRAINT provisioning_audit_action_check
      CHECK (action IN ('provision_user', 'revoke_user', 'reissue_token', 'resend_set_password_email',
                        'remove_signup', 'remove_signup_step'));
  END IF;
END
$$;
