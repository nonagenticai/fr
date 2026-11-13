-- Migration: 172_card_phase_lease_waiter
-- Date: 2026-10-09
-- Refs: nonagenticai/n8n_custom_nodes#2156 (lease_busy re-pick) — design
--       ~/.claude/plans/program/20-designs/NCN-2156-LEASE-BUSY-REPICK-DESIGN-2026-10-09.md §2-§4.
--
-- THE FIFO WAITER QUEUE behind a `card_phase_lease` key. A claim that is REFUSED
-- (`granted:false, reason:'held'`) and names a `waiter` enqueues that waiter here,
-- in the SAME statement as the refused claim decision (a CTE; see
-- src/routes/webhooks/card-phase-lease.ts). A `release` then PEEKS the oldest
-- waiter in a SECOND statement and returns it as `next_waiter` (opt-in:
-- `return_next_waiter: true`; never the releasing holder's own card), so the releasing
-- workflow can wake exactly one parked card — an EVENT, never a clock.
--
-- Rows leave ONLY by:
--   * the waiter's own GRANTED claim (it deletes its own row, same statement), or
--   * op `unwait` (the waker found the card stale: moved by a human, marker gone).
-- `release` never deletes: the row survives a failed wake, so the NEXT release
-- retries it (no silent drop).
--
-- `lease_key` holds the SAME value as `card_phase_lease.card_id` (the lease key,
-- e.g. `repo:<url>`); it is not a card id. `waiter_card_id` is the waiting card.
--
-- PK (tenant_id, lease_key, waiter_card_id) makes the enqueue idempotent:
-- `ON CONFLICT DO NOTHING` keeps the FIRST `enqueued_at`, so a card that bounces
-- twice does not lose its place in line. The FIFO read is
-- `ORDER BY enqueued_at, waiter_card_id` (the card id is a deterministic
-- tie-break for equal timestamps); the index serves it.
--
-- `board_id` (nullable) is the waiting card's board, as the claimant sent it
-- (`waiter_board_id`); `release` hands it back in `next_waiter` so the waker
-- need not look it up. It is caller-authored and NOT verified here — the waker
-- must re-read the card and check its board/tenant before moving it.
--
-- `tenant_id` is uuid, matching `card_phase_lease` after migration 103.
-- Raw-SQL only, NOT in src/db/schema.ts (the same choice as 100's
-- `card_phase_lease` and 138's `wip_slot`), so `drizzle-kit push` never creates
-- it; the COLUMN_PROBES entry in src/db/migration-runner.ts (tableExists) stops
-- the backfill stamping this file applied on a push-built database.
--
-- RUNNER CONTRACT: pure DDL, every statement IF NOT EXISTS (re-runnable). No
-- BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_phase_lease_waiter (
  tenant_id      UUID        NOT NULL,
  lease_key      TEXT        NOT NULL,
  waiter_card_id TEXT        NOT NULL,
  board_id       TEXT,
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, lease_key, waiter_card_id)
);

-- A database that applied an earlier draft of this unreleased file has the table
-- without `board_id`; this keeps the file re-runnable to the final shape.
ALTER TABLE card_phase_lease_waiter ADD COLUMN IF NOT EXISTS board_id TEXT;

CREATE INDEX IF NOT EXISTS card_phase_lease_waiter_fifo_idx
  ON card_phase_lease_waiter (tenant_id, lease_key, enqueued_at, waiter_card_id);
