-- 097 — carry the caller's tenant on the agent session.
--
-- Why this column has to exist rather than being derived at invoke time:
--
-- `/api/agui/invoke` authenticates with the agent access token alone. It has no
-- Keycloak token, so the only tenant source it had was
-- `getUserTenant(userId)` -> `user_roles.tenant_id`. Measured on prod
-- 2026-08-07: only 13 users in the whole system have a `user_roles` row, and
-- the canonical browser-test identity `fr-test` is not one of them. For every
-- other user `ctx.tenantId` was `undefined`, so every tenant-scoped AG-UI
-- action (`media.*`, `research.*`, `model_evaluator.*`) failed with
-- `internal_error` while the SPA worked fine — the SPA reads `tenant_id`
-- straight off the Keycloak JWT.
--
-- The tenant IS known at session-issue time (that request is Keycloak
-- authenticated, `validateAuth` returns `User.tenantId`). It cannot be
-- recovered at refresh time, because the refresh token is itself the
-- credential and no Keycloak bearer is required there — which is exactly why
-- it must be PERSISTED here instead of only embedded in the short-lived
-- access token.
--
-- Nullable on purpose: sessions issued before this migration have no tenant,
-- and the invoke path still falls back to `getUserTenant`. No backfill — a
-- wrong tenant is far worse than an absent one, and access tokens are
-- short-lived so live sessions re-mint with the claim on their next refresh.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

COMMENT ON COLUMN agent_sessions.tenant_id IS
  'Tenant resolved from the Keycloak token at session issue. Read back at refresh to mint the access token''s tenant_id claim, because refresh has no Keycloak context. NULL = pre-097 session; invoke falls back to user_roles.';
