-- Migration: 174_planka_user_api_keys
-- Date: 2026-10-10
--
-- fr acts in Planka AS each user through a per-user Planka API key
-- (`X-Api-Key`, stock Planka >= 2.0), minted by fr's admin agent via
-- `POST /api/users/:id/api-key`. This replaces the Keycloak bearer exchange
-- (`/api/access-tokens/exchange-with-bearer`), which exists only in our
-- planka-private fork and needs Planka to trust OUR Keycloak — so it could
-- never work against a customer's own (BYO) Planka.
--
-- One row per (Planka instance, fr user). Keyed on the instance base URL so
-- re-pointing fr at another Planka mints fresh keys instead of sending one
-- instance's key to another. `api_key_envelope` is the
-- EncryptionService envelope (SECRET_ENCRYPTION_KEY); the key is never stored
-- in plaintext. Planka returns a key exactly once, so a lost row is cured by
-- re-minting (which overwrites the user's previous key in Planka).
--
-- Raw SQL only (not in db/schema.ts), so it is probed in migration-runner.ts.
-- Pure idempotent DDL.

CREATE TABLE IF NOT EXISTS planka_user_api_keys (
  planka_base_url  TEXT        NOT NULL,
  fr_user_id       TEXT        NOT NULL,
  planka_user_id   TEXT        NOT NULL,
  api_key_envelope TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (planka_base_url, fr_user_id)
);
