-- Migration: 186_approval_redelivery_backoff
-- Date: 2026-10-12
--
-- workers/approval-redelivery.ts selected `status='pending' AND notified_at IS
-- NULL ... ORDER BY created_at ASC LIMIT <cap>` with no attempt counter and no
-- backoff. A head-of-queue set of permanently unroutable / unconfirmable rows
-- therefore re-occupied the WHOLE batch on every tick, starving every younger
-- approval forever and re-fanning the same failing sends every tick.
--
-- Two columns on approvals:
--   * redelivery_attempts  — re-delivery passes that did NOT confirm delivery.
--   * next_redelivery_at   — the row is not eligible again before this instant
--                            (NULL = eligible now; never attempted).
-- The worker bumps both after each attempt (backoff min(15min * 2^attempts, 24h))
-- and skips a row once attempts reach its cap.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (so a
-- push-built database satisfies the probe). Idempotent (ADD COLUMN IF NOT
-- EXISTS) — safe under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps
-- each file in a SAVEPOINT. The NOT NULL DEFAULT 0 add is a metadata-only change
-- on PG 11+ (no table rewrite).

SET LOCAL lock_timeout = '10s';

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS redelivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_redelivery_at timestamptz NULL;
