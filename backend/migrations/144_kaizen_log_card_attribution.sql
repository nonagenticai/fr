-- Migration: 144_kaizen_log_card_attribution
-- Date: 2026-09-30
--
-- ATTRIBUTE A KAIZEN ROW TO THE CARD ITSELF WHEN NO PROCEDURE RESOLVES
-- (n8n_custom_nodes#1925).
--
-- The n8n DONE step writes one kaizen_log row per finished card, attributed to
-- the card type's DONE procedure. When no procedure resolves it used to write
-- asset_kind='artifact' with the zero UUID — a row that joins to nothing and
-- reads as an artifact that does not exist. Ruling: such a row is attributed to
-- the CARD. A card is identified by `kaizen_card_id` ('kanban-<plankaCardId>',
-- text), not by a uuid, so a 'card' row carries NO asset_id.
--
-- ── 1. asset_kind gains 'card' ────────────────────────────────────────────
-- ⚠️ The runner applies EVERY pending file inside ONE outer transaction
-- (src/db/migration-runner.ts, `sql.begin` + per-file SAVEPOINT), so splitting
-- this into two files would NOT put a commit between the ADD VALUE and its use.
-- The CHECKs below therefore never cast the literal 'card' to the enum: they
-- compare `asset_kind::text`, which only reads existing (committed) values via
-- enum_out and is not an "unsafe use of new value". Runtime INSERTs of 'card'
-- happen in later transactions, after this one commits.
--
-- ⛔ 'card' is a kaizen_log attribution ONLY. It is NOT a stream member: the
-- same enum types asset_stream_membership.asset_kind, so section 3 forbids it
-- there, and every route that validates membership kinds excludes it
-- (STREAM_MEMBER_ASSET_KINDS in src/db/schema.ts).
--
-- Forward-only / idempotent: IF NOT EXISTS + pg_constraint guards.

ALTER TYPE asset_kind ADD VALUE IF NOT EXISTS 'card';

-- ---------------------------------------------------------------------------
-- 2. kaizen_log: asset_id nullable, but ONLY for a 'card' row
-- ---------------------------------------------------------------------------

ALTER TABLE kaizen_log ALTER COLUMN asset_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'kaizen_log_asset_id_required_unless_card'
       AND conrelid = 'kaizen_log'::regclass
  ) THEN
    ALTER TABLE kaizen_log
      ADD CONSTRAINT kaizen_log_asset_id_required_unless_card
      CHECK (asset_id IS NOT NULL OR asset_kind::text = 'card');
  END IF;

  -- kaizen_card_id is already NOT NULL; this names the dependency explicitly
  -- so a later relaxation of that column cannot silently leave a 'card' row
  -- identifying nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'kaizen_log_card_requires_card_id'
       AND conrelid = 'kaizen_log'::regclass
  ) THEN
    ALTER TABLE kaizen_log
      ADD CONSTRAINT kaizen_log_card_requires_card_id
      CHECK (asset_kind::text <> 'card' OR kaizen_card_id IS NOT NULL);
  END IF;
END$$;

COMMENT ON COLUMN kaizen_log.asset_id IS
  'The improved asset''s uuid. NULL only when asset_kind = ''card'' (no DONE '
  'procedure resolved; the row is attributed to the card named by '
  'kaizen_card_id). Authority: backend/migrations/144_kaizen_log_card_attribution.sql.';

-- ---------------------------------------------------------------------------
-- 3. asset_stream_membership: 'card' is never a stream member
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'asset_stream_membership_not_card'
       AND conrelid = 'asset_stream_membership'::regclass
  ) THEN
    ALTER TABLE asset_stream_membership
      ADD CONSTRAINT asset_stream_membership_not_card
      CHECK (asset_kind::text <> 'card');
  END IF;
END$$;
