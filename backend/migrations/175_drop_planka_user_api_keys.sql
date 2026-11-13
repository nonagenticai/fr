-- Migration: 175_drop_planka_user_api_keys
-- Date: 2026-10-10
--
-- Drops the per-user Planka API key store created by 174. George, 2026-10-10:
-- "Planka use will be per tenant, not per user" — one fr deployment acts in its
-- (bring-your-own) Planka as ONE configured account (PLANKA_BASE_URL +
-- PLANKA_AGENT_EMAIL/PASSWORD). fr users are no longer Planka users, so fr
-- neither mints nor stores per-user keys.
--
-- Measured 2026-10-10: 0 rows in prod fr and in kag_frontend — nothing is lost.
--
-- Probed in migration-runner.ts (asserts ABSENCE; 174's presence probe was
-- removed with it). Pure idempotent DDL.

DROP TABLE IF EXISTS planka_user_api_keys;
