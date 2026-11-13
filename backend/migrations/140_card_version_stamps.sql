-- Migration: 140_card_version_stamps
-- Date: 2026-09-29
--
-- THE FULL VERSION STAMP OF A CARD, KEYED BY PLANKA CARD ID (C1-46).
--
-- Written ONLY by POST /api/cards/project (src/routes/cards/project.ts) when the
-- caller passes `version_stamp` on a create that actually mints a NEW card; read
-- by GET /api/cards/:id (src/routes/cards/get.ts), which returns `stamp` as
-- `version_stamp`. The card itself carries only a small pointer in
-- `Metadata.version_stamp` — `{"store":"fr","sha256":"<hex>"}` — whose sha256 is
-- `stamp_sha256` here. The stamp lives in fr, not in a Planka custom field,
-- because a Planka field is a bounded text cell and the stamp is not.
--
-- ── NEVER ON A DEDUPE ─────────────────────────────────────────────────────
-- A dedupe hit (an OPEN card already carries the asset_id), a lease loser
-- (create_in_progress, card_id null) and a suppressed fingerprint all return
-- BEFORE the create, so none of them writes a row. The row is inserted after
-- the Planka create, inside the route's create-rollback try; a rolled-back
-- create deletes it again (same catch that deletes the card).
--
-- ── COLUMN CHOICES ────────────────────────────────────────────────────────
-- * `card_id` TEXT PRIMARY KEY — Planka ids are 19-digit snowflakes, not uuids.
--   One stamp per card; the insert is ON CONFLICT (card_id) DO NOTHING, so the
--   first stamp for a card wins and is never rewritten. The CHECK refuses an
--   empty id, so a create path that somehow reached the insert without a real
--   card id fails loudly instead of parking a row under ''.
-- * `project_id` uuid REFERENCES projects ON DELETE CASCADE — the route only
--   inserts for a project it has just resolved, and a deleted project's board
--   (and therefore its cards) is gone with it. Same FK shape as migration 130.
-- * `stamp_sha256` — lowercase hex sha256 of the canonical JSON of `stamp`
--   (object keys sorted recursively). The CHECK pins the shape the pointer
--   carries.
--
-- Pure DDL, additive, idempotent on re-run (every statement IF NOT EXISTS). No
-- DML, so scripts/check-migration-dml-probed.ts needs nothing. Deliberately NOT
-- in src/db/schema.ts (the same choice as 138's `wip_slot` and 100's
-- `card_phase_lease`): CI's `drizzle-kit push` does not create it, the
-- COLUMN_PROBES row `tableExists('card_version_stamps')` keeps this file PENDING
-- on a push-built database, and the runner creates the table from THIS file —
-- one emitter, so CI and prod cannot diverge.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_version_stamps (
  card_id      text        NOT NULL PRIMARY KEY,
  project_id   uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stamp        jsonb       NOT NULL,
  stamp_sha256 text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_version_stamps_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_version_stamps_sha256_hex CHECK (stamp_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS card_version_stamps_project_idx
  ON card_version_stamps (project_id);

COMMENT ON TABLE card_version_stamps IS
  'Full version stamp per Planka card, written by POST /api/cards/project on a NEW card only '
  '(never on a dedupe). The card carries Metadata.version_stamp = {"store":"fr","sha256":…}, '
  'where sha256 = stamp_sha256 (sha256 of the canonical JSON of stamp). Read by GET /api/cards/:id.';
