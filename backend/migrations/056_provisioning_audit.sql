-- Migration: 052_provisioning_audit — super-admin user provisioning audit trail
-- Date: 2026-05-04
-- Spec ref: ~/.claude/plans/confirmed-spec-2-spicy-breeze.md (Task 1)
--
-- Records every super-admin provisioning action (Keycloak user create + license
-- mint + budget set) with status. Idempotent — safe to re-apply.

CREATE TABLE IF NOT EXISTS provisioning_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('provision_user','revoke_user','reissue_token')),
  target_email text NOT NULL,
  target_user_id text,
  tenant_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending','success','partial','error')) DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provisioning_audit_target_idx ON provisioning_audit (target_email);
CREATE INDEX IF NOT EXISTS provisioning_audit_tenant_idx ON provisioning_audit (tenant_id);
CREATE INDEX IF NOT EXISTS provisioning_audit_actor_idx ON provisioning_audit (actor_user_id, created_at DESC);
