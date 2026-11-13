-- backend/migrations/030_channels_registry.sql
-- Foundation Plan 2 — follow-up: channels registry table.
--
-- Adds the channels registry table (the channel-rows backfill itself
-- lives in migration 049, which seeds the asset_assignments edges) and
-- closes the
-- "backend-unavailable" banner on the FE admin /channels page.
--
-- Channels are workspace-scoped or department-scoped — never project-
-- scoped. The Spec 1 §6.5 invariant is already enforced for the
-- assignments edge in migration 028 via the
--   asset_type <> 'channel' OR scope_level IN ('workspace','department')
-- CHECK; the registry side mirrors it by tying each row to a
-- workspace_id (NOT NULL) plus an optional dept_id (NULL means
-- workspace-scoped).
--
-- `credentials_enc` is a write-only field — the route layer redacts it
-- on every GET response. Storage uses the AES-GCM envelope helper from
-- `services/encryption.ts` (Phase 4 cutover, 2026-05-01); legacy
-- plaintext rows still decrypt with a passthrough + WARN until the
-- `scripts/encrypt-channel-credentials.ts` backfill runs. The
-- channels-registry write paths call `encryptToEnvelope`; reads opt
-- in via `loadChannelCredentials`.
--
-- `(workspace_id, name)` is unique so the FE admin UI can use `name`
-- as a stable display key per workspace.
BEGIN;

CREATE TYPE channel_kind AS ENUM (
  'signal','teams','email','web','inapp','voice'
);

CREATE TABLE IF NOT EXISTS channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dept_id         uuid REFERENCES departments(id) ON DELETE CASCADE,
  kind            channel_kind NOT NULL,
  name            text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_enc text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS channels_workspace_idx
  ON channels (workspace_id, archived_at);

CREATE INDEX IF NOT EXISTS channels_dept_idx
  ON channels (dept_id) WHERE dept_id IS NOT NULL;

COMMIT;
