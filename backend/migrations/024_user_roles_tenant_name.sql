-- 024_user_roles_tenant_name.sql
--
-- Adds tenant_name (TEXT NULL) for human-readable labels; tenant_id stays
-- UUID and is the join key. Forward-only / additive. The all-zero UUID is
-- reserved for the system/bootstrap tenant; production tenants will be
-- UUIDv7 (time-ordered) once the Keycloak realm session lands the claim
-- migration.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS tenant_name TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_name
  ON user_roles (tenant_name)
  WHERE tenant_name IS NOT NULL;
