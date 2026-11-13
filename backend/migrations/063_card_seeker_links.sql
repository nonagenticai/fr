-- Migration: 063_card_seeker_links — Plan 6 Wave D
-- Date: 2026-05-18
-- Plan ref: ~/.claude/plans/plan-is-at-floating-patterson.md (Wave D)
--
-- Per-card store for KAG entity links discovered by the Seeker activity
-- (AA_IMPLEMENTATION/ACTIVITY_PATTERNS.md §3.1) during READYING. n8n's
-- ready-prefetch.json runs the Gaps worker against the card context; the
-- new ActionWriteSeekerLinks step POSTs the resulting entity-list to
-- POST /api/cards/:id/seeker-links so the fr `/cards/[id]` page can show
-- the Seeker half of the compounding-memory loop (verification #5 in the
-- plan; Compression already populated via kaizen_log).
--
-- Idempotency: UNIQUE (card_id, kag_entity_id) lets the n8n step re-emit
-- safely on a retry — ON CONFLICT DO UPDATE refreshes the score and
-- created_at.
--
-- All DDL is idempotent (IF NOT EXISTS). Pre-prod, forward-only.

BEGIN;

CREATE TABLE IF NOT EXISTS card_seeker_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id       text NOT NULL,
  kag_entity_id uuid NOT NULL,
  score         real,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_seeker_links_unique UNIQUE (card_id, kag_entity_id)
);

CREATE INDEX IF NOT EXISTS card_seeker_links_card_id_idx
  ON card_seeker_links (card_id);

COMMIT;
