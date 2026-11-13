-- 023_user_roles.sql
--
-- RBAC: tenant-scoped user role assignments. Replaces the tactical
-- `FR_ADMIN_USER_IDS` env-var allowlist that previously gated the admin
-- bridge in `routes/engagements/deliveries.ts`. See the marker
-- `TODO(post-user_roles)` (now removed in the same commit series).
--
-- Design notes
--   * `user_id` is TEXT, not UUID. Keycloak `sub` is a uuid in practice
--     today, but Keycloak does not contractually guarantee that across
--     federated identity providers. TEXT keeps us forward-compatible.
--   * `tenant_id` is UUID — every other tenanted table here uses uuid.
--   * `role` is free-form TEXT. Today we use 'admin' and 'auditor'; future
--     platform-level roles land here without a per-role migration.
--   * `granted_by` is the user id of the granter; 'system' for the env-var
--     bootstrap fallback (see services/user-roles.ts::bootstrapFromEnv).
--     Nullable so DB-level upserts that don't know the granter (e.g. tests
--     or the bootstrap path before a real admin exists) still work.
--   * Forward-only / additive: no DROP statements; safe to re-run via the
--     idempotent migration runner.

CREATE TABLE IF NOT EXISTS user_roles (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT        NOT NULL,
    tenant_id   UUID        NOT NULL,
    role        TEXT        NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by  TEXT        NULL
);

-- Upsert key — re-granting the same (user, tenant, role) is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_roles_user_tenant_role
    ON user_roles (user_id, tenant_id, role);

-- "List all admins for tenant X" query path used by the admin endpoint.
CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_role
    ON user_roles (tenant_id, role);
