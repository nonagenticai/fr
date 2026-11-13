-- backend/migrations/125_github_app_installations.sql
--
-- PUBLIC GITHUB APP INSTALLATIONS, BOUND TO AN fr TENANT.
--
-- Invariant (plan: public-github-app-usable.md): a GitHub token for a repo
-- OUTSIDE nonagenticai is issued only via the public App (`nonagenticai`,
-- id 5029921), only for an installation bound to the REQUESTING tenant here,
-- and only if GitHub confirms that installation covers the repo. coding-github
-- asks fr for the binding via GET /api/internal/github-app/binding.
--
-- A row is written only by GET /api/github-app/callback after (1) a signed,
-- single-use state names the fr user + tenant and (2) GitHub's
-- /user/installations, called with the INSTALLER's own token, lists the
-- installation. An installation already bound to another tenant is refused,
-- never rebound (the ON CONFLICT … WHERE in the route does that atomically).
--
-- One ACTIVE binding per installation: a PARTIAL unique index, so a revoked
-- row (revoked_at set by DELETE /api/github-app/installations/:id) stays as the
-- audit record and the installation can later be bound again.
--
-- tenant_id has no FK, like every other tenant_id column in fr (only the
-- workspace_id columns reference workspaces).
--
-- Idempotent: CI bootstraps with `drizzle-kit push` (which already creates the
-- table + both indexes from schema.ts under the SAME names) and then runs the
-- migrations, so every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS github_app_installations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  installation_id      bigint NOT NULL,
  account_login        text NOT NULL,
  account_type         text NOT NULL,
  installed_by_user_id uuid NOT NULL,
  github_user_login    text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_verified_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS github_app_installations_active_installation_idx
  ON github_app_installations (installation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS github_app_installations_tenant_login_idx
  ON github_app_installations (tenant_id, lower(account_login));

COMMENT ON TABLE github_app_installations IS
  'Public GitHub App (nonagenticai, 5029921) installations bound to an fr tenant. '
  'Written only by the signed-state install callback after GitHub confirms the installer '
  'can see the installation. One active (revoked_at IS NULL) row per installation_id. '
  'Read by coding-github through GET /api/internal/github-app/binding.';
